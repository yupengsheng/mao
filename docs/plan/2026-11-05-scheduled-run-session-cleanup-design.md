# 定时任务随会话删除与边路提升收口设计

## 背景

会话删除时 `ScheduledTaskDbStore.deleteBySessionId()` 只把 `scheduled_task` 置为 `deleted = 1`，属于该会话的 `scheduled_task_run` 仍可能停在 `QUEUED` 或「已认领但未开跑」的 `RUNNING`（`started_at IS NULL`）。任务被软删后，队列不会再消费这些行，启动对账与安全网也会因 `selectById(taskId)` 查不到任务而跳过，最终只能等 90 天历史清理。删除会话后不应留下长期非终态的运行记录。

边路任务提升同样不经过 `onSessionDeleted`。若边路会话内创建过定时任务，提升后任务仍绑定旧边路会话：任务列表可见，但每次触发都因会话已删除而失败。定时任务应以新主会话为执行载体继续存在，未开始的旧运行记录则必须取消。

## 目标

- 会话删除时，在同一事务内软删该会话的定时任务并收口其运行记录。
- 边路任务提升时，在同一事务内取消旧边路会话未开始的运行记录，并把未删除的定时任务改绑到新主会话。
- `QUEUED` 与 `RUNNING AND started_at IS NULL` 置为 `CANCELLED`，写入 `finished_at` / `error_summary='会话已删除'`，清空 `next_retry_at`。
- 已开跑（`started_at IS NOT NULL`）的 `RUNNING` 行不在这里取消，继续由会话终态、执行收尾与安全网收敛。
- 所有遗留的 `next_retry_at` 一并清空，避免任务被人工恢复后补打旧档期。

## 非目标

- 不物理删除运行历史；90 天保留期与清理 Job 不变。
- 不改变定时任务删除端点、暂停、重试与错过补偿的既有语义。
- 不处理已删除任务的历史 `COMPLETED` / `FAILED` / `CANCELLED` 行。
- 不迁移已终态运行记录到新主会话：历史按实际执行会话保留。
- 不把旧边路会话已入队的消息或未开始运行重新排入新会话，直接取消。

## 实现

`ScheduledTaskDbStore.deleteBySessionId(sessionId)` 改为单事务：

```sql
UPDATE scheduled_task SET deleted = 1 WHERE session_id = ? AND deleted = 0;

UPDATE scheduled_task_run r
  JOIN scheduled_task t ON t.id = r.task_id
   SET r.status = 'CANCELLED', r.finished_at = ?, r.error_summary = '会话已删除',
       r.next_retry_at = NULL
 WHERE t.session_id = ?
   AND (r.status = 'QUEUED' OR (r.status = 'RUNNING' AND r.started_at IS NULL));

UPDATE scheduled_task_run r
  JOIN scheduled_task t ON t.id = r.task_id
   SET r.next_retry_at = NULL
 WHERE t.session_id = ? AND r.next_retry_at IS NOT NULL;
```

公共函数 `cancelOpenRunsForSession(db, sessionId, reason)` 负责上面两条运行记录更新，接收调用方事务连接：普通删除传「会话已删除」，边路提升传「边路任务已提升」。

边路提升在 `SessionService.promoteSideTaskToMainSession()` 的既有事务内先取消旧会话未开始的运行，再执行：

```sql
UPDATE scheduled_task
   SET session_id = ?
 WHERE session_id = ? AND deleted = 0;
```

迁移 V196 增加 `scheduled_task(session_id)` 与 `scheduled_task_run(session_id, status)` 索引：前者服务会话删除 / 提升回收，后者服务会话终态对账 `listOpenRunsBySession()`。

## 竞态

- 执行已进入 `withSessionLock` 且读到已删任务：`latest == null` 直接返回，运行行由本事务取消。
- 执行已开跑：会话删除通常会被 `RUNNING` 相位拒绝；即使竞态发生，执行收尾仍会回写运行行终态。
- 删除事务失败：整体回滚，任务与运行记录保持原状态，不影响会话删除钩子的其他清理。

## 测试

- 存储层用例断言事务内三条 SQL 的顺序、参数与会话 ID。
- 边路提升用例断言运行取消原因为「边路任务已提升」，且任务 `session_id` 从旧会话改绑到新主会话 ID。
- 现有定时任务可靠性、会话删除与通知抑制用例保持通过。
