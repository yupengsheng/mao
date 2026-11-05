# 子代理执行记录保留清理设计

## 背景

`subagent_execution` 每次 `delegate` / 后台子代理调用写入一条，记录父会话、子会话、任务描述、执行状态、token 消耗与最终结果。它是 `/v1/sessions/:id/subagents` 的元数据来源，也是后台子代理进度查询、取消、重试与 `check_subagent` 的依据。

该表此前只增不减。长期运行的实例上，重复委派会持续积累已结束的执行记录；`result` 为 `MEDIUMTEXT`，是会话域中增长较快的明细数据之一。

## 目标

- 每小时清理一次超过 180 天的终态执行记录，按 `updated_at` 计时。
- 单批最多删除 5000 条，单轮最多 20 批，避免长事务和大范围锁。
- 只清理结果已收口的记录；正在执行、待恢复、待投递的记录永不删除。
- 子会话仍存在时，每个 `child_session_id` 至少保留 `id` 最大的一条记录。
- 清理幂等，多实例重复执行安全；异常只记录日志，不阻断进程。
- 新增 `(status, delivery_status, updated_at, id)` 索引支撑清理扫描。

## 非目标

- 不删除会话、消息、父会话任务记录或 `llm_call` 流水。
- 不按父会话、用户、Agent 或调用类型拆分保留期。
- 不归档过期记录，超过保留期后不能从数据库恢复。
- 不改变 `/subagents` 接口返回结构、后台子代理查询 / 取消 / 重试逻辑。

## 保留期与时间口径

- **180 天**：与审计日志、LLM 调用流水、会话活动、压缩事件等长期治理数据一致。
- **按 `updated_at` 清理**：执行结束、结果投递、重试复用同一行都会更新该字段，重试后重新计时，避免刚重试的历史记录立即被清理。
- **每小时执行**：与现有清理 Job 一致；单轮未完成时跳过后续触发。

## 清理条件

一条记录同时满足以下条件才进入候选：

1. `status IN ('COMPLETED', 'FAILED', 'CANCELLED')`；
2. `delivery_status IN ('DELIVERED', 'SUPPRESSED', 'LEGACY')`；
3. `updated_at < cutoff`；
4. 子会话不存在或已逻辑删除（`session.deleted = 1`），或该记录不是该 `child_session_id` 下 `id` 最大的记录。

`RUNNING` / `RECOVERING` 与 `delivery_status = 'PENDING'` 永不清理。崩溃恢复只处理这两类状态且要求 `PENDING`，因此不会误删待恢复记录；父结果投递服务也可能在终态后再次读取记录，`PENDING` 保留可避免投递链路断档。

对仍存在的子会话保留最新一条，确保 `/subagents` 的 `agentType`、`taskDescription`、阶段兜底，以及后台子代理进度与重试入口不会因清理丢失。归档会话实体仍然存在，也保留最新一条；仅逻辑删除或实体不存在时才允许全部清理。

## 索引

V189 新增：

- `subagent_execution (status, delivery_status, updated_at, id)`

索引前缀匹配清理的终态与投递状态过滤，后缀支撑按 `updated_at` 排序与分批删除。`child_session_id` 已有 `idx_sae_child`，最新记录判定走索引查找。

## 实现

- `SubagentExecutionRepository.deleteBatch(cutoff, limit)` 先通过派生表选出候选 ID（`ORDER BY updated_at, id LIMIT n`），再按 ID 删除；MySQL 多表 / 带 JOIN 的 DELETE 不支持外层 `ORDER BY ... LIMIT`，派生表可规避该限制。
- `limit` 钳制到 `1..5000`，非法值回落 1，不把外部输入拼进 SQL。
- `SubagentExecutionCleanup` 使用 `setInterval` 每小时触发，`stopped` 控制生命周期，`cleaning` 防止同一进程内并发扫描。
- cutoff 通过 `formatDateTime` 生成，与数据库 `DATETIME` 格式一致。
- 单批异常被捕获并记录日志，返回本轮已成功删除的数量；下一小时继续执行。
- 清理器装配到 `assembleLifecycle`，关闭流程显式调用 `stop()`。

## 边界

- 超过 180 天的执行记录不再出现在 `/subagents` 历史与后台子代理详情中；子会话本身及其消息不受影响。
- 每个仍存在的子会话保留最新一条，因此即使最新记录超过 180 天，该行也不会被删除。
- 重试复用同一 execution 行并刷新 `updated_at`，不会因为旧时间被清理。
- 单轮达到 20 批上限时，剩余记录留到下一小时继续清理。
- 多实例同时运行可能并发删除同一批行；条件相同且删除幂等，不引入跨实例租约。
- 已删除子会话的历史记录会被清理；若之后通过外部手段恢复同一 `child_session_id`，旧执行审计不再存在。

## 测试

- repository：终态 / 投递状态 / `updated_at` 条件、子会话 `deleted = 0` 关联、最新记录保护、稳定排序、正确返回 `affectedRows`，并钳制 0、`NaN`、`Infinity` 与超限值。
- cleanup：180 天 cutoff、分批、20 批上限、start 幂等 / stop、并发跳过、异常日志与已删除数量返回。
