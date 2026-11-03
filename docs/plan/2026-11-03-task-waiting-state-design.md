# 执行任务等待状态技术方案

## 目标

在已有执行记录中接入待答提问与工具审批：任一请求挂起时，Task 及本次执行显示 `BLOCKED`；所有请求结束后回到 `WORKING`。用户可在执行记录和 `mao task list --stage BLOCKED` 中找到等待处理的任务，再打开关联会话处理。

## 实现边界

- 沿用 V179 和共享 `TaskStage`，不新增表、接口或模型调用。
- 只更新已登记开始且仍在途的本次执行；未接入开始登记的路径仍在终态补建，不因提问或审批凭空创建执行记录。
- 等待集合只保存请求类型、请求 ID 和登记时的 executionId，不保存问题正文、审批参数或答案。
- 保留现有审批、回答、取消与超时语义。任务状态投影失败仅记日志，不阻断这些操作。
- 本期不提供重启后的等待恢复、状态修复 Job 或自动回答/审批。

## 状态投影

`ApprovalRegistry` 和 `AskUserQuestionsRegistry` 向窄接口 `TaskWaitObserver` 报告请求开始/结束。`TaskWaitService` 在开始事件同步捕获 WS Registry 中的 executionId，按会话和请求维护等待集合，按会话串行提交状态。结束事件使用开始时绑定的 ID，避免旧请求结束时误改新一轮执行。

同一执行的提问与审批合并计数，重复登记和重复移除幂等。回答、审批通过/拒绝、取消及超时均释放对应请求；仍有其他请求时保持 `BLOCKED`。

`TaskService.setExecutionStage` 在现有事务中先锁所属 Session，然后校验：

1. Session 仍有效且属于原用户，阶段为 RUNNING / RESUMING / WAITING_APPROVAL。
2. Task 和执行已经存在，执行确实属于该 Task 和 Session。
3. executionId 等于 Task.lastExecutionId，执行尚未结算。

只在阶段实际变化时更新执行及 Task，不改尝试编号、来源和开始/结束时间。取消中、终态、未登记或旧执行的回调直接忽略。终态结算继续由原有 TaskTerminalService 收敛。

## 开发顺序与验证

1. 为状态更新补失败用例，覆盖等待/恢复、终态保护、迟到旧执行和无开始记录。
2. 实现等待聚合与串行投影，覆盖混合等待、重复回调、快速回答、存储异常和新旧执行交错。
3. 接入两个 Registry，验证回答、取消、审批结束和超时的释放行为。
4. 同步 README、CHANGELOG 和 mao-cli 使用说明。
5. 运行后端针对性测试、全量测试及构建；验证既有执行记录页面和共享契约仍可构建。

现有页面每 10 秒刷新，`BLOCKED` 已有「等待处理」文案和筛选项，本期复用该行为。

## 验证结果

- 针对性回归：任务生命周期、真实提问/审批 Registry、等待投影与本地工具执行，共 87 项通过；新增等待相关用例 22 项。
- 后端全量 `npm test`：448 个测试文件通过、1 个跳过；5,286 项通过、13 项跳过。
- 后端与 desktop 均通过 `npm run build`。
- 等待投影集成用例使用真实 TaskService、TaskWaitService 和 Registry，数据库端口由内存替身实现；本期未做真实 MySQL 并发验证，也未部署线上。
