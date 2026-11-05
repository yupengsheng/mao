# 钉钉失效活跃会话指针修复设计

## 背景

钉钉私聊与群聊复用 `dingtalk_chat.session_id` 作为当前活跃会话指针。`findConversation()` 读取该行后直接返回，没有校验目标会话是否仍存在或未被逻辑删除。

会话删除是逻辑删除（`session.deleted = 1`）。失效指针会让后续钉钉消息继续路由到已删除会话，执行期报 `SESSION_NOT_FOUND`；且同一条 `dingtalk_chat` 行还承载 `chat_type`、`owner_user_id` 与 `workspace`，指针切换后若不覆盖这些字段，会把旧会话的属主或工作区带到新会话。

## 目标

- 活跃指针指向不存在或已逻辑删除的会话时，读取结果视为无活跃会话。
- 下一条入站消息惰性创建新会话并覆盖指针，不要求人工修复历史行。
- 指针切换时同步 `chat_type` / `owner_user_id` / `workspace`，避免沿用旧会话归属。
- 首次入站消息的「读取 → 创建 → 保存」按会话加锁，避免并发重复建会话。
- 归档会话（`deleted = 0`）仍可复用，不改变归档语义。

## 实现

### 读取

`findConversation()` 改为联表读取，仅返回存活会话：

```sql
SELECT c.*
FROM dingtalk_chat c
JOIN `session` s ON s.id = c.session_id AND s.deleted = 0
WHERE c.bot_id = ? AND c.conversation_id = ?
LIMIT 1
```

失效指针统一降级为 `null`，私聊、群聊、`---` 新建与锁内重查都走同一方法。

### 写入

`saveConversation()` 的 upsert 同步会话归属字段：

```sql
ON DUPLICATE KEY UPDATE
  chat_type = VALUES(chat_type),
  session_id = VALUES(session_id),
  owner_user_id = VALUES(owner_user_id),
  workspace = VALUES(workspace),
  title = COALESCE(VALUES(title), title)
```

`title` 仍保留「显式传值才覆盖」的语义。

### 并发

`getOrCreate()` 与 `createP2pSession()` 的完整读写流程进入 `${accountId}:${conversationId}` 锁。锁内重新读取指针，并发首条消息只创建一个会话；后到请求复用已保存的会话。

## 边界

- 不为历史失效指针做批量修复；首次合法入站消息覆盖即可。
- 不改变会话删除、归档与工作区分配逻辑。
- 不新增数据库迁移。
- 钉钉入站队列表（`dingtalk_inbound_queue`）的恢复语义另行处理。

## 测试

- repository：读取带 `JOIN session ... deleted = 0`；upsert 同步 `chat_type` / `session_id` / `owner_user_id` / `workspace`，并保留 title 的 COALESCE 语义。
- service：存活指针直接复用；失效指针惰性创建并保存；同会话并发 `getOrCreate()` 只创建一次会话。
