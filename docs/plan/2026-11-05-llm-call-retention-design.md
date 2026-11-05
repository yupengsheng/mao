# LLM 调用流水保留清理设计

## 背景

`llm_call` 由每次模型调用写入，是管理后台用量分析、成本核算与运行轨迹的核心数据源。V113 已提供 `idx_llm_call_created`，V172 又增加了 `system_prompt` / `tools_json` 两个大字段；此前调用流水只增不减，单行体积变大后存储与查询成本会持续上升。

## 目标

- 每小时读取 `usage.llmCallRetentionDays` 并清理超过保留期的调用流水。
- 默认保留 180 天，最低 90 天，覆盖管理后台 90 天分析窗口。
- 单批最多删除 5000 条，单轮最多 20 批，避免长事务和大范围锁。
- 清理幂等，多实例重复执行安全；异常只记录日志，不阻断进程。
- 复用 `idx_llm_call_created`，不新增索引。

## 非目标

- 不归档过期流水，不提供导出后删除的合规流水线。
- 不按用户、Agent、场景或模型拆分保留期。
- 不修改调用写入、查询接口、运行轨迹读取或管理后台列表逻辑。
- 不删除会话消息、任务记录、`session_activity` 等派生数据。
- 不引入跨实例租约；多实例只保证删除条件与结果幂等。

## 实现

- V182 新增系统设置 `usage.llmCallRetentionDays`，分类「用量」，默认值 180，管理后台可编辑。
- `SystemSettingService.getLlmCallRetentionDays()` 只接受正整数；缺失或非法回落 180，低于 90 的旧值/直写值钳制为 90。设置接口拒绝小于 90 的新写入。
- `LlmCallRepository.deleteBatch(cutoff, limit)` 执行 `DELETE FROM llm_call WHERE created_at < ? ORDER BY id LIMIT <safeLimit>`，返回 `affectedRows`；`LIMIT` 钳制在 1~5000。
- `LlmCallCleanup` 使用 `setInterval` 每小时触发，`stopped` 控制生命周期，`cleaning` 防止同一进程内重复扫描。
- cutoff 通过 `formatDateTime` 生成，与数据库 `DATETIME` 的上海时区格式一致。
- 清理器装配到 `assembleLifecycle`，关闭流程显式调用 `stop()`。

## 边界

- 单轮达到 20 批上限时，剩余过期记录留到下一小时继续清理，不延长单轮执行时间。
- 多实例同时运行时可能并发删除同一批记录，但条件相同且删除的是同一保留期外的历史行，结果幂等。
- 清理后，调用流水列表与详情、用量分析历史报表、运行轨迹中的对应调用都不可恢复；自定义日期范围仍可查询超期日期，但只返回保留期内数据。
- 会话消息、任务记录与 `session_activity` 等非 `llm_call` 数据不受影响。
- 保留期修改在下一轮清理时生效，不要求重启后端。
