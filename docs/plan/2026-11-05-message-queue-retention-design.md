# 消息队列终态记录保留清理设计

## 背景

`message_queue` 保存会话忙时排队的用户消息（正文、图片、排序、来源绑定）。队列消费或用户移除时，行被标记为 `status = 'DELETED'`，而不是物理删除。业务读取只关心 `status = 'PENDING'`：出队、排序、列表、开放调用超时收敛都只查待执行行。

终态行此前一直保留。`content` 为 `TEXT`、`images` 为 `TEXT`，长期运行的实例会随每条排队消息持续增长，而这些行只对短期排障有价值。

## 目标

- 每小时清理一次超过 30 天的终态队列行（`status = 'DELETED'`）。
- 单批最多删除 5000 条，单轮最多 20 批，避免长事务和大范围锁。
- `PENDING` 行永不清理，避免误删尚未消费的用户消息。
- 清理幂等，多实例重复执行安全；异常只记录日志，不阻断进程。
- 新增 `(status, updated_at, id)` 索引支撑清理扫描。

## 非目标

- 不删除 `PENDING` 行，不改变入队、出队、排序、清空队列逻辑。
- 不清理 `message` 表中的消息本体；队列行与消息记录生命周期独立。
- 不按会话、用户或来源（普通 / 定时 / Webhook / API）拆分保留期。
- 不归档过期队列行，超过保留期后不能从数据库恢复。

## 保留期与时间口径

- **30 天**：队列行只用于短期排障；用户消息正文已在 `message` 表长期保存，30 天足够排查消费异常。
- **按 `updated_at` 清理**：出队 / 删除会更新 `updated_at`，从最后一次状态变更开始计时。
- **每小时执行**：与现有清理 Job 一致；单轮未完成时跳过后续触发。

## 索引

V190 新增：

- `message_queue (status, updated_at, id)`

现有 `idx_session_status(session_id, status)` 只适合按会话读取待执行行，无法服务中心化时间清理。新索引前缀匹配 `status = 'DELETED'`，后缀支撑按 `updated_at` 排序与分批删除。

## 实现

- `MessageQueueRepository.deleteTerminalBatch(cutoff, limit)` 执行 `DELETE FROM message_queue WHERE status = 'DELETED' AND updated_at < ? ORDER BY updated_at, id LIMIT n`，返回 `affectedRows`。
- `limit` 钳制到 `1..5000`，非法值回落 1，不把外部输入拼进 SQL。
- `MessageQueueCleanup` 使用 `setInterval` 每小时触发，`stopped` 控制生命周期，`cleaning` 防止同一进程内并发扫描。
- cutoff 通过 `formatDateTime` 生成，与数据库 `DATETIME` 格式一致。
- 单批异常被捕获并记录日志，返回本轮已成功删除的数量；下一小时继续执行。
- 清理器装配到 `assembleLifecycle`，关闭流程显式调用 `stop()`。

## 边界

- 终态行删除后，管理后台 / 排障不再能回查该次排队内容；消息本体仍在会话消息中。
- 开放调用超时收敛只检查 `PENDING` 行，删除终态行不会改变 `pending` / `queued` 流水的收敛结果。
- 定时任务 / Webhook / API 来源的队列行同样只保留 30 天；来源回写只发生在消费时，不影响已终态记录。
- 单轮达到 20 批上限时，剩余记录留到下一小时继续清理。
- 多实例同时运行可能并发删除同一批行；条件相同且删除幂等，不引入跨实例租约。

## 测试

- repository：只删除 `DELETED` 行、`updated_at` 截止条件、稳定排序、正确返回 `affectedRows`，并钳制 0、`NaN`、`Infinity` 与超限值。
- cleanup：30 天 cutoff、分批、20 批上限、start 幂等 / stop、并发跳过、异常日志与已删除数量返回。
