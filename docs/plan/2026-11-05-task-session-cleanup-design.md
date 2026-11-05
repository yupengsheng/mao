# 任务域会话删除回收设计

## 背景

`agent_task` 以 `session_id` 归属会话，`agent_task_execution` 与 `agent_task_trigger` 也冗余保存同一 `session_id`。任务查询已经通过 `EXISTS (... session.deleted = 0)` 隐藏已删除会话的任务，但删除会话时并没有回收这三张表，历史执行与入口记录会永久残留。

边路任务提升为普通会话时，会插入新主会话并逻辑删除旧边路会话。该路径不经过 `onSessionDeleted`，因此即使后续补上普通删除钩子，也仍会漏掉边路提升。

## 目标

- 普通会话删除后，事务内回收该会话的任务主档、执行记录与入口记录。
- 边路任务提升后，在同一提升事务内回收旧边路会话的任务域。
- 任务主档保留逻辑删除标记；执行与入口记录物理删除，避免继续占用空间。
- 清理失败只告警，不阻断会话删除或其他会话级资源回收。
- 删除时按 `session_id` 一次覆盖，历史孤儿也能一并收敛。

## 非目标

- 不把任务历史迁移到新会话；边路提升后的新主会话从下一次执行起重新建立任务。
- 不为已删除会话做一次性数据回填或后台孤儿修复。
- 不改变任务列表、详情、修复 Job 或 90 天执行清理的既有语义。
- 不删除会话消息、用量、审计、通知或开放接口调用流水。

## 实现

### 仓储回收

`TaskRepository.deleteBySessionId(sessionId)` 在调用方事务内执行：

```sql
DELETE FROM agent_task_trigger WHERE session_id = ?;
DELETE FROM agent_task_execution WHERE session_id = ?;
UPDATE agent_task
   SET deleted = 1, updated_at = CURRENT_TIMESTAMP
 WHERE session_id = ? AND deleted = 0;
```

先删子记录，再逻辑删除主档。`TaskService.deleteBySessionId()` 负责开启事务并忽略非法内部 ID；仓储方法本身不嵌套事务，便于边路提升直接复用现有事务连接。

### 普通会话删除

`create-app.ts` 的 `onSessionDeleted` 回调调用 `TaskService.deleteBySessionId(sessionId)`。该步骤单独捕获异常并告警，不阻断定时任务、消息队列、工作区规则、通道映射和 Webhook 绑定的既有清理。

### 边路任务提升

`SessionService.promoteSideTaskToMainSession()` 在既有事务内通过 `new TaskRepository(tx).deleteBySessionId(sideSessionId)` 回收旧边路会话的任务域。任务主档不会复制到新会话，任务执行历史也不会被改写归属。

### 索引

`agent_task_trigger` 原有索引只覆盖 `task_id` 与 `source_event_id`，新增 V195 迁移：

```sql
ALTER TABLE agent_task_trigger
  ADD INDEX idx_agent_task_trigger_session (session_id),
  ALGORITHM=INPLACE, LOCK=NONE;
```

`agent_task` 有 `UNIQUE(session_id)`，`agent_task_execution` 已有 `(session_id, created_at)` 索引，无需额外索引。

## 边界

- 只有非运行态会话可以删除；普通删除路径不会与正在执行的 `beginExecution` / `settleExecution` 竞争同一会话。
- 普通删除钩子在会话逻辑删除后执行；任务清理失败时会话仍保持已删除，任务查询因关联会话不存在而继续隐藏残留记录。
- 边路提升任务清理与提升操作同事务：任一步失败都会回滚，不会出现旧边路会话已删除但任务仍可查询的半完成状态。
- 已删除会话的历史残留不做批量回填；后续没有新的删除事件时不会自动清理。
- `agent_task` 逻辑删除后不会复用同一 `session_id` 重建任务记录，符合会话 ID 不复用的前提。

## 测试

- 仓储按顺序删除 Trigger、Execution，并条件逻辑删除 Task，参数均为会话 ID。
- `TaskService` 在事务中调用仓储回收；非法会话 ID 不发起写操作。
- 边路提升在同一事务内回收旧会话的三类任务记录。
- 现有普通会话删除、待办回收、通道映射回收与任务查询用例保持通过。
