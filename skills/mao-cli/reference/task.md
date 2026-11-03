# 执行任务记录

本功能提供本人任务的只读追踪。需使用用户 JWT，`mao_` 开放接口 Token 不可用于查询。任务在 Session 实际开始执行或收到终态时惰性创建；当前一个 Session 对应一个 Task，多次执行累计记录。历史会话不批量回填，仅进入等待队列的请求还没有 Task。

Harness 统一登记普通/事件执行、已准备上下文的子代理执行、边路首消息和既有崩溃恢复执行。飞书、钉钉、微信通道运行时即可在记录中查看，不必等到终态。明确的执行来源保持不变，重复开始回调不会增加尝试。缺少真实执行 ID 或开始持久化失败时，仍可能只有终态补建记录。

## 桌面 / Web 页面

登录后点顶栏时钟图标「执行记录」，或打开 `/execution-records`。可按状态、首次来源筛选并分页；选择任务后查看最近 50 次执行、实际来源、开始/结束时间和失败原因。开始时间未记录表示这次尝试只有终态登记。

页面可见时每 10 秒刷新，恢复可见时立即刷新，也可手动刷新。加载失败可原地重试。「打开关联会话」回到对应会话；边路任务定位到根会话页签，子代理以只读页签打开。任务记录页只读，执行操作仍在原有会话中进行。

状态筛选「等待处理」对应 BLOCKED：当前执行有待答提问或工具审批。打开关联会话回答或审批后，所有等待请求结束才恢复为执行中；拒绝审批、取消请求和超时也会释放对应等待，最终执行结果由原有运行链路决定。

## CLI

```bash
mao task list --stage WORKING --page 1 --size 20
mao task list --stage BLOCKED
mao task list --source API --agent-id 1 --session-id 2
mao task get --id 1
```

| 参数 | 说明 |
| --- | --- |
| --stage | QUEUED / WORKING / BLOCKED / FAILED / COMPLETED / CANCELLED |
| --source | MANUAL / SCHEDULED / WEBHOOK / API / SIGNAL / FEISHU / WEIXIN / DINGTALK；按任务首次来源过滤 |
| --agent-id、--session-id | 可选正整数 |
| --page、--size | 正整数，默认 1 / 20，size 最大 100 |

QUEUED 为事务内初始化状态。WORKING 表示执行中，BLOCKED 表示等待提问回答或工具审批；仅对已登记开始且执行 ID 仍在途的执行投影等待状态。无 WS Listener 的直接事件执行也登记在途 ID。缺少开始记录时仍在终态补建，不会仅因提问/审批创建执行记录。等待请求在内存中管理，本期不提供后端重启后的提问/审批等待恢复或记录自动修复。

## REST

- `GET /api/v1/tasks?stage=WORKING&page=1&size=20`，返回 Result.data：`{ items, total, page, size }`。参数与 CLI 相同，Agent/Session 参数名为 agentId、sessionId。按更新时间、ID 倒序。
- `GET /api/v1/tasks/:id`，返回 Result.data：`{ task, latestExecution, executions, triggers }`。执行和入口各最多最近 50 条。
- 不存在/他人任务按既有 Result 业务错误返回 code=404。查询不接受用 userId 切换所有者。关联 Session 删除或转交后旧任务不可见。

Task.source 是首次来源；triggers 中的 source 是对应执行实际来源。当前 sourceEventId 等于 executionId，仅对同一次执行登记去重，不能据此识别上游重新投递的同一消息。

没有任务创建、取消、重试、改派命令；执行仍走原有会话功能。当前无跨渠道归并或记录自动修复 Job。任务持久化失败会记录日志并保留原有执行，可能导致任务记录缺失或状态滞后；收到重复终态时会再尝试结算。仅在终态补建的尝试 startedAt 为空，编号代表登记顺序。

飞书、钉钉在无内存循环但会话仍执行中时补写取消，优先使用在途 ID，再查询本人 Task 最新未结算的执行 ID，以取消原尝试。只有没有可用记录或查询失败时才使用新的随机 ID，已结束会话不生成取消尝试。现有崩溃恢复会登记新一次执行；被崩溃中断的旧尝试仍可能保留未结算状态，本期不批量修复。

部署需应用 V179 迁移；正常使用现有 `FLYWAY_ENABLED` 迁移流程即可。
