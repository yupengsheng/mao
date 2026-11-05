# 开放触发准入技术方案与实施计划

## 目标

为 API Token、入站 Webhook 与 Signal 哨兵三类程序化触发增加确定性、失败关闭的来源准入。准入统一放在 `OpenRunService.run` 内、会话创建/复用与预算检查之前，拒绝时不得创建或读取会话、写入消息、入队或启动执行。

本期不引入常驻 LLM Router，不复制参考仓库的 Actor / Thread / Ticket 模型，也不根据 message、Session 或请求可写字段反推触发来源。

## 设计原则

- **显式绑定**：每次触发由入口层传入 `OpenRunAdmissionBinding`，准入只信任该绑定。
- **失败关闭**：生产装配必须注入准入服务；依赖缺失、绑定缺失或仓储异常都不得降级放行。
- **确定性**：只做资源身份、归属、状态与 scope 校验，不做模型判断。
- **不泄露存在性**：拒绝统一返回 `3054` 与固定短语，不区分 Token / 触发器 / 哨兵是否存在、归属或内部状态。
- **策略可追踪**：导出 `OPEN_RUN_ADMISSION_POLICY_VERSION = 'open-run-admission/v1'`，为后续任务记录关联预留。

## 策略矩阵

| 来源 | 必要绑定 | 校验项 |
|------|----------|--------|
| `API` | `{ kind: 'API_TOKEN', tokenId }` | Token 存在、归属当前用户、未吊销、未过期、未自动停用、scope 含 `open:run` |
| `WEBHOOK` | `{ kind: 'WEBHOOK_TRIGGER', triggerId }` | 触发器存在、归属当前用户、Agent 一致、`enabled=1`、绑定 Session 与请求 `sessionId` 一致 |
| `SIGNAL` | `{ kind: 'SIGNAL_WATCHER', watcherId }` | 哨兵存在、归属当前用户、Agent 一致、状态 `ACTIVE`；请求带 `sessionId` 时必须为 `REUSE_SESSION` 且等于复用指针 |

来源与绑定类型不匹配、绑定缺失一律拒绝。

## 执行顺序

1. `message` 长度与空值校验。
2. Agent 存在与启用校验。
3. 准入判定。
4. 用量预算 BLOCK 检查。
5. 会话创建或复用。
6. `withSessionLock`、排队或执行。

准入位于预算之前：准入拒绝是确定性的调用方错误，不需要查询预算，也不能留下任何执行痕迹。

## 错误码

| code | HTTP | 含义 | 处理 |
|------|------|------|------|
| `3054` | 403 | 触发来源未通过准入 | 固定短语；检查 Token scope/状态、触发器启用与绑定会话、哨兵状态与复用指针 |
| `3055` | 503 | 准入检查暂不可用 | 准入仓储读取异常；失败关闭，稍后重试，不计入来源连续失败 |

## 触发路径绑定

| 路径 | 绑定 |
|------|------|
| `POST /v1/open/agents/:agentId/run` | `API_TOKEN` + 当前鉴权 Token ID |
| 入站 Webhook `handleFire` | `WEBHOOK_TRIGGER` + 已验签触发器 ID |
| Signal `runCheck` | `SIGNAL_WATCHER` + 当前哨兵 ID |
| 开放调用流水重放 | 原流水 `tokenId` 对应的 `API_TOKEN` |

## 失败计数语义

- Webhook：准入拒绝（`3054`）与预算 BLOCK 同口径计入 `FAILED` 连续失败，避免确定性 4xx 被外部无限重试；准入暂不可用（`3055`）是瞬时故障，不计连败。
- Signal：准入拒绝与暂不可用均进入既有触发失败路径，按现有连败/退避规则处理。
- API：调用流水记录 `rejected` 与对应错误码，Token 自动停用策略沿用既有口径。

## 装配

`app-openapi-services.ts` 创建单个 `MysqlWebhookTriggerRepository` 与 `MysqlSignalWatcherRepository`，同时供准入与管理服务使用；Token 读取复用 `ApiTokenService.findById`。准入服务作为 `OpenRunDeps.admission` 注入。

`OpenRunDeps.admission` 保持可选，仅用于兼容未装配的单元测试与局部装配；生产装配必须注入。注入后缺失或不匹配的绑定必须拒绝。

## 测试

- 准入单测覆盖三类来源的正常与拒绝分支、scope JSON 非法、过期边界、来源/绑定类型不匹配。
- `OpenRunService` 单测覆盖准入拒绝发生在预算、会话读取/创建、落消息、入队与执行之前，未知异常转换为 `3055`，未注入准入时保持现有行为。
- API 路由、Webhook、Signal、流水重放分别断言传入正确绑定。
- Webhook 覆盖 `3054` 计入连败、`3055` 不计连败。
- 调用流水覆盖 `403/503` 映射。

## 边界

- 准入策略版本由任务记录写入：API / Webhook / Signal 触发的任务在创建或再次执行时记录 `OPEN_RUN_ADMISSION_POLICY_VERSION`（`open-run-admission/v1`）；手工、定时与 IM 通道保持为空，后续手工重跑不会清空。
- 不复用 `BUDGET_EXCEEDED`（`3041` 与 `SHARE_NOT_FOUND` 撞号）。
- 不做动态 scope 增量授权、跨用户委派或基于内容的模型路由。
- 不改变 Webhook 公开路径对不存在 / 停用 / 验签失败的既有 404 语义。
