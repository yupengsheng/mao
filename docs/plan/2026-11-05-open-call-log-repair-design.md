# 开放接口调用流水自动收敛设计（2026-11-05）

## 背景

`open_api_call_log` 中 `pending` / `queued` 表示请求已登记但尚未写入终态。正常路径由
直跑受理或队列消费回写 `completed` / `failed` / `cancelled`。进程崩溃、部署中断或
队列消息被删除后，流水可能永久停在处理中：

- 幂等重复请求会一直返回 `deduplicated=true`、`processing=true`；
- 统计中超过 2 小时且队列无消息的记录显示为「结果未知」，但没有后续动作；
- Token 自动停用与失败通知也不会发生。

本阶段增加独立修复 Job，不改状态枚举，不新增迁移，也不改变正常回写路径。

## 可确定终态

修复只处理同时满足以下条件的流水：

1. `outcome IN ('pending', 'queued')`；
2. `created_at` 早于 2 小时前，与后台统计 `unknown` 口径一致；
3. `message_queue` 中不存在该流水的 `status = 'PENDING' AND deleted = 0` 消息；
4. 满足下面任一收敛条件：
   - `session_id` 存在且 Session 未删除、`phase` 为 `COMPLETED` / `FAILED` / `CANCELLED`：
     按 Session 终态写 `completed` / `failed` / `cancelled`；
   - `outcome = 'queued'`，Session 不存在或已删除：写 `failed`，错误码
     `EXECUTION_INTERRUPTED`，摘要「执行中断或服务重启，队列已无待执行消息，已自动收敛」。

以下情况保持不动：

- Session 仍在运行、等待审批或取消中；
- 队列仍有 `PENDING` 消息，可能即将被消费；
- `pending` 且没有 `session_id`：`begin()` 到 `markAccepted()` 之间仍可能处于直跑受理，
  仅凭数据库无法区分崩溃，需要人工用新幂等键重试。

候选 SQL 会先 `LEFT JOIN session` 只选取上述可修复组合，避免长期无法修复的活跃
Session 占满单轮 100 条额度、导致更早的候选永久饥饿；事务内仍会重新锁定并复核。

## 执行流程

`OpenApiCallLogRepairService` 每 60 秒执行一轮，启动时立即跑首轮，单轮最多 100 条。

每条候选在 `OpenApiCallLogService.settleStale()` 内开启事务：

1. `SELECT ... FOR UPDATE` 锁定流水行；
2. 复核仍为 `pending` / `queued`、已超过阈值；
3. 复核队列没有 `PENDING`；
4. `SELECT ... FOR UPDATE` 锁定 Session，按上述规则计算目标终态；
5. 使用与正常回写相同的 CAS 条件
   `WHERE id = ? AND outcome IN ('pending', 'queued')` 更新；
6. 提交后复用 `afterTerminal()`，执行 Token 自动停用计数与失败通知。

正常回写与修复同时发生时，行锁决定先后；后到者看到终态后 CAS 影响 0 行，不会重复计数。
扫描异常和单条异常只写日志，不抛到生命周期。保留期清理 Job 与修复 Job 解耦。

## 接口与运维

- 无新 HTTP 接口、无新状态值、无数据库迁移。
- 修复后的幂等重复请求会回放已收敛终态，`processing` 变为 `false`。
- 启动/停机接入现有 `assembleOpenApiServices()` 与 `createShutdownHandler()`。
- 日志关键字：`[openapi] call log repair scan failed`、`[openapi] call log repair failed`、
  `[openapi] repaired N stale call log(s)`。

## 测试

- 活跃 Session 不修复；
- 队列仍有 `PENDING` 不修复；
- Session `COMPLETED` / `FAILED` / `CANCELLED` 分别按终态收敛；
- `queued` 且 Session 不存在或已删除、队列无消息时写固定失败终态；
- `pending` 无 `session_id` 不进入候选；
- 重复扫描幂等，第二次不更新；
- 扫描异常返回 0 且不抛出；
- 候选 SQL 的 2 小时阈值、批量上限与队列条件；
- 幂等重复请求修复前返回 `processing=true`，修复后可回放终态。
