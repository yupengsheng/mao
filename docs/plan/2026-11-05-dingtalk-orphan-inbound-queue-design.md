# 钉钉入站队列孤儿行清理设计

## 背景

`dingtalk_inbound_queue` 以 `session_id` 归属会话，保存排队中的用户消息。会话删除只做逻辑删除，不会立即改写或删除队列表。服务启动时 `DingtalkTaskQueueService.hydrate()` 会恢复所有 `QUEUED` / `RUNNING` 行，并把对应 `sessionId` 交给 handler 排空。

如果这些行指向已不存在或已逻辑删除的会话，重启后仍会尝试执行，出现无意义的 `SESSION_NOT_FOUND` 失败与日志噪声；消息本身也不应再投递给已删除会话。

## 目标

- 启动恢复前删除指向不存在 / 已逻辑删除会话的队列行。
- 存活会话（含已归档、未删除）的队列行保持原恢复语义：
  - `RUNNING` 且消息已落库 → 删除队列行，交给崩溃恢复从历史重放；
  - `RUNNING` 且消息未落库 → 复位为 `QUEUED` 后重新消费。
- 孤儿清理失败只告警，不阻断存活会话的队列恢复。

## 实现

### 仓库

`DingtalkInboundQueueRepository.deleteOrphanedBatch(limit)`：

```sql
DELETE FROM dingtalk_inbound_queue WHERE id IN (
  SELECT id FROM (
    SELECT q.id
    FROM dingtalk_inbound_queue q
    LEFT JOIN `session` s ON s.id = q.session_id
    WHERE s.id IS NULL OR s.deleted = 1
    ORDER BY q.id
    LIMIT ?
  ) AS stale
)
```

批量上限 5000，入参做正整数夹取。

### 启动恢复

`hydrate()` 在读取 `RUNNING` 行之前循环清理孤儿行，每批 5000、单轮最多 20 批。清理完成后继续原有恢复流程并返回仍有待消费行的 `sessionId` 集合。

清理异常只记录 warning 并继续恢复，避免单次清理失败导致合法排队消息无法恢复。

## 边界

- 不改变入队、认领、跳队首、取消与卡片回调语义。
- 归档会话（`deleted = 0`）仍会恢复，不按归档状态清理。
- 不新增数据库迁移；复用现有 `(session_id, status, rank_no)` 索引与主键扫描。
- 会话删除路径的即时队列回收不在本次范围；孤儿行最迟在下一次启动恢复时清除。

## 测试

- repository：SQL 带 `LEFT JOIN session` 与 `s.id IS NULL OR s.deleted = 1`，批量上限夹取。
- service：先清理再读取 `RUNNING`；长批次持续清理到短批次；清理失败仍继续恢复。
