# Super-agent 任务域技术方案（第二期）

## 1. 目标

第一期已经把 Session 投影为 `agent_task`，并让每次执行产生 `agent_task_execution` 尝试记录；等待态目前只存在内存，进程重启后提问 / 工具审批会丢失，多实例也没有执行归属保护。

第二期只解决两个持久化问题：

1. **等待态可恢复**：把提问与工具审批写入 `execution_wait`，重启后把任务与执行恢复为 `BLOCKED`，重新推送恢复通知，不自动回答、不自动审批。
2. **执行租约可收敛**：用 `agent_execution_lease` 给每个 Session 的当前执行建立唯一归属与 fencing token；扫描过期租约后由新实例接管，关闭旧尝试并恢复等待态或重跑。

本期不改变模型运行方式，不新增常驻业务执行队列，不做跨渠道任务归并。

## 2. 现状与缺口

- `ApprovalRegistry` / `AskUserQuestionsRegistry` 只在进程内存保存 `requestId` 与等待 Promise；重启后 Registry 为空，用户无法再处理旧请求。
- `TaskWaitObserver` 能把等待聚合为 Task / Execution 的 `BLOCKED`，但等待集合本身不落库，也没有 `expires_at` 可供恢复判断。
- `CrashRecoveryRunner` 只扫描 `RUNNING` / `RESUMING`，依赖 `last_activity_at` 静默阈值；没有数据库级互斥，多实例同时恢复时可能重复启动同一会话。
- `beginRecoveryExecution` 能关闭旧尝试并登记新尝试，但“谁有权恢复”仍由部署排空与静默阈值保证，不能单独作为单跑互斥。
- 等待中的执行没有租约：进程崩溃后既不能判断等待是否仍然有效，也不能阻止另一个实例把它当作 `RUNNING` 重跑。

## 3. 非目标

- 不做 LLM Router、常驻 Watchdog、主动执行、二期自动准入或跨渠道任务归并。
- 不自动回答提问、不自动通过 / 拒绝审批；恢复只重推“等待已恢复为只读”的通知。
- 不重建进程崩溃时丢失的 Agent Loop / Tool Dispatcher 调用栈。恢复后的旧等待不能继续原 Promise，因此本期不提供可应答的假恢复。
- 不解决多实例下 WS 应答落点、外部工具副作用回滚、跨实例实时取消。租约只保证执行归属与数据库终态不串写。
- 不覆盖子代理内部并发；子代理执行仍按其现有恢复协调器处理。
- 不回填历史等待与历史执行；只处理上线后新写入的租约与等待记录。

## 4. 数据模型

新增迁移 `backend-ts/db/migration/V200__execution_wait_and_lease.sql`。最新迁移当前为 `V199`。

### 4.1 `execution_wait`

