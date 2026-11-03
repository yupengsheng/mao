# 任务执行入口与取消身份技术方案

## 目标与顺序

继续完善已落地的任务记录、执行记录页面和等待状态。先统一实际执行入口的开始登记，并让通道取消沿用真实执行 ID，为后续外部事件、任务路由和恢复治理提供可核对的执行历史。

## 开始登记

在 HarnessService 的普通执行、事件执行、已准备上下文执行和边路首消息执行入口调用统一的开始桥接。事件入口直接使用 eventId；其他入口读取调用前已由 WsStreamingEventListener 登记的 executionId。飞书、钉钉、微信、子代理、边路与崩溃恢复均走这些入口，不在每个通道分别添加数据库逻辑。

保留 WS、开放接口和定时任务已有的开始回调，以保留显式来源；重复登记仍由 TaskService 幂等处理，不新增尝试或覆盖首次来源。开始桥接将 ID 登记到运行时 Registry，使没有 WS Listener 的直接事件执行也可关联提问等待。

登记在上下文装配或 AgentLoop 前完成。Task 记录失败仅记日志，仍执行原有任务。单独读取/装配上下文不会生成执行记录；缺少真实 ID 时跳过登记，不臆造一个开始 ID。

## 通道取消

飞书、钉钉处理「无内存循环但 Session 仍执行中」时，原先用随机或固定 ID 补写 CANCELLED。接入开始登记后，这会留下旧尝试执行中并额外生成一个取消尝试。

改由 TaskTerminalService.cancelActiveExecution 依次选择：运行时 ID、本人 Task 当前尚未结算的执行 ID、无记录时的新随机 ID，然后沿用原终态链路。持久化查询失败降级到随机 ID并记日志，原取消行为继续。两个通道仍保留现有的循环/队列守卫与进度卡清理。

## 边界

- 不新增表、REST 接口、依赖或 LLM 调用，不改调度和消息准入规则。
- 历史数据不回填；已崩溃旧尝试的自动结算与修复 Job 不在本期。
- 恢复执行仍由现有 CrashRecoveryRunner 调度，本期仅登记其实际开始；不宣称实现新的持久化执行队列或重启后的提问恢复。
- 保持 Task 与 Session 一对一，来源规则和公开契约不变。

## 实施与验证

- [x] 为四类 Harness 执行入口补失败测试，验证开始时序、事件 ID、只装配不登记及记录失败不中断执行。
- [x] 在 TaskTerminalService 统一运行时 ID 登记及取消身份选择，验证无 WS 的事件执行、存储失败和空 ID。
- [x] 接通 Harness 装配及两个通道的取消入口，验证持久化 ID 回退和随机回退。
- [x] 更新 README、CHANGELOG、mao-cli 说明并完成后端测试/构建和相关前端验证。

## 验证结果（2026-11-03）

- 新增 32 项用例，覆盖 Harness、任务服务、开始/终态桥接以及两个通道的取消辅助逻辑。
- 后端全量 `npm test`：450 个文件通过、1 个跳过；5,318 项通过、13 项跳过。日志：`/tmp/mao-task-lifecycle-backend-full.log`。
- 后端和 desktop 均通过 `npm run build`。日志：`/tmp/mao-task-lifecycle-backend-build.log`、`/tmp/mao-task-lifecycle-desktop-build.log`。
- 无 WS Listener 的完整开始→等待→恢复→终态用例使用真实 TaskService、TaskTerminalService、TaskWaitService 和提问 Registry，数据库使用内存替身；未做真实 MySQL 并发或线上通道验证。
- 本期没有数据库迁移、历史回填或线上部署。
