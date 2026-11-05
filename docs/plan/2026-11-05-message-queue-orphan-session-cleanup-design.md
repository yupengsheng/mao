# 消息队列孤儿 PENDING 清理设计

## 背景

`message_queue` 以 `session_id` 归属会话，保存会话忙时排队的用户消息。会话删除路径此前只清理定时任务、MCP 快照、工作区规则和通道映射，没有处理 `message_queue`；现有清理 Job 也只删除超过 30 天的 `status = 'DELETED'` 终态行。

因此会话删除后，尚未消费的 `PENDING` 行会永久残留。它们不会再被合法会话消费，却持续占用存储；如果后续新增全局队列扫描，还可能被误投递到已删除会话。

## 目标

- 删除会话时立即把该会话的 `PENDING` 队列行置为 `DELETED`。
- 每小时补扫会话已不存在或已逻辑删除的 `PENDING` 行，覆盖历史残留与删除后并发入队的竞态。
- 单批最多处理 5000 条，单轮最多 20 批，避免长事务和大范围锁。
- 仍然保留终态行 30 天供排障，之后沿用现有终态清理。
- 有效会话（含归档未删除）的 `PENDING` 行不受影响。
- 清理失败只记录日志，不阻断进程启动、会话删除或其它清理任务。

## 非目标

- 不改变入队、出队、排序、队列列表接口或消费语义。
- 不物理删除会话删除时命中的 `PENDING` 行；统一转为终态，保留既有排障窗口。
- 不按用户、来源或队列内容调整保留期。
- 不新增数据库迁移；现有 `idx_message_queue_updated(status, updated_at, id)` 可支撑扫描。

## 实现

### 会话删除即时回收

`SessionService.deleteSession()` 在逻辑删除会话后调用 `onSessionDeleted`。`create-app.ts` 通过延迟解引用的 `ctx.clearSessionMessageQueue` 调用 `MessageQueueService.clear(sessionId)`，执行：

```sql
UPDATE message_queue
SET status = 'DELETED'
WHERE session_id = ? AND status = 'PENDING' AND deleted = 0
```

`MessageQueueService` 构造晚于 `SessionService`，因此继续沿用 `AppContext` 延迟注入模式，避免调整大段装配顺序。

### 边路任务提升即时回收

边路任务提升是「插入新主会话 + 逻辑删除旧边路会话」，不经过 `onSessionDeleted`。因此 `SessionService.promoteSideTaskToMainSession()` 在同一事务内复用同一条件更新，把旧边路会话的 `PENDING` 行置为 `DELETED`，与删除会话保持同一终态语义。旧边路会话的排队消息不会被复制到新主会话，避免提升后重复执行用户已排队但尚未发送的内容。

### 每小时孤儿修复

`MessageQueueCleanup.cleanupOnce()` 先调用 `clearOrphanedPendingBatch(limit)`，把不存在或已逻辑删除会话的 `PENDING` 行转为终态：

```sql
UPDATE message_queue
SET status = 'DELETED'
WHERE status = 'PENDING' AND deleted = 0
  AND NOT EXISTS (
    SELECT 1 FROM `session` s
    WHERE s.id = message_queue.session_id AND s.deleted = 0
  )
ORDER BY updated_at, id
LIMIT n
```

`n` 钳制在 `1..5000`。扫描顺序与 `idx_message_queue_updated(status, updated_at, id)` 一致，会话存在性检查走主键。孤儿收敛完成后，同一轮继续沿用 `deleteTerminalBatch(cutoff, limit)` 删除超过 30 天的终态行。

孤儿收敛与终态删除分别捕获异常：任一阶段失败都不会阻断另一阶段；下一小时继续幂等重试。

## 边界

- 归档会话仍是未删除会话，其 `PENDING` 行保留。
- 会话删除后新入队的竞态行最迟在下一小时被补扫为终态，不会永久停留。
- 被补扫的行不会立即物理删除，仍需超过 30 天；期间管理排查仍可看到队列内容。
- 多实例同时执行更新是幂等的；条件相同的重复更新只会让先执行者影响行数非零。
- 会话正在运行时仍由原删除守卫拒绝删除，本改动不放宽运行中会话的删除条件。

## 测试

- repository：只命中会话不存在 / 已逻辑删除的 `PENDING` 行，保留有效会话，校验排序与 `LIMIT` 钳制。
- cleanup：先收敛孤儿再删终态、两阶段各自分批、单轮 20 批上限、异常隔离与累计计数。
- session：会话逻辑删除后触发 `onSessionDeleted`，确保装配层具备即时回收时机。
- session：边路任务提升事务内命中旧边路会话的 `PENDING` 行，且只更新 `status = 'PENDING' AND deleted = 0`。
