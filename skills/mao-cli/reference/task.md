# 执行任务记录

本功能提供本人任务的只读追踪。需使用用户 JWT，`mao_` 开放接口 Token 不可用于查询。任务在 Session 实际开始执行或收到终态时惰性创建；当前一个 Session 对应一个 Task，多次执行累计记录。历史会话不批量回填，仅进入等待队列的请求还没有 Task。

## 桌面 / Web 页面

登录后点顶栏时钟图标「执行记录」，或打开 `/execution-records`。可按状态、首次来源筛选并分页；选择任务后查看最近 50 次执行、实际来源、开始/结束时间和失败原因。开始时间未记录表示这次尝试只有终态登记。

页面可见时每 10 秒刷新，恢复可见时立即刷新，也可手动刷新。加载失败可原地重试。「打开关联会话」回到对应会话；边路任务定位到根会话页签，子代理以只读页签打开。任务记录页只读，执行操作仍在原有会话中进行。

## CLI

```bash
mao task list --stage WORKING --page 1 --size 20
mao task list --source API --agent-id 1 --session-id 2
mao task get --id 1
```

| 参数 | 说明 |
| --- | --- |
| --stage | QUEUED / WORKING / BLOCKED / FAILED / COMPLETED / CANCELLED |
| --source | MANUAL / SCHEDULED / WEBHOOK / API / SIGNAL / FEISHU / WEIXIN / DINGTALK；按任务首次来源过滤 |
| --agent-id、--session-id | 可选正整数 |
| --page、--size | 正整数，默认 1 / 20，size 最大 100 |

QUEUED 为事务内初始化状态，BLOCKED 为预留；本期只记录 WORKING 和执行终态，不与待答提问/工具审批联动。

## REST

- `GET /api/v1/tasks?stage=WORKING&page=1&size=20`，返回 Result.data：`{ items, total, page, size }`。参数与 CLI 相同，Agent/Session 参数名为 agentId、sessionId。按更新时间、ID 倒序。
- `GET /api/v1/tasks/:id`，返回 Result.data：`{ task, latestExecution, executions, triggers }`。执行和入口各最多最近 50 条。
- 不存在/他人任务按既有 Result 业务错误返回 code=404。查询不接受用 userId 切换所有者。关联 Session 删除或转交后旧任务不可见。

Task.source 是首次来源；triggers 中的 source 是对应执行实际来源。当前 sourceEventId 等于 executionId，仅对同一次执行登记去重，不能据此识别上游重新投递的同一消息。

没有任务创建、取消、重试、改派命令；执行仍走原有会话功能。当前无跨渠道归并或自动恢复 Job。任务持久化失败会记录日志并保留原有执行，可能导致任务记录缺失或状态滞后；收到重复终态时会再尝试结算。仅在终态补建的尝试 startedAt 为空，编号代表登记顺序。

部署需应用 V179 迁移；正常使用现有 `FLYWAY_ENABLED` 迁移流程即可。
