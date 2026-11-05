# 飞书完成卡快照保留清理设计

## 背景

`feishu_card_snapshot` 保存飞书完成卡的终态快照：一行对应一张 `COMPLETED` 卡片，记录该卡对应的 ASSISTANT 消息、轮次、耗时与正文。它有两个用途：

- 点踩回调按被点卡片的 `open_message_id` 找到正确消息，避免反馈落到会话最新回复。
- 进程重启或点击旧完成卡时，按快照重建卡片内容与终态展示。

当前快照只增不减。虽然增长量低于消息流水，但长期运行后仍会持续占用存储和索引，需要纳入统一保留治理。

## 目标

- 每小时清理一次超过 180 天的完成卡快照。
- 单批最多删除 5000 条，单轮最多 20 批，避免长事务和大范围锁。
- 清理幂等，多实例重复执行安全；异常只记录日志，不阻断进程。
- 快照缺失时禁止把带卡片身份的点踩退回会话最新回复，避免反馈错位。
- 新增 `(updated_at, id)` 索引，支撑 `WHERE updated_at < ? ORDER BY updated_at, id LIMIT n`。

## 非目标

- 不清理 180 天内的快照，也不按用户、机器人或会话单独配置保留期。
- 不删除 `feishu_progress_card`（活跃进度映射）、`feishu_p2p_message`（私聊消息映射）或会话历史消息。
- 不归档已删除快照；超过保留期后不能从数据库恢复。
- 不改变桌面 / Web / 安卓端的反馈链路。

## 保留期与时间口径

- **180 天**：与审计日志、LLM 调用流水、会话活动、私聊消息映射等长期治理数据一致，覆盖绝大多数历史卡片翻看与点踩场景。
- **按 `updated_at` 清理**：唯一键在 `card_message_id`，同一张卡重试完成后会覆盖旧快照。保留期应从最后一次终态写入重新计算，而不是首次创建时间；否则刚重试过的旧卡可能因 `created_at` 过早被立即删除。
- upsert 显式写入并刷新 `updated_at = CURRENT_TIMESTAMP`，不依赖列默认值或 `ON UPDATE` 隐式行为，保证清理口径可验证。
- **每小时执行**：与现有清理 Job 一致；单轮未完成时跳过后续触发。

## 索引

现有唯一键 `(card_message_id)` 与 `(session_id)` 都无法服务按时间跨卡清理。V187 增加：

- `feishu_card_snapshot (updated_at, id)`

索引列顺序与删除语句的过滤、排序一致，便于 InnoDB 按索引顺序取批并限制删除行数。

## 实现

- `FeishuCardSnapshotCleanup` 使用 `setInterval` 每小时触发，`stopped` 控制生命周期，`cleaning` 防止同一进程内重复扫描。
- `MysqlFeishuCardSnapshotRepository.deleteBatch(cutoff, limit)` 执行 `DELETE ... WHERE updated_at < ? ORDER BY updated_at, id LIMIT n`，并将 `limit` 钳制到 `1..5000`。
- cutoff 通过 `formatDateTime` 生成，与数据库时间字段格式一致。
- 单批异常被捕获并记录日志，返回本轮已成功删除的数量；下一小时继续执行。
- 调度器装配到 `assembleLifecycle`，关闭流程显式调用 `stop()`。

## 点踩归属安全边界

历史实现中，带卡片身份但快照查询为空时，`messageId` 会退化为 `undefined`，随后反馈服务按“会话最新 ASSISTANT 消息”兜底。该行为在快照被清理后会静默把旧卡反馈记到新任务上，属于错误归属。

本设计明确：

- `cardMessageId != null` 且快照存在：使用快照中的 `messageId`。
- `cardMessageId != null` 但快照缺失或查询失败：记录 warn 并返回 `null`，前端提示「未找到可反馈的任务结果」，不写反馈。
- `cardMessageId == null`：仅用于改造前事件确实没有卡片身份的场景，保留会话级兜底。

因此快照超期只会降低旧卡重绘与反馈可用性，不会产生跨任务错误归属。

## 并发与边界

- 多实例同时运行可能并发删除同一批行；条件相同且删除幂等，不引入跨实例租约。
- 单轮达到 20 批上限时，剩余记录留到下一小时继续清理。
- 清理与终态写入并发时，新写入或刚覆盖的行 `updated_at` 晚于 cutoff，不会被误删。
- 删除只影响超期旧卡的点踩归属与重绘，不影响会话历史、最新任务执行或反馈汇总中的存量记录。
- 超期卡片仍可在飞书客户端显示原有内容，但服务端无法再按快照完整重绘或确认反馈归属。

## 测试

- repository：upsert 显式刷新 `updated_at`；`deleteBatch` 使用 `updated_at` 条件、稳定排序、正确返回 `affectedRows`，并钳制非法/超限 limit。
- cleanup：180 天 cutoff、分批、20 批上限、start 幂等 / stop、并发跳过、异常日志与已删除数量返回。
- 回归：带卡片身份且快照不存在时返回 `null`，不调用会话级反馈写入；无卡片身份时仍保留既有兜底。
