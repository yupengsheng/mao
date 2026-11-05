# 会话通道映射回收设计

## 背景

三类通道映射都以 `session_id` 指向 Mao 会话：

- `weixin_session_peer`：会话 → 微信对端用户，重启后按会话回复正确联系人；
- `feishu_thread_session`：飞书话题 → 会话，同时承载话题上下文水位线；
- `feishu_session_channel`：会话 → 飞书 Bot / 聊天绑定，用于回复、卡片与待命名标记。

会话删除是逻辑删除（`session.deleted = 1`）。当前 `deleteSession` 只通过 `onSessionDeleted` 回收定时任务、MCP 快照、工作区规则快照与审批规则；边路任务提升走独立事务，也不经过该钩子。因此上述映射会保留指向已删除会话的孤儿行：

- `feishu_thread_session` 是话题路由的权威映射。会话删除后继续在话题内发言，现有逻辑会直接命中已删除会话，执行期报 `SESSION_NOT_FOUND`；
- `weixin_session_peer` / `feishu_session_channel` 不再被合法读取，但会随会话删除持续累积。

## 目标

- 会话删除时立即回收该会话的三类通道映射。
- 边路任务提升（不经过 `onSessionDeleted`）在同一事务内回收旧边路会话的映射。
- 每小时做一次孤儿修复，覆盖本次改动上线前已存在的历史残留与删除过程中断的漏网行。
- 单表单批最多删除 5000 条，单轮最多 20 批，避免长事务与大范围锁。
- 清理幂等，多实例重复执行安全；单表异常只记录日志，不阻断其它表与进程。
- 为 `feishu_thread_session(session_id)` 新增索引，支撑按会话立即删除。

## 非目标

- 不改变 `session` / `message` 的逻辑删除语义。
- 不清理仍存在且未删除的会话映射；归档会话仍保留映射。
- 不回收 `feishu_chat.session_id` 活跃指针，也不重置群聊上下文水位线。
- 不提供映射归档或恢复能力。

## 判定口径

孤儿条件固定为：

```sql
LEFT JOIN `session` s ON s.id = p.session_id
WHERE s.id IS NULL OR s.deleted = 1
```

不做时间窗判断。映射只有在会话仍存在且未删除时才有合法用途；一旦会话逻辑删除，延迟保留只会扩大错误路由窗口。正常删除路径会立即回收，小时级 Job 只承担历史残留兜底。

## 实现

- 新增 `SessionChannelMappingRepository`：
  - `deleteBySessionId(sessionId)` 顺序删除三张表；
  - `deleteOrphanWeixinPeerBatch(limit)` / `deleteOrphanFeishuThreadBatch(limit)` / `deleteOrphanFeishuSessionChannelBatch(limit)` 使用派生表选中候选主键再删除，返回 `affectedRows`；
  - `LIMIT` 钳制到 `1..5000`，非法值回落 1，占位符传参。
- 新增 `SessionChannelMappingCleanup`：每小时触发，`stopped` 控制生命周期，`cleaning` 防止单进程并发；三张表分别 drain，单表异常不影响其它表。
- `SessionService.deleteSession` 的 `onSessionDeleted` 回调接入 `deleteBySessionId`。
- `SessionService.promoteSideTaskToMainSession` 事务内直接删除旧边路会话的三张映射，与 `session_workspace_rules` 同事务收口。
- 清理器装配到 `assembleLifecycle`，关闭流程显式调用 `stop()`。
- V193 新增 `feishu_thread_session(session_id)` 索引；另两张表的主键/唯一键已覆盖按会话删除。

## 边界

- 删除飞书话题会话后，话题内下一条 @Bot 消息会创建新会话；不带 @Bot 的消息不会仅因旧映射而触发。
- 删除微信会话后，对端映射不复存在；下一条入站消息按现有逻辑获取或创建会话。
- 多实例同时执行孤儿修复可能并发删除同一批行；条件相同且删除幂等，不引入跨实例租约。
- 单表达到 20 批上限时，剩余行留到下一小时继续清理。

## 测试

- repository：三张表按会话删除、孤儿条件、稳定排序、`affectedRows` 返回、`LIMIT` 钳制。
- cleanup：三表分批累加、20 批上限、单表异常隔离、start 幂等 / stop、并发跳过。
- session service：边路提升事务内删除三张通道映射。
