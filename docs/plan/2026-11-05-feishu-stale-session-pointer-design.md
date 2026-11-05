# 飞书失效活跃会话指针修复设计

## 背景

飞书私聊与群聊复用 `feishu_chat.session_id` 作为当前活跃会话指针。`findGroupConversation()` 读取该行后直接返回，没有校验目标会话是否仍存在或未被逻辑删除。

会话删除是逻辑删除（`session.deleted = 1`），且同一条 `feishu_chat` 行还承载 `owner_user_id`、`workspace`、群聊上下文水位线与溢出摘要，因此不能删除该行或把 `session_id` 置空。失效指针会让后续飞书消息继续路由到已删除会话，执行期报 `SESSION_NOT_FOUND`。

## 目标

- 活跃指针指向不存在或已逻辑删除的会话时，读取结果视为无活跃会话。
- 下一条入站消息惰性创建新会话并覆盖指针，不要求人工修复历史行。
- 指针切换时清空旧会话的群聊水位线与摘要，避免新会话继承旧上下文。
- 群聊首条消息的创建路径与其他飞书会话创建路径一样进入 chat 级锁，避免并发重复建会话。
- 归档会话（`deleted = 0`）仍可复用，不改变归档语义。

## 实现

### 读取

`findGroupConversation()` 改为联表读取，仅返回存活会话：

```sql
SELECT c.*
FROM feishu_chat c
JOIN `session` s ON s.id = c.session_id AND s.deleted = 0
WHERE c.app_id = ? AND c.chat_id = ?
LIMIT 1
```

私聊查询继续附带 `owner_user_id` 条件。私聊、群聊、引用消息工作区与锁内重查都复用该方法，因此失效指针在这些路径统一降级为 `null`。

### 写入

`saveConversation()` 在 upsert 时先判断会话是否变化，再写入新指针：

```sql
ON DUPLICATE KEY UPDATE
  last_context_log_id = IF(session_id = VALUES(session_id), last_context_log_id, 0),
  context_summary = IF(session_id = VALUES(session_id), context_summary, NULL),
  context_summary_log_id = IF(session_id = VALUES(session_id), context_summary_log_id, 0),
  session_id = VALUES(session_id),
  owner_user_id = VALUES(owner_user_id),
  workspace = VALUES(workspace)
```

重置赋值排在 `session_id` 赋值之前，确保条件判断使用旧指针。同一会话重复保存时保留水位线和摘要；切换会话时重置，防止新会话跳过历史消息注入或复用旧摘要。

### 并发

`getOrCreateGroup()` 在读取未命中后进入 `${accountId}:${chatId}` chat 锁，再调用 `createConversation()`。`createConversation()` 在锁内重查，确保并发首条消息只创建一个会话；私聊路径已有同样语义。

## 边界

- 不为历史失效指针做批量修复；首次合法入站消息覆盖即可。
- `feishu_p2p_message`、`feishu_thread_session` 等消息/话题映射仍按既有保留期清理，不改路由优先级。
- 不改变会话删除、归档与工作区分配逻辑。
- 不新增数据库迁移。

## 测试

- repository：有/无 `owner_user_id` 的读取均带 `session.deleted = 0` 联表条件；upsert 的重置赋值位于 `session_id` 之前。
- service：群聊/私聊活跃指针失效时，锁内重查后创建并保存新会话；`findActiveP2p()` 对失效指针返回 `null`。
- 回归：现有群聊上下文增量注入、私聊引用切换与待命名标志用例继续通过。
