# 文件变更随会话回收设计

## 背景

`message_file_change` 以 `session_id` 与 `message_id` 归属会话，保存工具写入文件时的路径、行数、diff 模式，以及 `before_content` / `after_content` / `patch_content` 等 `MEDIUMTEXT` 快照。

会话删除路径此前只逻辑删除 `message`，没有清理文件变更行；边路任务提升路径会把文件变更复制到新主会话，但旧边路会话的行同样保留。由于会话与消息都不可再访问，这些行成为永久孤儿，且单行体积可能很大。现有保留期 Job 也不覆盖该表。

## 目标

- 删除会话时物理删除该会话的 `message_file_change` 行。
- 边路任务提升时先复制文件变更到新主会话，再在同一事务内删除旧边路会话的行。
- 文件变更清理失败不影响会话删除；边路提升失败随事务整体回滚。
- 不新增数据库迁移；`message_file_change(session_id)` 已有索引。

## 非目标

- 不改文件变更的展示、分享、导出或 diff 生成语义。
- 不删除 `file` 表的上传实体与磁盘文件；它们可能被其他会话或用户文件管理复用。
- 不为历史已删除会话做批量回填清理。

## 实现

`FileChangeRepository` 新增：

```ts
async deleteBySession(sessionId: number): Promise<void> {
  await this.db.execute('DELETE FROM message_file_change WHERE session_id = ?', [sessionId]);
}
```

- `SessionService.deleteSession()`：在消息逻辑删除后调用，`try/catch` 记日志，不阻断后续会话删除。
- `SessionService.promoteSideTaskToMainSession()`：在当前事务的 `txFileChangeRepo` 上调用，位置在文件变更复制完成之后、旧会话逻辑删除之前。

## 边界

- 边路提升是先复制后删除；复制失败的旧行仍在，事务回滚后原会话可继续访问。
- 删除会话的消息已逻辑删除，文件变更物理删除不影响分享（分享要求会话仍存在）。
- 多实例并发删除同一会话时，`DELETE` 幂等。

## 测试

- session：删除会话调用 `deleteBySession(sessionId)`，失败不阻断删除。
- session：边路提升事务内删除旧边路会话的文件变更行。
