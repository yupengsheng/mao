# 边路提升会话级资源改绑设计

## 背景

`promoteSideTaskToMainSession()` 的语义是「插入新主会话 + 逻辑删除旧边路会话」。它会复制消息、文件变更、待办、定时任务等业务数据，但不经过 `SessionService.deleteSession()`，也不会触发 `onSessionDeleted` 钩子。

会话删除路径已经回收或改绑了大部分以 `session_id` 归属的资源，但两处仍有遗漏：

- `approval_rule`（`scope = 'SESSION'`）记录用户对 shell / MCP 调用的「总是允许」选择。提升后旧 `session_id` 不可达，规则成为永久孤儿，新主会话又失去用户此前批准的放行能力，表现为同一任务继续执行时重复弹审批。
- `webhook_trigger.session_id` 可能绑定旧边路会话。提升后触发器继续指向已删除会话，下次触发只能走「首次失败 → 自动解绑 → 按新会话重试」的自愈路径，白白产生一次失败流水，且不会延续原任务。

## 目标

- 提升事务内把会话级审批规则改绑到新主会话。
- 提升事务内把绑定旧边路会话的 Webhook 触发器改绑到新主会话。
- 改绑失败随提升事务整体回滚，不留下半完成状态。
- 不改动会话删除路径已有的「清空绑定 / 删除规则」语义。

## 非目标

- 不改 USER 级审批规则；它们本就跨会话生效。
- 不改触发器停用、连续失败计数或限流语义；改绑不重置这些字段。
- 不复制或清理 MCP 内存快照；新主会话在下一轮执行时按既有逻辑重建。
- 不新增数据库迁移；`approval_rule(session_id)` 与 V194 的 `webhook_trigger(session_id)` 索引已覆盖条件更新。

## 实现

在 `promoteSideTaskToMainSession()` 的事务内、逻辑删除旧会话之前执行：

```sql
UPDATE approval_rule
SET session_id = ?
WHERE scope = 'SESSION' AND session_id = ?;

UPDATE webhook_trigger
SET session_id = ?
WHERE session_id = ?;
```

参数均为 `[targetId, sideSessionId]`。新主会话刚创建，尚无会话级规则或触发器绑定，不会产生唯一性冲突。

## 边界

- 提升前置校验要求旧边路会话已停止运行；用户级规则不受影响。
- 触发器改绑后仍保持原 `agent_id`。提升保留 `source.agentId`，因此触发器与目标会话的 Agent 一致性不变。
- 若目标会话在极短时间内被删除，后续仍由既有 Webhook 自愈与审批规则删除路径收敛。
- 新旧会话 ID 不同，外部若缓存了旧 `sessionId`，按既有删除语义得到会话不存在；不额外做兼容。

## 测试

- session：提升事务内以 `[targetId, sideSessionId]` 改绑 `SESSION` 审批规则。
- session：提升事务内以 `[targetId, sideSessionId]` 改绑绑定旧会话的 Webhook 触发器。
- 既有提升用例继续覆盖消息复制、待办、定时任务、通知抑制、任务记录与消息队列回收。