```sql
CREATE TABLE `execution_wait` (
    `id` BIGINT AUTO_INCREMENT PRIMARY KEY,
    `session_id` BIGINT NOT NULL,
    `execution_id` VARCHAR(128) NOT NULL,
    `request_type` VARCHAR(16) NOT NULL COMMENT 'APPROVAL / QUESTION',
    `request_id` VARCHAR(128) NOT NULL,
    `status` VARCHAR(16) NOT NULL COMMENT 'PENDING / RELEASED / EXPIRED',
    `payload_summary` TEXT NULL COMMENT '仅展示安全的脱敏投影，不存原始参数或答案',
    `payload_digest` CHAR(64) NULL COMMENT '原始请求规范化后的 SHA-256，仅用于幂等与诊断',
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `expires_at` DATETIME NOT NULL,
    `released_at` DATETIME NULL,
    `release_reason` VARCHAR(64) NULL,
    `fencing_token` BIGINT NOT NULL DEFAULT 0 COMMENT '写入时的执行租约 token，恢复与释放时校验',
    `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY `uk_execution_wait_request` (`session_id`, `request_type`, `request_id`),
    KEY `idx_execution_wait_pending` (`status`, `expires_at`),
    KEY `idx_execution_wait_execution` (`execution_id`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

写入规则：

- `TaskWaitService.started` 在原有内存登记成功后插入 `PENDING` 行；同一 `(session_id, request_type, request_id)` 重复开始按唯一键幂等，不覆盖首次 `created_at`。`execution_id` 与 `fencing_token` 由 `TaskWaitService` 在写入时解析；`expires_at` 使用数据库时间生成，调用方不传。
- `TaskWaitService.finished` 把对应行更新为 `RELEASED`，写入 `released_at` 与固定原因（`ANSWERED` / `APPROVED` / `DENIED` / `CANCELLED` / `TIMEOUT`）。更新必须带 `status = 'PENDING'` 条件，只有第一次结束生效，后续重复结束不得覆盖原因。正常进程内超时走 `RELEASED / TIMEOUT`；取消统一走 `RELEASED / CANCELLED`，不引入 `CANCELLED` 状态；只有进程已崩溃、恢复时才发现超过 `expires_at` 的行才置 `EXPIRED`。
- 等待持久化失败只记录日志与指标，不阻断提问、审批、回答、取消与超时的既有语义；恢复能力降级为“没有该等待的持久化记录”。
- 等待超时口径以现有实现为准，不新增定时器：
  - `QUESTION`：`AskUserQuestionsRegistry` 的 `DEFAULT_TIMEOUT_MILLIS = 900_000`。
  - `APPROVAL`：`ApprovalRegistry` 本身没有超时定时器；实际等待上限由调用方 `LocalToolExecutor` 的 `timeoutSeconds = 900` 控制（`Promise.race` 的 900s 定时器）。
  - `TaskWaitService` 统一按数据库时间写入 `expires_at = created_at + 900s + 60s`。60s 只是恢复扫描的边界宽限，不放宽用户可操作时间；审批实现若未来调整 `LocalToolExecutor` 超时，需同步此口径。

### 4.2 脱敏存储

`payload_summary` 只允许白名单投影：

- `APPROVAL`：`{ toolName, target, argumentPreview }`。`argumentPreview` 复用现有工具结果摘要 / 参数预览逻辑，并对 token、password、secret、authorization、cookie、私钥等字段做掩码，最长 2KB。
- `QUESTION`：`{ questionCount, questions: [{ id, header, question, options: [{ label, description }] }] }`。不存 `metadata`、默认值、用户答案、模型上下文。
- 无法生成安全投影或超过长度上限时，只存 `{ summary: '等待请求（参数已隐藏）', truncated: true }`。
- `payload_digest` 对规范化原始请求做 SHA-256；原参数、答案、审批意见一律不落库，也不写日志。

### 4.3 `agent_execution_lease`

```sql
CREATE TABLE `agent_execution_lease` (
    `id` BIGINT AUTO_INCREMENT PRIMARY KEY,
    `session_id` BIGINT NOT NULL,
    `execution_id` VARCHAR(128) NOT NULL,
    `owner_instance` VARCHAR(128) NOT NULL,
    `fencing_token` BIGINT NOT NULL DEFAULT 0,
    `status` VARCHAR(16) NOT NULL COMMENT 'ACTIVE / RELEASED；过期由 expires_at 判定',
    `heartbeat_at` DATETIME NULL,
    `expires_at` DATETIME NOT NULL,
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY `uk_agent_execution_lease_session` (`session_id`),
    KEY `idx_agent_execution_lease_expiry` (`status`, `expires_at`),
    KEY `idx_agent_execution_lease_execution` (`execution_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

约束与语义：

- 每个 Session 最多一行租约；`fencing_token` 每次成功抢占递增，旧持有者的 token 永久失效。
- `owner_instance` 使用稳定的实例标识（主机名 + 进程启动 ID），不使用仅 PID。
- 默认 `TTL = 60s`、心跳间隔 `15s`；TTL 至少为心跳的 3 倍。
- 所有过期判断使用数据库 `NOW()`，不使用应用进程时钟。

### 4.4 `TaskWaitObserver` 扩展与调用方

现有接口只有 `started(sessionId, kind, requestId)` / `finished(sessionId, kind, requestId)`，拿不到执行归属、摘要与结束原因。本期改为结构化入参，所有实现与调用方同任务更新：

```ts
export type TaskWaitKind = 'QUESTION' | 'APPROVAL';
export type TaskWaitReleaseReason = 'ANSWERED' | 'APPROVED' | 'DENIED' | 'CANCELLED' | 'TIMEOUT';

export interface TaskWaitStartedInput {
  sessionId: number;
  kind: TaskWaitKind;
  requestId: string;
  /** 已脱敏的 JSON 摘要，规则见 4.2。 */
  payloadSummary: string;
  /** 规范化原始请求的 SHA-256，只用于幂等与诊断。 */
  payloadDigest: string;
}

export interface TaskWaitObserver {
  started(input: TaskWaitStartedInput): void;
  finished(sessionId: number, kind: TaskWaitKind, requestId: string, reason: TaskWaitReleaseReason): void;
}
```

摘要来源必须由真正持有参数的调用方生成：

- `APPROVAL`：`ApprovalRegistry.register` 扩展可选 `summary` 参数，由 `LocalToolExecutor` 从 `toolName` + `argumentsJson` + `dangerReason` 生成脱敏投影后传入。`ApprovalRegistry` 自身只保存 `requestId`，不解析工具参数。
- `QUESTION`：`AskUserQuestionsRegistry.register` 从 `questions` 白名单字段生成摘要；直接丢弃 `metadata`，不读取答案与模型上下文。
- `executionId` 由 `TaskWaitService` 通过 `executionLookup.getSessionExecution(sessionId)` 获取；取不到时不写 `execution_wait`，避免把等待挂到错误执行。调用方只提供展示摘要与摘要哈希，不知道也不传执行 ID。
- `expiresAt` 由 `TaskWaitService` 统一计算为数据库 `created_at + 900s + 60s`，避免提问 / 审批两个 Registry 各写一份超时。

结束原因的唯一来源：

| 路径 | 首次写入 `release_reason` | 说明 |
| --- | --- | --- |
| 审批 WS `tool_approval` 帧 | `approved === true` → `APPROVED`；`approved === false` → `DENIED` | `handleToolApproval` 先带上具体原因调用 `ApprovalRegistry.unregister(...)`，这是审批结果的权威来源。 |
| 审批超时 | `TIMEOUT` | `LocalToolExecutor` 的 900s 定时器命中后，在 `finally` 前把本次释放原因置为 `TIMEOUT`。 |
| 审批取消 / 断连 / 执行异常 | `CANCELLED` | `LocalToolExecutor.finally`、会话取消或连接清理的通用兜底；若 WS 已先写入具体原因，条件更新不生效。 |
| 提问正常回答 | `ANSWERED` | `AskUserQuestionsRegistry.complete` 删除内存条目时写入。 |
| 提问超时 | `TIMEOUT` | `waitForAnswer` 的 900s 超时分支写入。 |
| 提问取消 | `CANCELLED` | `failAllForSession` / `failAllForSessions` 写入。 |

因此 `ApprovalRegistry.unregister` 扩展为 `unregister(sessionId, requestId, reason?)`：WS 审批路径必须显式传 `APPROVED` / `DENIED`，`LocalToolExecutor.finally` 的兜底默认 `CANCELLED`（超时路径传 `TIMEOUT`）。两个 `unregister` 调用点保留，但数据库侧以 `PENDING → RELEASED` 的第一次条件更新为准；后到的通用兜底不得覆盖已写原因。

## 5. 等待态状态机

```text
started ──► PENDING ──answered/approved/denied──► RELEASED
                │
                ├──cancel──────────────────────► RELEASED (release_reason=CANCELLED)
                └──expires_at 到达──────────────► EXPIRED
```

- 同一 Session 可同时存在多条 `PENDING`（例如一个提问 + 一个审批）；Task / Execution 只投影为 `BLOCKED`，不按请求条数拆状态。
- `PENDING` 是“不要启动 harness”的权威标记。恢复扫描与普通执行启动都必须先检查当前 Session / Execution 是否存在 `PENDING` 等待。
- 取消不新增状态：写 `status = RELEASED`、`release_reason = CANCELLED`、`released_at = NOW()`；只有恢复扫描发现过期且从未正常结束的行才写 `EXPIRED`。
- 正常回答 / 审批 / 取消 / 超时仍走现有 Registry；持久化层只旁路记录，不改变原有 Promise 与事件顺序。
- 进程重启后，旧 Promise 已不存在，`PENDING` 行不再代表可应答请求，只代表“该执行曾被阻塞”。恢复时按第 7 节处理。

## 6. 租约生命周期

### 6.1 获取

新增 `ExecutionLeaseService`，唯一获取接口：

```ts
acquire(sessionId: number, executionId: string, ownerInstance: string): Promise<LeaseHandle | null>;
heartbeat(handle: LeaseHandle): Promise<boolean>;
release(handle: LeaseHandle): Promise<void>;

interface LeaseHandle {
  sessionId: number;
  executionId: string;
  ownerInstance: string;
  fencingToken: bigint;
  expiresAt: Date;
}
```

获取流程：

1. 以 `session_id` 为唯一键执行事务内 `SELECT ... FOR UPDATE`。
2. 无行则插入 `ACTIVE`，`fencing_token = 1`。
3. 有行且 `status = ACTIVE AND expires_at >= NOW()`，且 `execution_id` 与请求不同，则获取失败，本次启动放弃。
4. 有行且已过期 / 已释放则更新 `execution_id`、`owner_instance`、`status = ACTIVE`、`fencing_token = fencing_token + 1`、`heartbeat_at = expires_at = NOW()` 计算值。
5. 有行且 `status = ACTIVE` 且 `execution_id` 相同：视为同一次执行的重入，返回原 `fencingToken`，不递增 token。
6. 获取成功后返回 `LeaseHandle`；调用方必须把 handle 带到任务投影、阶段写入、等待写入与终态结算。

**唯一获取点**：`TaskTerminalService.beginExecution` 升级为返回 `LeaseHandle` 的门禁（下称执行门禁），内部先 `acquire`，成功后才做任务投影。所有主执行入口在调用 Harness 之前走同一门禁：

| 入口 | 现有登记点 | 二期处理 |
| --- | --- | --- |
| WS 首发 / 重试 | `streaming-ws-handler.ts` 调 `beginExecution` | 改为接收门禁返回的 handle，并在 `executeFromEvent` 透传 |
| 开放接口直执行 | `open-run.service.ts` 调 `beginExecution` | 同上；`liveExecution` 分支必须在最外层入口取一次，内部复用 |
| 定时任务直执行 | `scheduled-task.service.ts` 调 `beginExecution` | 同上 |
| 崩溃恢复 | `crash-recovery-runner.ts` 调 `beginRecoveryExecution` | 先 claim 租约再投影，见第 7 节 |
| 飞书 / 钉钉 / 微信入站 | 只依赖 `HarnessService.executionStarter` | 在调用 `harness.execute` 前显式过门禁，不再依赖 Harness 内部兜底 |
| 边路首条消息 | `executeSideFirstMessage` → `beginTrackedExecution` | 调用方先以边路 `sideSessionId` 过门禁，handle 随调用透传 |
| `executePrepared` | `context.sessionId` → `beginTrackedExecution` | 由最外层调用方传 handle；缺失即拒绝，不允许 Harness 自行获取 |

`HarnessService.beginTrackedExecution` 删除：任务投影已在执行门禁内完成，Harness 不再持有 `executionStarter`。`execute` / `executeFromEvent` / `executePrepared` / `executeSideFirstMessage` 增加 `lease?: LeaseHandle` 参数；租约开关启用时缺失 handle 直接抛错，Harness 不启动。拿到 handle 后 Harness 只负责启动心跳、在丢失租约时设置 cancel flag，不再调用 `acquire`。**租约获取失败必须向调用方抛出**；任务投影失败仍按现有方式尽力而为（记录日志，但不阻断已拿到租约的执行）。现有 `beginExecution` 吞掉所有异常、`HarnessService` 再吞一次的实现必须拆开：

- `LeaseConflictError` / `LeaseUnavailableError`：fail-closed，向上抛，入口返回现有执行错误，用户可重试。
- `TaskProjectionError`：记录 `task_projection_failed`，不阻断 Harness。
- 未拿到 handle 时不创建新的 `agent_task_execution`，也不进入 `AgentLoop`。

门禁顺序固定为：外部事件只读去重（命中直接返回 `duplicate=true`，不取租约）→ `PENDING` 等待检查（命中直接拒绝，不取租约）→ `acquire` → 任务投影。投影阶段才发现重复（并发竞态）时立即 `release` 租约并返回 `duplicate=true`，避免去重流量占用租约。

**普通执行启动检查**：`acquire` 之前必须查询该 Session 是否还有 `PENDING` 的 `execution_wait`。有则直接拒绝本次启动（不取租约，避免 token 空转），把本次触发收敛为等待态或返回 busy。该检查防止恢复扫描在等待分支释放租约后，新的外部重试绕过等待直接开跑；检查与 `acquire` 之间的竞态由旧执行仍持有租约 / `execution_wait` 行锁兜底。

### 6.2 取消路径

`cancelActiveExecution` 当前在拿不到 executionId 时用 `randomUUID()` 结算，会凭空创建执行并绕过 fencing。二期改为固定解析顺序，禁止随机 ID：

1. `registry.getSessionExecution(sessionId)`。
2. 当前 `agent_execution_lease.execution_id`（租约是执行归属的权威记录）。
3. `taskService.getActiveExecutionId(session)`。

三者都为 null 时：只把 Session 置 `CANCELLED` 并清在途登记，不写 `agent_task_execution` 终态，不释放别人的租约。只要拿到 executionId，就必须用对应的 `LeaseHandle` 走 `finishExecution`；租约已被新实例抢占时，取消方不得写任务终态。

### 6.3 心跳

- 执行期间每 15s 刷新 `heartbeat_at` 与 `expires_at`。
- 刷新 SQL 必须带 `session_id + execution_id + fencing_token + status='ACTIVE'`；影响行数为 0 表示租约已丢失。
- 连续两次心跳失败或确认丢失租约时，设置既有 `AgentLoop` cancel flag，停止接受新的工具调用，并按现有取消链路收尾；不得继续写 Task 终态。
- 进程正常结束时先结算 Task / Execution，再把租约置为 `RELEASED`；先释放租约会让其他实例在终态写入前抢占。

### 6.4 Fencing 接入

现有接口签名需要同步扩展，token 由 handle 透传，不在各服务内重新获取：

```ts
// TaskTerminalService（执行门禁）
beginExecution(sessionId, executionId?, source?, externalEvent?): Promise<{ duplicate: boolean; lease: LeaseHandle | null }>;
beginRecoveryExecution(sessionId, executionId, lease: LeaseHandle): Promise<void>;
finishExecution(sessionId, userId, phase, executionId, failureReason?, notifySource?, lease: LeaseHandle): Promise<{ settled: boolean }>;

// TaskService（校验放在现有事务内，与 session 行锁同事务）
setExecutionStage(session, executionId, stage, lease: LeaseHandle): Promise<void>;
settleExecution(session, executionId, phase, failureReason?, source?, lease: LeaseHandle): Promise<void>;
beginRecoveryExecution(session, executionId, lease: LeaseHandle): Promise<TaskExecution>;
```

以下写操作在事务内校验 `(session_id, execution_id, fencing_token)`，校验失败按“已失去租约”处理，不写终态、不覆盖新执行：

- `TaskService.setExecutionStage` / `settleExecution` / `beginRecoveryExecution`
- `TaskWaitService` 的阶段投影（其底层仍调 `setExecutionStage`）
- `execution_wait` 的写入、释放与过期收敛（`execution_wait.fencing_token` 必须与当前租约一致）

校验失败只记录 `lease_lost` 日志与指标。WS 推送属于尽力而为，不作为归属判据。

`finishExecution` 的幂等规则：

- Session 已是终态、且 handle 仍为当前 `ACTIVE` 租约：先按现有逻辑补写一次 Task 终态（覆盖“Session 已落终态但任务域未结算”的中断窗口），成功后释放租约。
- Session 已是终态、但 handle 已失效（token 不匹配 / 状态非 ACTIVE）：视为旧执行迟到，直接返回 `{ settled: false }`，不再调用 `settleTask` 覆盖新执行。
- 正常终态：`settleTask` 成功后才 `release`；`settleTask` 失败则保留租约到 TTL 过期，让恢复扫描接管，避免无归属的终态写入。

### 6.5 `finishExecution` 调用面与 handle 透传

`finishExecution` 升级后不再接受“只有 executionId、没有租约”的调用。`beginExecution` / `acquire` 返回的 `LeaseHandle` 必须绑定到本次执行上下文，并沿所有终态路径透传；禁止在处理完成、取消、通知或异常兜底时重新按 executionId 猜 handle。

| 调用面 | 现状 | 二期要求 |
| --- | --- | --- |
| WS 主会话 / 重试 | `streaming-ws-handler` 在执行体里直接调用 `finishCompletedSession` / `finishFailedSession` / `finishCancelledSession` | 执行体保存门禁返回的 handle；三个 finish helper 与队列回写都增加 `lease` 参数，禁止用 `currentExecutionId()` 反查。 |
| WS 边路任务 | `executeSideFirstMessage` 路径自行生成 `sideExecutionId`，提前取消路径甚至用 `randomUUID()` 调 finish | 边路会话也先过执行门禁；未拿到 handle 的提前取消只做内存清理与阶段收敛，不写任务终态；正常路径把 handle 传给 `executeSideFirstMessage` 和所有 finish helper。 |
| 开放接口 | `open-run.service` 的 `liveExecution` 回调和兜底路径直接 `finishExecution` | `liveExecution` 回调签名增加 `lease`；兜底路径直接用门禁 handle。复制/竞态回滚分支没有租约时只回滚消息与阶段，不伪造执行终态。 |
| 定时任务 | `scheduled-task.service` 的 `liveExecution` 回调和遗留兜底路径直接 `finishExecution` | 回调签名增加 `lease`；只有 `executionStarted = true` 且拿到 handle 时才写 FAILED 终态，忙等未执行路径保持现状不碰任务执行。 |
| 飞书 / 钉钉 / 微信入站 | 通道运行时在 `onExecutionFinished` 中按 executionId 调 `finishExecution` | 通道入口在调用 Harness 前显式过门禁并保存 handle；`onExecutionFinished` / 取消回调增加 `lease` 参数，禁止在回调里按 executionId 重新解析。 |
| 子代理 / 后台子代理 | `executeVisible` 内部生成 executionId；`finishSubagent` 多处直接调 finish，排队失败还会传空 executionId | `executeVisible` 先为 childSession 取租约，`VisibleRunResult` 增加 `lease`；`finishSubagent` 增参 lease。尚未启动执行就失败的路径（排队取消、提交失败、恢复前失败）只更新子代理记录 / Session 阶段，不得调用 `finishExecution`，也不得生成空 executionId。 |
| 崩溃恢复 | `crash-recovery-runner` 调 `beginRecoveryExecution` 后继续跑，结束时再次 `finishExecution` | 使用 claim 得到并交给 `beginRecoveryExecution` 的同一个 handle；恢复等待分支、过期分支、取消分支都以该 handle 结算。 |
| 主动取消 | `cancelActiveExecution` 在 registry / task 都取不到 ID 时用 `randomUUID()` | 按 §6.2 解析 executionId 并从租约服务取 handle；只有拿到当前 ACTIVE handle 才走 `finishExecution`，否则只收敛 Session 阶段与内存资源。 |

实现约束：

- `TaskTerminalService`、`HarnessService`、`OpenRunService`、`ScheduledTaskService`、通道运行时、`SubAgentVisibilityService` 的窄接口都要同步增加 lease 参数；只改 `TaskTerminalService` 会在 tsc 阶段暴露遗漏。
- `finishExecution` 的 `lease` 参数为非空；确实没有执行归属的“预启动失败”不是终态结算，调用方不得为了统一而传入空对象或假 executionId。
- `finishExecution` 内部只使用传入 handle 校验 fencing，不调用 `executionLookup` / `getSessionExecution` 重新获取。终态广播可以继续带 executionId，但归属判据只有 handle 的 `sessionId + executionId + fencingToken`。
- `settleTask` 只由 `finishExecution` 在租约仍有效时调用；引用构建、收件箱、外部通知、记忆抽取等后续副作用仍可 best-effort，但不得改变任务终态或重新获取租约。

## 7. 恢复算法

复用 `CrashRecoveryRunner` 的调度骨架，新增“过期租约扫描”，不再只依赖 `last_activity_at`。

### 7.1 候选查询

每 30s 扫描一次，单批最多 20 个会话、最多 3 个并发，单轮时间预算 30s：

```sql
SELECT l.*
FROM agent_execution_lease l
JOIN session s ON s.id = l.session_id
WHERE l.status = 'ACTIVE'
  AND l.expires_at < NOW() - INTERVAL 30 SECOND
  AND s.phase IN ('RUNNING', 'RESUMING', 'WAITING_APPROVAL')
ORDER BY l.expires_at ASC
LIMIT 20;
```

候选查询不能排除有 `PENDING` 等待的会话：这些会话同样需要“先抢租约、再按等待状态恢复”的路径（§7.2）。如果加了 `NOT EXISTS`，未过期等待分支永远不可达。为防止新的外部重试绕过等待，所有普通执行启动必须在 §6.1 检查 `PENDING` 等待。

兼容旧版本与未写入租约的会话：保留现有 `RUNNING_ORPHAN_STALE_SEC = 120` / `RESUMING_ORPHAN_STALE_SEC = 45` 的兜底扫描；兜底命中后先补建租约，再走同一恢复流程。灰度部署必须先排空旧实例，避免旧实例仍在执行时被新实例按兜底规则误抢。

### 7.2 单会话恢复步骤

```text
claim lease (CAS, token++)
  └─ 失败：跳过，下一轮
lock session row
  └─ Session 删除 / 非有效阶段：释放租约，结束
读取该 execution 的 PENDING waits（按 execution_id + fencing_token）
  ├─ 有未过期等待：
  │   1. Task / Execution 置 BLOCKED
  │   2. APPROVAL → Session 置 WAITING_APPROVAL；QUESTION → 保持 RUNNING
  │   3. 重推 session_status + execution_wait_recovered（只读通知）
  │   4. 释放租约（status=RELEASED；原因 PENDING_WAIT 只记日志/指标），不启动 Harness
  │   5. 保留 wait 为 PENDING：它是禁止重启 Harness 的权威标记
  ├─ 有已过期等待：
  │   1. wait 置 EXPIRED（校验 token）
  │   2. 执行以固定原因失败结算，Task FAILED
  │   3. 结算成功后释放租约；不重推可应答请求
  └─ 无等待：
      1. beginRecoveryExecution：关闭旧 WORKING/BLOCKED 尝试
      2. 创建新尝试并更新 Task / 新 executionId
      3. 沿用本次 claim 得到的 token，启动 Harness 续跑
      4. 终态结算成功后释放租约
```

混合等待（同一执行同时有过期与未过期请求）先逐条把过期行置 `EXPIRED`；只要仍有 `PENDING`，就保持 `BLOCKED` 并按未过期分支重推，不提前失败结算。只有不存在任何 `PENDING` 时，才对已过期执行做失败收敛。

恢复等待分支释放租约后，`PENDING` 仍保留，因此普通执行启动的 `PENDING` 检查会拒绝同一 Session 的新 Harness。用户取消或明确处理等待后，才把对应行写为 `RELEASED`，之后允许新执行。

幂等与顺序：

- 同一 `request_id` 重推只产生一条恢复通知，`execution_wait` 不新增行。
- 同一 `execution_id` 的 `beginRecoveryExecution` 已幂等；重复恢复不会重复关闭或新增尝试。
- 旧尝试迟到终态继续按 `attemptNo` 规则忽略，不覆盖新尝试。
- 每步都可被 shutdown 打断；已抢占但未开始的租约在下一轮自然过期，不需要补偿队列。

### 7.3 恢复通知

新增 WS 事件 `execution_wait_recovered`，只包含展示安全字段：

```json
{
  "sessionId": 11,
  "executionId": "uuid",
  "requestId": "req-1",
  "requestType": "APPROVAL",
  "summary": "等待工具 read_file 的审批（参数已隐藏）",
  "expiresAt": "2026-11-05 12:00:00",
  "recovered": true,
  "actionable": false
}
```

- `actionable = false` 明确告知客户端：这是重启后的只读恢复，不提供审批 / 回答按钮。
- 用户可走既有“取消执行”或重新发起；不自动把恢复通知当作审批结果。
- 用户离线导致首次推送丢失时，Session 详情接口返回 `pendingWait` 摘要，客户端打开会话后展示同一通知；不重复生成新的 `requestId`。

## 8. 多实例与故障降级

### 8.1 多实例

- 租约保证同一 Session 同时最多一个 `ACTIVE` 持有者；抢占用行锁 + fencing token，两个实例同时恢复只有一个成功。
- 正常等待仍在内存 Registry 中，应答 / 审批需要落到持有实例；本期不改变现有 WS 路由假设，也不把租约当作跨实例应答路由。
- 恢复后的等待是只读通知，不依赖跨实例 Promise，因此不会出现“另一个实例审批成功但执行不继续”的假成功。
- 子代理、后台任务与主执行可能并行，但各自使用独立 Session 租约；本期不引入全局并发配额。

### 8.2 数据库故障

- 获取租约失败：不启动 Harness，返回现有执行错误，用户可重试；不允许“无租约裸跑”。
- 心跳失败：记录 `lease_heartbeat_failed`；连续两次失败设置 cancel flag。数据库恢复后若 token 仍有效可继续，token 失效则不再写终态。
- 等待持久化失败：不阻断原等待；该请求失去重启恢复能力，记录 `wait_persist_failed`。

### 8.3 时钟漂移与网络分区

- 过期判断统一用数据库 `NOW()`；应用只使用数据库返回的 `expiresAt` 展示。
- TTL 为心跳的 4 倍（60s / 15s），降低网络抖动导致的误抢占。
- 网络分区期间旧持有者可能已经产生外部工具副作用，fencing 只能阻止数据库终态串写，不能回滚外部副作用；通过取消标志、工具幂等与上线排空降低窗口，本期不承诺强一致副作用回滚。
- 若扫描发现租约时间在未来（时钟异常），跳过并告警，不主动缩短 TTL。

## 9. 查询与展示

契约先落在 `@mao/contracts`，禁止前后端各写一份并行类型：

```ts
// shared/contracts/src/task.ts
export type TaskWaitKind = 'QUESTION' | 'APPROVAL';
export type TaskWaitStatus = 'PENDING' | 'RELEASED' | 'EXPIRED';
export type TaskWaitReleaseReason = 'ANSWERED' | 'APPROVED' | 'DENIED' | 'CANCELLED' | 'TIMEOUT';

export interface TaskWaitVO {
  kind: TaskWaitKind;
  requestId: string;
  summary: string;
  expiresAt: string;
  /** 该等待是否来自崩溃恢复后的只读投影。 */
  recovered: boolean;
  /** 重启后旧 Promise 已丢失，固定为 false。 */
  actionable: boolean;
}

export interface TaskDetailVO {
  task: AgentTaskVO;
  latestExecution: TaskExecutionVO | null;
  executions: TaskExecutionVO[];
  triggers: TaskTriggerVO[];
  /** 仅当前执行的 PENDING 等待；历史执行不逐条携带。 */
  pendingWait: TaskWaitVO | null;
}
```

查询与返回规则：

- `pendingApprovalCount`、`pendingQuestionCount` 继续由内存 Registry 提供实时增量；重启后由 `execution_wait` 的 `PENDING` 行批量补齐（`applySessionListSignals` 的计数入参改为 Registry 计数 + 持久化计数取 `max`，同一 requestId 去重）。
- Session 详情：`GET /api/v1/sessions/:id` 调用 `enrichSessions([session], { includePendingWait: true })`，在 `SessionVO` 增加 `pendingWait?: TaskWaitVO | null`。列表 / dashboard / search 路径保持默认 `false`，不返回该字段。
- 桌面端 `desktop/src/stores/session/types.ts` 的 `Session` 同步增加可选 `pendingWait?: TaskWaitVO | null`，从 `@mao/contracts` 导入；不在前端 api 层手写联合类型。
- Task 详情：`TaskDetailVO.pendingWait` 由 `TaskService.get()` 按 `agent_task.lastExecutionId` 查询 `execution_wait`（`status='PENDING'`，多条时取 `expires_at` 最早的一条）填充；Task 列表继续用 `stage = BLOCKED` 筛选，不新增接口。
- `mao task get` 在执行详情中透出 `pendingWait`，字段映射同步到 `skills/mao-cli/reference/task.md`；不输出原始参数、答案或审批意见。
- `execution_wait_recovered` 通知与 `pendingWait` 使用同一 `TaskWaitVO` 字段集，避免前后端两套结构。

## 10. 开发顺序

1. 契约：`shared/contracts/src/task.ts` 增加 `TaskWaitKind` / `TaskWaitStatus` / `TaskWaitReleaseReason` / `TaskWaitVO` 与 `TaskDetailVO.pendingWait`；导出到 index；三端 tsc 先绿。
2. 迁移 `V200`：两张表、`execution_wait.fencing_token`、唯一键与查询索引；补 SQL 结构测试。
3. `TaskWaitObserver` 扩参 + `TaskWaitService` 双写：开始 / 结束 / 取消 / 超时落库；`ApprovalRegistry.register` 与 `LocalToolExecutor` 传入审批摘要；失败不阻断；补幂等与脱敏测试。
4. `ExecutionLeaseService`：`acquire` / `heartbeat` / `release` / `assertFenced`；同 executionId 重入返回原 token。
5. 执行门禁：`TaskTerminalService.beginExecution` 先取租约、再投影；拆分 fail-closed 与 best-effort 错误；删除 `HarnessService.beginTrackedExecution`，任务投影并入执行门禁；WS / openapi / scheduled / 通道 / 边路 / `executePrepared` 全部接入，禁止 Harness 内再次获取。
6. 启动前 `PENDING` 检查与取消路径：普通执行发现等待即释放租约并拒绝启动；`cancelActiveExecution` 去掉 `randomUUID()`，按 registry → lease → task 顺序解析。
7. 终态与 fencing：`setExecutionStage` / `settleExecution` / `beginRecoveryExecution` 增加 lease 参数并校验 token；`finishExecution` 返回 `{ settled }`，已失租约不覆盖新执行。
8. `CrashRecoveryRunner`：候选查询去掉 `NOT EXISTS`；先 claim 再按等待分支处理；等待恢复释放租约但保留 `PENDING`；过期收敛与无等待续跑；保留旧静默阈值兜底。
9. Session / Task 查询补齐 `pendingWait` 与持久化计数；Session 详情路由显式开启；WS `execution_wait_recovered` 通知。
10. 端到端验证：审批中杀进程重启、提问中重启、等待过期、取消、租约抢占、旧终态迟到、等待期间外部重试被拒绝。
11. 更新 `CHANGELOG.md`、`README.md`、`DEPLOY.md`、`skills/mao-cli/SKILL.md` 与 `skills/mao-cli/reference/{task,desktop,admin}.md`。

## 11. 测试与验收

- 等待写入：同请求重复开始只一行；结束幂等；取消 / 超时释放；持久化异常不影响回答与审批。
- 观察者扩参：审批摘要来自 `LocalToolExecutor`（toolName + 参数预览），提问摘要不含 `metadata` / 答案；`executionId` 缺失时不落库。
- 脱敏：token / password / cookie / 私钥字段被掩码；原始参数、答案、审批意见不出现在表与日志。
- 恢复：未过期等待恢复为 `BLOCKED` 并只推一次只读通知；不自动回答 / 审批；过期等待置 `EXPIRED` 并失败结算。
- 租约：同一 Session 并发抢占只有一个成功；token 递增；同 executionId 重入不递增；心跳丢失停止执行；旧 token 终态写入被拒绝。
- 门禁：租约获取失败时 Harness 不启动、不创建执行；任务投影失败仍可继续执行；等待期间外部重试被 `PENDING` 检查拒绝。
- 取消：无 executionId 时不生成随机 UUID、不写假执行；registry / lease / task 三路解析顺序正确。
- 终态幂等：Session 已终态且租约仍属当前执行时补结算一次；租约已失效时返回 `settled=false` 且不覆盖新执行。
- 查询：Session 详情返回 `pendingWait`，列表不返回；`TaskDetailVO.pendingWait` 取最早过期的一条；`mao task get` 映射与契约一致。
- 恢复幂等：重复扫描不重复关闭尝试、不重复创建执行、不重复推送同一 `requestId`。
- 降级：数据库不可用时新执行不裸跑；等待持久化失败仍可正常审批；DB 时钟异常跳过并告警。
- 回归：既有提问 / 审批 / 超时 / 取消用例、任务生命周期、崩溃恢复、Session 列表与 `mao task get` 全部通过。
- 构建：`backend-ts npm test`、`backend-ts npm run build`、`admin npm run build`、`desktop npm run build`。

## 12. 上线与回滚

- 配置开关：`EXECUTION_WAIT_PERSISTENCE_ENABLED`、`EXECUTION_LEASE_ENABLED`，默认关闭；按“先等待持久化、再租约、最后恢复扫描”的顺序开启。
- 首次开启前排空旧实例；旧版本不写租约，灰度期间不启用兜底恢复扫描。
- 回滚只关闭开关，不删表、不回填；已写入的 `PENDING` 等待在关闭后不再参与恢复，任务仍保留 `BLOCKED`，由用户取消或后续版本收敛。
- 上线后观察 `wait_persist_failed`、`lease_acquired`、`lease_lost`、`wait_recovered`、`wait_expired` 与恢复耗时；异常时先关闭恢复扫描，再关闭租约。
