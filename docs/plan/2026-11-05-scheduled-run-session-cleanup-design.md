# 定时任务运行记录随会话删除收口设计

## 背景

会话删除时 `ScheduledTaskDbStore.deleteBySessionId()` 只把 `scheduled_task` 置为 `deleted = 1`，属于该会话的 `scheduled_task_run` 仍可能停在 `QUEUED` 或「已认领但未开跑」的 `RUNNING`（`started_at IS NULL`）。任务被软删后，队列不会再消费这些行，启动对账与安全网也会因 `selectById(taskId)` 查不到任务而跳过，最终只能等 90 天历史清理。删除会话后不应留下长期非终态的运行记录。

## 目标

- 会话删除时，在同一事务内软删该会话的定时任务并收口其运行记录。
- `QUEUED` 与 `RUNNING AND started_at IS NULL` 置为 `CANCELLED`，写入 `finished_at` / `error_summary='会话已删除'`，清空 `next_retry_at`。
- 已开跑（`started_at IS NOT NULL`）的 `RUNNING` 行不在这里取消，继续由会话终态、执行收尾与安全网收敛。
- 所有遗留的 `next_retry_at` 一并清空，避免任务被人工恢复后补打旧档期。

## 非目标

- 不物理删除运行历史；90 天保留期与清理 Job 不变。
- 不改变定时任务删除端点、暂停、重试与错过补偿的既有语义。
- 不处理已删除任务的历史 `COMPLETED` / `FAILED` / `CANCELLED` 行。

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

迁移 V196 增加 `scheduled_task(session_id)` 与 `scheduled_task_run(session_id, status)` 索引：前者服务会话删除回收，后者服务会话终态对账 `listOpenRunsBySession()`。

## 竞态

- 执行已进入 `withSessionLock` 且读到已删任务：`latest == null` 直接返回，运行行由本事务取消。
- 执行已开跑：会话删除通常会被 `RUNNING` 相位拒绝；即使竞态发生，执行收尾仍会回写运行行终态。
- 删除事务失败：整体回滚，任务与运行记录保持原状态，不影响会话删除钩子的其他清理。

## 测试

- 存储层用例断言事务内三条 SQL 的顺序、参数与会话 ID。
- 现有定时任务可靠性、会话删除与通知抑制用例保持通过。
