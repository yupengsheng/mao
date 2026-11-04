# 持久化执行恢复与旧尝试收敛技术方案

## 目标

在既有崩溃恢复链路中补齐任务执行记录语义：每次自动续跑都登记为新的执行尝试，并把同一任务中因进程中断而遗留的 `WORKING` / `BLOCKED` 尝试失败关闭。恢复仍然复用现有 `CrashRecoveryRunner`，不新增执行队列、数据库租约或任务状态。

## 范围

- 自动续跑范围保持 `RUNNING` / `RESUMING`，与现有崩溃恢复调度一致。
- `WAITING_APPROVAL` / `CANCELLING` 不在本期自动续跑范围内；提问、审批等待仍只存在于内存，进程重启后不恢复。
- 排队消息消费规则不变；恢复开始后仍由原有执行链路消费队列。
- 不新增数据库迁移、Task 状态或公开接口。历史任务不回填。

## 恢复登记

`CrashRecoveryRunner` 在调用 `HarnessService.execute` 前，通过 `TaskTerminalService.beginRecoveryExecution(sessionId, executionId)` 登记恢复尝试：

1. 先把 `executionId` 写入运行时 Registry，使没有 WS Listener 的恢复执行也能投影提问/审批等待状态。
2. 再持久化任务尝试。持久化失败只记录日志，不阻断恢复；此时仍沿用原有执行与通知行为。
3. 后续 `finishExecution` 使用同一个 `executionId`，确保开始与终态归属同一次尝试。

## 持久化事务

`TaskService.beginRecoveryExecution` 在单个事务内执行：

1. 锁定 Session 行，按会话取用户与任务，避免并发恢复重复登记。
2. 若相同 `executionId` 已存在，校验归属后幂等返回，不新增尝试、不改旧尝试。
3. 查询该任务所有 `WORKING` / `BLOCKED` 执行，统一更新为 `FAILED`，写入 `finishedAt` 和固定原因：`执行因进程中断未完成，已自动恢复`。
4. 创建新的 `WORKING` 尝试，`attemptNo` 在任务当前最大编号上递增，`startedAt` 使用当前时间。
5. 将 Task 更新为 `WORKING`，`lastExecutionId` 指向恢复尝试，并刷新标题与 Agent。

若已有尝试的终态在恢复后迟到，仍沿用 `attemptNo` 判定：旧尝试不会覆盖新恢复尝试的 Task 状态。

## 来源规则

恢复尝试来源优先沿用被中断尝试的最高 `attemptNo` 对应 Trigger；取不到 Trigger 时按 Session 来源推断，保持与普通执行相同的 `MANUAL` / `SIGNAL` / `FEISHU` / `WEIXIN` / `DINGTALK` 规则。恢复不根据消息内容或可写字段反推来源。

## 多实例边界

本次没有数据库级执行租约。多实例同时恢复同一会话时，Session 行锁只能保证登记串行，不能单独阻止两个进程都启动业务执行。现有部署排空、静默阈值与恢复调度约束仍是唯一并发保护；后续若需要强一致单跑，应单独设计租约或分布式锁，不能把本次登记语义当作互斥保证。

## 测试

- 旧 `WORKING` / `BLOCKED` 尝试被统一失败关闭，并写入固定原因与结束时间。
- 新恢复尝试编号递增、`startedAt` 非空，Task 指向新执行。
- 来源沿用最高编号旧尝试的 Trigger；无 Trigger 时按 Session 推断。
- 相同恢复 `executionId` 幂等，不重复关闭或新增。
- 旧尝试迟到终态不覆盖新恢复尝试。
- 无旧尝试时允许创建首次恢复记录。
- 桥接层先写 Registry 再持久化；持久化失败仍保留 Registry ID。
- 恢复登记在 Harness 执行前调用且 ID 一致；登记异常不阻断续跑。

## 文档同步

更新根 `CHANGELOG.md`、`README.md`、`skills/mao-cli/reference/task.md` 与 `skills/mao-cli/reference/deploy.md`，删除“旧尝试仍可能保留未结算状态”的旧描述。
