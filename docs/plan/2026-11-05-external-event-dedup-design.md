# 外部事件追踪与去重设计

## 背景

开放 API 与入站 Webhook 已通过 `open_api_call_log` 的 `(idempotency_scope, idempotency_key)` 唯一键做入口幂等，但调用流水是旁路能力：调用流水关闭、写流水失败或历史数据被清理后，同一外部事件仍会再次进入 `OpenRunService`，创建新的 Task Trigger / Execution，造成重复扣费与重复副作用。

本设计把“外部事件身份”下沉到任务域。调用流水继续负责入口幂等与审计，任务域负责“这次执行是否已经在别处被认领”，两者职责分离、互不替代。

## 目标

- API 请求携带 `Idempotency-Key` 时，以 `token:<id>` 为作用域记录外部事件；Webhook 携带 `X-Mao-Event-Id` 时，以 `trigger:<id>` 为作用域记录外部事件。
- 同一 `(external_event_scope, external_event_id)` 只允许存在一条 Task Trigger。
- 空闲直跑、忙时入队、队列消费、补偿回补队首四条链路都不丢失外部事件标识。
- 重复事件不创建新的 Trigger / Execution，也不再次调用 Agent Harness；调用方通过 `deduplicated` 识别重复。
- 不改变 `source_event_id = executionId` 的既有语义，执行历史清理仍按该列回收 Trigger。

## 非目标

- 不替代 `open_api_call_log` 的请求指纹校验与调用流水审计。
- 不为 Signal 触发虚构事件 ID；Signal 暂不参与外部事件去重。
- 不改动执行重试、崩溃恢复与定时任务的身份模型。
- 不追溯补写存量 Trigger；新字段对存量行保持 `NULL`。

## 数据模型

`agent_task_trigger` 新增：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `external_event_id` | `VARCHAR(128) COLLATE utf8mb4_bin NULL` | 上游事件 ID / 幂等键 |
| `external_event_scope` | `VARCHAR(64) COLLATE utf8mb4_bin NULL` | `token:<id>` 或 `trigger:<id>` |

唯一键：`uk_agent_task_trigger_external_event (external_event_scope, external_event_id)`。MySQL 允许多个 `NULL`，手工触发与 Signal 不受影响。

`message_queue` 同步新增 `external_event_id` / `external_event_scope`，仅用于忙时队列透传，不建唯一键：入口是否重复由 Task 域最终判定。

## 链路

### 空闲直跑

`API/Webhook 入口 → OpenRunInput.externalEvent → liveExecution → executePersistedUserPrompt → runExecution → TaskService.beginExecution → agent_task_trigger`

`OpenRunService` 在预算检查之前先查任务域：命中已有事件直接返回原会话与 `deduplicated: true`，不创建会话、消息或执行。

### 忙时入队

`OpenRunInput.externalEvent → messageQueueService.enqueue → queueSettlementOf → QueueSettlement → 消费时 beginExecution`

`QueueSettlement` 与回补参数同时携带外部事件字段；插队失败、预算阻塞、提交失败等补偿路径回补队首时不得丢标识。

## 去重策略

1. `TaskService.beginExecution` 在创建 Execution 前查询 `(scope, id)`；命中即返回 `duplicate: true` 与已有执行，不新建 Trigger / Execution。
2. 插入 Trigger 失败且错误为唯一键冲突时，重新按 `(scope, id)` 查询；命中则返回重复结果，禁止吞掉异常后继续执行。
3. 直跑路径若在预检查与执行开始之间发生并发竞争，`runExecution` 收到 `duplicate: true` 后不调用 Harness，恢复会话为 `IDLE`，按 `CANCELLED` 收敛队列绑定（CANCELLED 不计入触发器连续失败）。
4. 队列消费侧遇到重复事件同样跳过 Harness，并继续消费下一条队列消息。

## 兼容与边界

- 未携带事件 ID 的请求保持原行为，不写新字段。
- 调用流水仍先执行：`open_api_call_log` 命中重复时直接重放，不会走到任务域；任务域唯一键是绕过流水时的第二道防线。
- 清理任务继续只按 `source_event_id = executionId` 删除 Trigger；外部事件列不参与清理条件，避免误删仍被引用的执行。
- 作用域由入口根据已认证身份生成，不接受请求体可写字段，避免跨 Token / 跨触发器碰撞。
