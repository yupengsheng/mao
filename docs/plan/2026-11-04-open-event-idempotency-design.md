# 开放接口外部事件幂等技术方案与实施计划

## 目标

为开放 API 和入站 Webhook 增加可选的持久化幂等键，避免外部系统因超时重试而重复启动 Agent 执行。幂等记录复用 `open_api_call_log`，不改变现有 Task 与 Session 的一对一投影，也不改变普通 WebSocket、飞书、钉钉和微信入口。

## 入口约定

- API：读取 `Idempotency-Key` 请求头；键按 API Token 隔离，长度 1~128 个可打印 ASCII 字符。
- Webhook：读取 `X-Mao-Event-Id` 请求头；键按 Webhook 触发器隔离，长度 1~128 个可打印 ASCII 字符。
- 未携带幂等键时保持现有行为，允许重复投递。
- 相同作用域、相同键、相同请求指纹只执行第一次；后续请求返回第一次受理结果，并在响应中增加 `deduplicated: true`。
- 相同键但请求指纹不同返回参数错误，避免调用方误复用键。
- 首次请求仍在受理时，重复请求返回 `202`、`processing: true`，不创建第二次执行；会话 ID 若已经写入流水则一并返回。
- 首次请求已被拒绝时，重复使用该键返回参数错误，调用方需使用新键重试。

## 持久化设计

在 `open_api_call_log` 增加：

- `idempotency_scope`：`token:<id>` 或 `trigger:<id>`；无幂等键时为空。
- `idempotency_key`：外部键原文，最多 128 字符。
- `request_fingerprint`：请求语义 SHA-256，避免把请求正文写进唯一键。
- 唯一索引 `(idempotency_scope, idempotency_key)`；MySQL 对空值允许多条旧记录，兼容未携带幂等键的流水。

`OpenApiCallLogService.begin` 负责原子插入或读取已存在流水。唯一键冲突时必须读取旧行，不能吞掉异常后继续执行；指纹不一致直接拒绝。已存在流水的状态从 `pending/queued/completed/failed/cancelled` 投影为重复响应，调用日志不新增一行。

## 实施任务

- [x] 新增 V180 迁移与共享逻辑：字段、唯一索引、键校验、API/Webhook 指纹计算。
- [x] 扩展开放调用流水 Repository/Service：原子插入或读取、指纹冲突保护、重复状态投影。
- [x] 接入 API `Idempotency-Key` 与 Webhook `X-Mao-Event-Id`，覆盖并发重复、终态重复和拒绝重用。
- [x] 为开放接口与流水服务补回归测试，保持现有无键请求兼容。
- [x] 同步 README、`mao-cli` / 桌面端内置接口文档和 CHANGELOG，运行后端针对性测试、全量测试与构建。

## 边界

本期不把外部事件 ID 改写为 `agent_task_trigger.sourceEventId`；该字段继续表示一次实际 execution 的入口 ID。跨渠道归并、独立业务 Task、Webhook 事件长期留存清理和重启后未完成请求的自动恢复留待后续阶段。

## 状态语义与已知边界

- `pending`：首次请求已被流水接收，但尚未完成受理（可能尚未拿到 `sessionId` / `messageId`）。重复请求返回 `202` + `processing: true`。
- `queued`：首次请求已受理，消息进入待发送队列。重复请求返回 `202` + `queued: true` + `processing: true`。
- `completed` / `failed` / `cancelled`：重复请求回放首次的会话与消息 ID，`processing: false`；执行结果仍以调用流水或出站事件为准。
- `rejected`：首次请求已失败，幂等键不可复用；重复请求返回参数错误。
- 幂等有效期与调用流水保留期一致（默认 90 天）。超出保留期后同一键可能再次执行，外部系统应使用长期唯一的事件 ID。
- 本期不自动恢复崩溃后长期停留的 `pending` 行；调用方需换新键重试，并可通过调用记录判断首次请求状态。

