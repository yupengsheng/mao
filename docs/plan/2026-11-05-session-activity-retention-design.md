# 会话活动保留清理设计

## 背景

`session_activity` 由每次工具调用写入，保存工具类型、目标、结果摘要与 `detail_json`，是桌面「运行轨迹」工具明细和管理后台「运行轨迹」工具失败率、自定义 HTTP 工具统计的数据源。会话本身、消息与 `llm_call` 已分别有生命周期管理，`session_activity` 仍只增不减；工具调用密集的实例上，它会成为主要的存储增长来源。

## 目标

- 每小时读取 `usage.sessionActivityRetentionDays` 并清理超过保留期的会话活动。
- 默认保留 180 天，最低 90 天，覆盖管理后台 90 天分析窗口。
- 单批最多删除 5000 条，单轮最多 20 批，避免长事务和大范围锁。
- 清理幂等，多实例重复执行安全；异常只记录日志，不阻断进程。
- 新增按 `created_at` 的清理索引，避免全表扫描；不修改现有按会话查询的索引。

## 非目标

- 不删除会话、消息、任务记录或 `llm_call` 流水；各数据源保留期相互独立。
- 不归档过期活动，不提供导出后删除的合规流水线。
- 不按用户、Agent、会话或工具类型拆分保留期。
- 不修改运行轨迹读取接口、活动写入逻辑或管理后台聚合口径。

## 实现

- V183 新增系统设置 `usage.sessionActivityRetentionDays`，分类「用量」，默认值 180，管理后台可编辑；同时新增 `idx_session_activity_created (created_at)`。
- `SystemSettingService.getSessionActivityRetentionDays()` 只接受正整数；缺失或非法回落 180，低于 90 的旧值/直写值钳制为 90。设置接口拒绝小于 90 的新写入。
- `SessionActivityRepository.deleteBatch(cutoff, limit)` 执行 `DELETE FROM session_activity WHERE created_at < ? ORDER BY created_at, id LIMIT <safeLimit>`，返回 `affectedRows`；`LIMIT` 钳制在 1~5000。
- `SessionActivityCleanup` 使用 `setInterval` 每小时触发，`stopped` 控制生命周期，`cleaning` 防止同一进程内重复扫描。
- cutoff 通过 `formatDateTime` 生成，与数据库 `DATETIME` 的上海时区格式一致。
- 清理器装配到 `assembleLifecycle`，关闭流程显式调用 `stop()`。

## 边界

- 单轮达到 20 批上限时，剩余过期记录留到下一小时继续清理，不延长单轮执行时间。
- 多实例同时运行时可能并发删除同一批记录，但条件相同且删除的是同一保留期外的历史行，结果幂等。
- 清理后，运行轨迹中过期 run 的工具明细不再返回；会话消息与保留期内的 LLM 调用仍正常展示。LLM 调用与会话活动保留期独立，两者不一致时可能出现「有调用、无工具明细」或反之。
- 管理后台运行轨迹榜与自定义 HTTP 工具统计只覆盖保留期内的活动行；超期日期查询不报错，但只返回仍在库中的记录。
- 清理不触碰正在执行的会话状态、消息队列、任务执行或工具调用结果；保留期修改在下一轮清理时生效，不要求重启后端。
