# 任务执行历史保留清理设计

## 背景

`agent_task_execution` 与 `agent_task_trigger` 随 Session 长期复用持续增长。每次重跑都会新增一条执行尝试和一条 Trigger，但当前没有清理策略，最终会拖慢任务详情查询并持续占用存储。投递流水、调用流水与 Signal 轮询记录均已采用 90 天保留口径，本设计与之对齐。

## 目标

- 每小时清理一次超过 90 天的终态执行尝试。
- 每个 Task 至少保留最近 200 次尝试，覆盖执行记录页最近 50 次的查询能力。
- 同步删除 `source_event_id` 等于被删执行 `execution_id` 的 Trigger，避免留下孤儿入口记录。
- 单批最多删除 500 条，单轮最多 20 批，避免长事务和大范围锁。
- 清理幂等，多实例重复执行安全；异常只记录日志，不阻断进程。

## 非目标

- 不清理 `WORKING` / `BLOCKED` 执行，避免影响正在执行或等待提问/审批的任务。
- 不删除 `agent_task` 本身，也不修改 Task 当前阶段、最新执行 ID 或 Session。
- 不归档已删除的执行内容，不提供按用户或任务单独配置的保留期。
- 不新增数据库迁移；现有 `idx_agent_task_execution_task_created` 与 Trigger 唯一键足够。

## 实现

- `TaskRepository.deleteStaleExecutions(cutoff, keepPerTask, limit)` 在事务内先选出候选执行，再按 `source_event_id` 删除 Trigger，最后删除执行记录。
- 候选条件为 `status IN ('COMPLETED', 'FAILED', 'CANCELLED') AND created_at < cutoff`，并要求 `attempt_no <= MAX(attempt_no) - keepPerTask`，即只删除落在每任务最近 N 次之外的旧尝试。
- `ORDER BY id ASC LIMIT ?` 限制单批规模，返回实际删除的执行数。
- `TaskExecutionRetentionService` 使用 `setInterval` 每小时触发，`stopped` 控制生命周期，`cleaning` 防止同一进程内重复扫描。
- cutoff 通过 `formatDateTime` 生成，与数据库时间字段格式一致。
- 调度器装配到 `assembleLifecycle`，关闭流程显式调用 `stop()`。

## 边界

- 单轮达到 20 批上限时剩余历史留到下一小时继续清理，不延长单轮执行时间。
- 多实例同时运行时可能并发删除，但条件相同且只删终态行，结果幂等；不引入跨实例租约。
- 90 天内的执行不会被清理，即使超过 200 次；每任务 200 次是旧记录的保留下限，不是硬上限。
- Task 详情接口仍只返回最近 50 次执行和入口记录，被清理的历史不会出现在响应中。
- 仅收到终态、没有开始记录的补建执行同样适用保留策略。
