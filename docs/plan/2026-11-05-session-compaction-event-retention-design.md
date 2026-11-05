# 会话压缩事件保留清理设计

## 背景

`session_compaction_event` 每次上下文压缩成功写入一条，记录触发方式、压缩前后边界消息、覆盖消息数、token 节省与耗时。它用于桌面消息时间线的压缩标记和运行轨迹中的压缩节点，本身不承载压缩摘要。

压缩摘要保存在 `session_compaction`，并持续参与后续请求的上下文构建。事件表此前只增不减，长期高频压缩的会话会留下大量只用于历史展示的行。

## 目标

- 每小时清理一次超过 180 天的压缩事件。
- 单批最多删除 5000 条，单轮最多 20 批，避免长事务和大范围锁。
- 清理幂等，多实例重复执行安全；异常只记录日志，不阻断进程。
- 新增 `(created_at, id)` 索引，支撑 `WHERE created_at < ? ORDER BY created_at, id LIMIT n`。

## 非目标

- 不删除 `session_compaction` 摘要，不改变上下文压缩、边界校验或请求构建逻辑。
- 不按会话、用户或触发方式拆分保留期。
- 不归档已删除事件，超过保留期后不能从数据库恢复。
- 不改变消息时间线、运行轨迹或压缩摘要接口的返回结构。

## 保留期与时间口径

- **180 天**：与审计日志、LLM 调用流水、会话活动、飞书完成卡快照等长期治理数据一致。
- **按 `created_at` 清理**：压缩事件写入后不再更新，创建时间就是事件发生时间。
- **每小时执行**：与现有清理 Job 一致；单轮未完成时跳过后续触发。

## 索引

现有索引只有 `(session_id, boundary_msg_id)` 与 `(session_id, created_at)`，都无法服务中心化时间清理。V188 增加：

- `session_compaction_event (created_at, id)`

索引列顺序与删除语句的过滤、排序一致。

## 实现

- `SessionCompactionEventRepository.deleteBatch(cutoff, limit)` 执行 `DELETE ... WHERE created_at < ? ORDER BY created_at, id LIMIT n`，并将 `limit` 钳制到 `1..5000`。
- `SessionCompactionEventCleanup` 使用 `setInterval` 每小时触发，`stopped` 控制生命周期，`cleaning` 防止同一进程内并发扫描。
- cutoff 通过 `formatDateTime` 生成，与数据库时间字段格式一致。
- 单批异常被捕获并记录日志，返回本轮已成功删除的数量；下一小时继续执行。
- 清理器装配到 `assembleLifecycle`，关闭流程显式调用 `stop()`。

## 边界

- 超过 180 天的压缩事件不再出现在消息时间线与运行轨迹中，但压缩摘要仍然有效，后续请求不会因此失去压缩后的上下文。
- 清理只影响历史展示，不修改消息、会话水位、`session_compaction` 或正在执行的压缩流程。
- 单轮达到 20 批上限时，剩余记录留到下一小时继续清理。
- 多实例同时运行可能并发删除同一批行；条件相同且删除幂等，不引入跨实例租约。
- 新写入事件的 `created_at` 晚于 cutoff，不会被误删。

## 测试

- repository：`deleteBatch` 使用 `created_at` 条件、稳定排序、正确返回 `affectedRows`，并钳制 0、`NaN`、`Infinity` 与超限值。
- cleanup：180 天 cutoff、分批、20 批上限、start 幂等 / stop、并发跳过、异常日志与已删除数量返回。
