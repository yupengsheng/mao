# IM 入站幂等记录保留清理设计

## 背景

飞书与钉钉机器人收到每条入站消息时，会分别在 `feishu_inbound_event`、`dingtalk_inbound_event` 写入一行去重记录（`CLAIMED` / `DONE` / `FAILED`）。这两张表只用于短时间内的重复投递判定，此前没有清理策略，会随消息量无限增长。

## 目标

- 每小时清理超过 30 天的飞书 / 钉钉入站幂等记录。
- 单表单批最多删除 5000 条，单轮最多 20 批，避免长事务和大范围锁。
- 清理幂等，多实例重复执行安全；单表异常只记录日志，不阻断另一张表。
- 为两张表补 `created_at` 索引，避免每小时清理退化为全表扫描。

## 非目标

- 不清理群消息日志、会话映射、成员名单或排队记录。
- 不改变入站认领、失败重试与终态写回逻辑。
- 不提供按机器人或消息类型区分的保留期。
- 不引入跨实例租约；多实例只保证删除条件与结果幂等。

## 实现

- `MysqlFeishuMessageRepository.deleteInboundBatch(cutoff, limit)` 与 `MysqlDingtalkMessageRepository.deleteInboundBatch(cutoff, limit)` 执行 `DELETE FROM <table> WHERE created_at < ? ORDER BY id LIMIT <safeLimit>`，返回 `affectedRows`；`LIMIT` 钳制在 1~5000。
- `InboundEventCleanup` 使用 `setInterval` 每小时触发，按 store 顺序逐表清理；`stopped` 控制生命周期，`cleaning` 防止同一进程内重复扫描。
- cutoff 通过 `formatDateTime` 生成，与数据库 `DATETIME` 的上海时区格式一致。
- 调度器装配到 `assembleLifecycle`，关闭流程显式调用 `stop()`。
- V181 为 `feishu_inbound_event`、`dingtalk_inbound_event` 增加 `created_at` 索引，在线 DDL（`ALGORITHM=INPLACE, LOCK=NONE`）。

## 边界

- 30 天已远超飞书 / 钉钉的事件重投窗口；超期记录被删除后，平台若再次投递同一条老消息，不再保证去重。
- 单轮达到 20 批上限时，剩余过期记录留到下一小时继续清理。
- 多实例同时运行时可能并发删除同一批记录，但条件相同且删除的是同一保留期外的历史行，结果幂等。
- 清理只影响幂等记录本身，不删除已创建的会话、任务或群消息日志。
