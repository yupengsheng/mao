# Super-agent 任务域技术方案（第一期）

## 1. 目标与范围

在现有 Session、Harness、开放接口、定时任务和 Signal 基础上增加可查询的任务执行记录，统一关联来源、执行次数与终态。第一期完成后端记录与 CLI 查询，不改变模型运行方式，不增加 LLM 调用或前端页面。

本期不包含：跨渠道任务归并、Thread 订阅、LLM Router、自动准入、持久化 Job、Watchdog、主动执行。后续演进先以本期执行记录验证任务语义，再决定是否拆分独立业务任务。

## 2. 领域模型

本期一个 Session 对应一个 AgentTask，一个 AgentTask 有多次执行尝试及对应入口记录。`session_id` 有唯一约束；不支持一个 Task 绑定多个 Session。Task 在开始执行时惰性建立；仅进入消息等待队列尚不建记录。未接入开始回调的路径在终态时补建，`startedAt` 为空。历史会话不批量回填。

任务阶段契约：`QUEUED`、`WORKING`、`BLOCKED`、`FAILED`、`COMPLETED`、`CANCELLED`。当前生命周期只对外落地 WORKING 和三种终态；QUEUED 是事务内初始化阶段，BLOCKED 预留，尚未与提问/工具审批联动。

来源契约：`MANUAL`、`SCHEDULED`、`WEBHOOK`、`API`、`SIGNAL`、`FEISHU`、`WEIXIN`、`DINGTALK`。显式执行来源优先，普通执行从 Session 推断机器人通道，否则为 MANUAL。Task.source 保留首次来源；每次执行的实际来源写入 Trigger。

## 3. 数据库与事务

迁移：`backend-ts/db/migration/V179__agent_task_domain.sql`，部署时由现有 Flyway 机制执行。

| 表 | 职责与约束 |
| --- | --- |
| agent_task | 所有者、Agent、Session、标题、阶段、首次来源、最近执行 ID；session_id 唯一 |
| agent_task_execution | execution_id 全局唯一、task_id、session_id、attempt_no、状态、开始/结束时间、失败原因 |
| agent_task_trigger | 每次执行的来源，source_event_id 唯一，本期值为 execution_id |

不存储外部消息正文或凭证。`policy_version` 仅预留，尚无策略版本功能。表之间使用逻辑关联，遵循现有仓库风格。

TaskService 的每次开始/结算都在 Db.transaction 的同一连接中，先对本人有效 Session 做 `SELECT ... FOR UPDATE`，再创建/更新三张表。这使同一 Session 的任务创建与尝试编号串行化。任一写入失败整个事务回滚；执行与入口记录的唯一约束拦截重复 ID。

Trigger 表当前只能按 execution_id 防止同一执行重复登记。它不代表上游 Webhook/IM 的原始事件，不提供外部消息重新投递去重，也不参与跨 Session 路由。

## 4. 生命周期接入

普通 WS 执行、WS 重试、开放接口无在线订阅者时的直接执行、定时任务无在线订阅者时的直接执行，会在 Harness 开始前调用 `TaskTerminalService.beginExecution`。API/Webhook/定时/Signal 的显式来源沿既有执行绑定透传，机器人来源可从 Session 推断。

`TaskTerminalService.finishExecution` 保留既有 Session 终态逻辑，然后调用 TaskService 结算执行。没有开始记录时补建一次执行和入口记录，覆盖未接入开始回调的终态路径。对于已记录的旧执行，迟到终态只结算该次尝试，不覆盖更新一次执行的 Task 状态。重复终态保留第一次结算结果，不重复生成执行记录。

任务域存储异常被桥接层记录日志，保留既有运行/通知行为。重复收到已有 Session 的终态时会再尝试结算任务记录，但本期没有自动修复 Job；持续写入失败可能导致记录缺失或状态滞后。仅有终态回调且无开始记录的执行，按终态登记顺序编号，不能据此还原真实开始顺序。

## 5. 查询 API 与 CLI

两个接口仅接受用户 JWT，不接受开放接口机器 Token。过滤与详情均以当前用户为准，并检查关联 Session 仍有效且属于该用户；Session 删除或转交后旧任务不再可见。

- `GET /api/v1/tasks`：可选 stage、source、agentId、sessionId、page、size；默认 page=1、size=20，最大 size=100，按 updated_at 和 id 倒序。返回 `{items,total,page,size}`。
- `GET /api/v1/tasks/:id`：返回 `{task,latestExecution,executions,triggers}`；执行与入口各最多最近 50 条，不返回消息正文或 Session 对象。
- 沿用 `Result<T>`；不存在或无权访问按既有业务错误约定返回 code=404。
- `mao task list` / `mao task get --id <id>` 提供相同能力。没有创建、改派、重试、取消任务的专用接口；操作执行仍走既有 Session 链路。

阶段/来源联合类型导出自 `@mao/contracts`。本期未增加前端调用和文案表。

## 6. 验证与后续

测试覆盖：任务复用与尝试编号、重复/迟到终态、终态补建、来源记录、所有权校验、查询验证、SQL 过滤与参数、事务连接使用、错误传播、任务存储失败不阻断既有 Session 终态。仓库 SQL 测试使用替身连接，不等同于真实 MySQL 并发测试；迁移需在部署验证环境实测。

后续建议按顺序验证：独立业务任务与 Session 的边界、外部原始事件去重与订阅、程序化路由与准入、持久化执行恢复。Task 记录完善之前不叠加常驻 LLM Router 或自主扩展执行。
