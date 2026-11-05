# 群消息日志保留清理设计

## 背景

`feishu_group_message_log` 与 `dingtalk_group_message_log` 随群聊长期运行持续增长，但读取侧只使用最近 120 分钟的上下文、最多 100 条溢出摘要，以及按 `message_id` 回查引用消息与媒体元数据。历史日志没有清理策略，会持续占用存储并拖慢基于 `created_at` 的跨会话扫描。

飞书日志还有 `enrich_pending` 标记：图片、文件、卡片等占位行在内容回填前必须阻止上下文水位线越过。若这些行长期卡住，水位线会停在不前进的位置，导致后续群消息无法进入上下文。

## 目标

- 每小时清理一次超过 30 天的飞书已富化群日志与钉钉群日志。
- 飞书 `enrich_pending = 1` 的行单独保留 90 天，给富化重试留出窗口，同时避免永久卡住水位线。
- 单存储每批最多删除 5000 条，每轮最多 20 批，避免长事务和大范围锁。
- 单张表异常只记录日志，不影响其它表；清理幂等，多实例重复执行安全。
- 新增 `(created_at, id)` 索引，支撑跨会话的 `WHERE created_at < ? ORDER BY created_at, id LIMIT n`。

## 非目标

- 不清理 30 天内的群日志，也不按群、用户或机器人单独配置保留期。
- 不删除 `feishu_chat` / `feishu_thread_session` / `dingtalk_chat` 等会话指针与水位线。
- 不归档被删除的日志，删除后不能从数据库恢复。
- 不改变入站幂等记录（`feishu_inbound_event` / `dingtalk_inbound_event`）的 30 天保留策略。

## 保留期决策

- **30 天**：读取侧只依赖最近 120 分钟上下文、最多 100 条溢出摘要和近期消息回查；30 天远大于所有已知读取窗口，同时与入站幂等记录、登录 state 的保留口径一致。
- **待富化 90 天**：正常的飞书富化在入站后很快完成；90 天用于兜底异常行。超过 90 天仍为 `enrich_pending = 1` 的行视为不可恢复，删除后允许水位线继续推进。90 天也保证与长期会话的历史回查留有余量。
- **每小时执行**：与现有入站事件、登录 state、审计日志等清理 Job 一致；单轮未完成时跳过后续触发。

## 读取点核对

飞书群日志的读取点：

- 最近 120 分钟群上下文注入。
- 溢出摘要最多读取 100 条窗口外消息。
- `listPendingGroupMessages` 查询待富化行并回填。
- `findGroupMessageByMessageId` 按 `message_id` 查引用消息。
- `feishu_download_file` 按 `message_id` 查媒体元数据。
- `findLatestInboundMessageId` 查最新群消息用于 reply。

钉钉群日志只用于最近 120 分钟群上下文。

因此 30 天保留不影响上述在线路径。超过 30 天的历史消息无法再从日志查引用内容或媒体元数据，届时需走平台接口或按缺失降级。

## 索引

原有索引都以 `app_id + chat_id` 或 `bot_id + conversation_id` 开头，无法服务跨会话按时间清理。V185 为两张表增加：

- `feishu_group_message_log (created_at, id)`
- `dingtalk_group_message_log (created_at, id)`

使用 `ALGORITHM=INPLACE, LOCK=NONE` 在线加索引，避免阻塞入站写入。

## 实现

- `GroupMessageLogCleanup` 持有多个 `{ name, retentionDays, deleteBatch }` 存储描述，按各存储的保留期计算 cutoff。
- 飞书拆成两个存储：`feishu_enriched` 删除 `enrich_pending = 0` 的行，`feishu_pending` 删除 `enrich_pending = 1` 的行；钉钉一个存储删除全部群日志。
- 仓储层使用 `DELETE ... WHERE ... ORDER BY created_at, id LIMIT n`，并将 `limit` 钳制到 `1..5000`。
- 清理器装配到 `assembleLifecycle`，关闭流程显式调用 `stop()`。

## 并发与边界

- 多实例同时运行时可能并发删除同一批行，条件相同且删除幂等，不引入跨实例租约。
- 单轮达到 20 批上限时剩余记录留到下一小时继续清理，不延长单轮执行时间。
- 清理与写入并发时，新写入行的 `created_at` 一定晚于 cutoff，不会被误删。
- 飞书待富化行超过 90 天被删除后，水位线可越过该位置继续注入后续消息；该条历史内容不再进入上下文。
- 删除不可逆，若需要保留更长的审计或回查期，应在部署前调整保留期并重新评估索引与存储成本。
