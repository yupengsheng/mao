# 会话分享链接随会话删除撤销

## 背景

`session_share` 以 `session_id` 归属会话。读取路径会校验会话仍存在且未逻辑删除，因此删除会话后链接已经 404；但行上的 `revoked_at` 仍为 `NULL`，形成“业务不可达、数据仍活跃”的孤儿分享记录。会话 id 为自增不复用，当前没有直接越权风险，但会让分享状态与审计语义不一致，也增加后续清理/统计的歧义。

## 目标

- 删除会话时，把该会话所有未撤销分享行显式置为已撤销。
- 边路任务提升时，旧边路会话随后逻辑删除，同一事务内撤销其分享链接。
- 通过迁移回填历史已删除会话留下的未撤销分享行。
- 不改变分享读取协议：会话已删除时仍返回 404；无需新增接口。

## 方案

1. `MysqlSessionShareRepository` 增加 `revokeBySession(sessionId)`：  
   `UPDATE session_share SET revoked_at = ? WHERE session_id = ? AND revoked_at IS NULL`。
2. 会话删除的 `onSessionDeleted` 钩子调用上述方法；失败只记日志，不阻断会话删除及其他资源清理。
3. 边路提升事务内执行同一语义的 `UPDATE`，与旧会话逻辑删除同事务提交。
4. `V197__revoke_share_with_deleted_sessions.sql` 使用 `LEFT JOIN session` 回填：目标会话不存在或 `deleted = 1` 且尚未撤销的行写入 `revoked_at`。

## 兼容性

- 已撤销行不重复更新（`revoked_at IS NULL`）。
- 分享读取、创建、刷新、显式撤销接口行为不变。
- 历史回填只影响不可读取的分享行，不影响有效会话的分享链接。
