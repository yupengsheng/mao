# IM 入站幂等记录保留清理设计

## 背景

飞书、钉钉与微信机器人收到每条入站消息时，会分别在 `feishu_inbound_event`、`dingtalk_inbound_event`、`weixin_inbound_message` 写入一行去重记录（`CLAIMED` / `DONE` / `FAILED`）。这些表只用于短时间内的重复投递判定，此前没有清理策略，会随消息量无限增长。

## 目标

- 每小时清理超过 30 天的飞书 / 钉钉 / 微信入站幂等记录。
- 单表单批最多删除 5000 条，单轮最多 20 批，避免长事务和大范围锁。
- 清理幂等，多实例重复执行安全；单表异常只记录日志，不阻断另一张表。
- 为飞书 / 钉钉两张表补 `created_at` 索引，避免每小时清理退化为全表扫描；微信复用已有 `(status, updated_at)` 索引。

## 非目标

- 不清理群消息日志、会话映射、成员名单或排队记录。
- 不改变入站认领、失败重试与终态写回逻辑。
- 不提供按机器人或消息类型区分的保留期。
- 不引入跨实例租约；多实例只保证删除条件与结果幂等。

## 实现

- `MysqlFeishuMessageRepository.deleteInboundBatch(cutoff, limit)` 与 `MysqlDingtalkMessageRepository.deleteInboundBatch(cutoff, limit)` 执行 `DELETE FROM <table> WHERE created_at < ? ORDER BY id LIMIT <safeLimit>`，返回 `affectedRows`；`LIMIT` 钳制在 1~5000。
- `WeixinInboundMessageRepository.deleteTerminalBatch(cutoff, limit)` 只删除 `status IN ('DONE', 'FAILED') AND updated_at < ?` 的记录，按 `updated_at, id` 排序后分批删除；`CLAIMED` 不进入删除条件，避免删除处理中断后仍待重放的消息。`DONE` 的 24 小时去重窗口与超时 `CLAIMED` 的 10 分钟重放窗口都远短于 30 天保留期。
- `InboundEventCleanup` 使用 `setInterval` 每小时触发，按 store 顺序逐表清理；`stopped` 控制生命周期，`cleaning` 防止同一进程内重复扫描。
- cutoff 通过 `formatDateTime` 生成，与数据库 `DATETIME` 的上海时区格式一致。
- 调度器装配到 `assembleLifecycle`，关闭流程显式调用 `stop()`。
- V181 为 `feishu_inbound_event`、`dingtalk_inbound_event` 增加 `created_at` 索引，在线 DDL（`ALGORITHM=INPLACE, LOCK=NONE`）。

## 边界

- 30 天已远超飞书 / 钉钉的事件重投窗口和微信的 24 小时内容去重窗口；超期记录被删除后，平台若再次投递同一条老消息，不再保证去重。
- 微信 `CLAIMED` 记录即使超过 30 天也不会清理；这些记录仍可由无心跳超时重放机制接管。`findLatestInboundAt()` 依赖最近一条入站记录，账号超过 30 天无入站时 24 小时主动发送窗口本已关闭，删除终态历史记录不会改变窗口判断。
- 清理与用户合法重发同内容可能并发：`reclaimForResend` 使用 upsert，若超期 `DONE` 行刚被清理删除，重发会重新写入 `CLAIMED` 行，后续服务端重投仍受幂等保护。
- 单轮达到 20 批上限时，剩余过期记录留到下一小时继续清理。
- 多实例同时运行时可能并发删除同一批记录，但条件相同且删除的是同一保留期外的历史行，结果幂等。
- 清理只影响幂等记录本身，不删除已创建的会话、任务或群消息日志。
