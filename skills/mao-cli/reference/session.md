# 会话模块（session）

## 模块职责

管理会话**元数据**：创建 LOCAL/CLOUD 会话、查询、分组分页、更新标题/摘要/权限/模型、归档/已读、看板、云端项目、边路任务与子智能体列表。管理员检索全站会话见 [admin-session.md](admin-session.md)。

## 明确不包含

不提供发送消息、queue 写操作、edit_and_resend、WebSocket 运行。

## 压缩事件保留

`session_compaction_event` 记录每次成功压缩的时间线标记（触发方式、边界消息、覆盖消息数、节省 token 与耗时），用于桌面消息时间线和运行轨迹展示。后台 Job 每小时清理超过 180 天的事件，单批 5000 条、单轮最多 20 批；超期后旧轮次不再显示压缩标记，但 `session_compaction` 摘要仍保留并继续参与上下文构建。清理不改变会话、消息或压缩摘要接口的返回结构。

## 消息队列保留

`message_queue` 保存会话忙时排队的用户消息。删除会话时，该会话的 `PENDING` 行立即置为 `status = 'DELETED'`；后台 Job 每小时再补扫指向不存在或已逻辑删除会话的 `PENDING` 残留，并清理超过 30 天的终态行，单批 5000 条、单轮最多 20 批。有效会话（含归档未删除）的待执行消息不会被清理；终态行只用于短期排障，超期后不能回查排队内容，但消息本体仍在会话消息中，开放调用超时收敛也只依赖 `PENDING` 行。

## 会话待办回收

`session_todo` 以 `session_id` 归属会话。删除会话时，该会话的全部待办行置为 `deleted = 1`；边路任务提升时，待办会复制到新主会话，旧边路会话的原始行在同一事务内逻辑删除。待办清理失败只记录日志，不阻断会话删除；已归档但未删除的会话待办不受影响。

## 任务通知抑制

`task_notification_delivery` 以 `session_id` 归属会话。删除会话或边路任务提升时，该会话所有未终态投递行（`WAITING_WS` / `PENDING` / `SENDING`）置为 `SUPPRESSED_WS`，并清空 `next_retry_at`，避免继续外推任务完成、提问或审批提醒；`SUCCEEDED` / `FAILED` 等已终态历史行保持不变。删除路径抑制失败只记录日志，不阻断会话删除；边路提升在同一事务内完成，失败整体回滚。调度器发送前会重查状态，已被抑制的行不会再发。

## 任务记录回收

`agent_task`、`agent_task_execution` 与 `agent_task_trigger` 都以 `session_id` 归属会话。删除会话时，任务主档置为 `deleted = 1`，执行与入口记录物理删除；边路任务提升时，在同一事务内回收旧边路会话的任务记录。清理失败只记录日志，不阻断会话删除。任务历史不会迁移到提升后的新会话。

## 飞书进度卡映射保留

`feishu_progress_card` 记录飞书会话与当前活跃进度卡的对应关系，用于卡片续更、崩溃恢复与取消鉴权。后台 Job 每小时清理超过 180 天的映射，单批 5000 条、单轮最多 20 批；仅清理会话已不存在、已逻辑删除或处于非活跃相位的行，`RUNNING` / `RESUMING` / `WAITING_APPROVAL` / `CANCELLING` 会话的映射即使很旧也保留。超期映射删除后，旧进度卡不能再续更，也不能通过取消按钮回查会话；会话与消息本体不受影响。

## 通道会话映射回收

`weixin_session_peer`（微信对端）、`feishu_thread_session`（飞书话题）与 `feishu_session_channel`（飞书通道绑定）都以 `session_id` 归属会话。删除会话时立即回收这三类映射；边路任务提升时在同一事务内回收旧边路会话的映射。后台 Job 每小时做一次孤儿修复，分批删除指向不存在或已逻辑删除会话的历史残留（单表每批 5000 条、单轮最多 20 批），单表异常不影响其它表。

删除飞书话题会话后，话题内下一条 @Bot 消息会创建新会话；不带 @Bot 的消息不会仅因旧映射而触发。仍存在且未删除（含归档）的会话映射不会被清理。

飞书私聊 / 群聊的活跃会话指针 `feishu_chat.session_id` 不随会话删除立即改写。读取时按 `session.deleted = 0` 校验；指针已失效时视为无活跃会话，下一条合法入站消息惰性创建新会话并覆盖指针。群聊首条消息创建走 chat 级锁，指针切换会重置旧群聊上下文水位线与摘要。

## 钉钉活跃会话指针恢复

钉钉私聊 / 群聊的活跃会话指针 `dingtalk_chat.session_id` 不随会话删除立即改写。读取时按 `session.deleted = 0` 校验；指针已失效时视为无活跃会话，下一条合法入站消息惰性创建新会话并覆盖指针。指针切换会同步 `chat_type` / `owner_user_id` / `workspace`；首次入站消息的「读取 → 创建 → 保存」按会话加锁，避免并发重复建会话。归档会话仍可复用。

## 钉钉进度卡映射保留

`dingtalk_progress_card` 记录钉钉会话与进度卡的对应关系，用于更新卡片、引用回复反查与失败重试。后台 Job 每小时清理超过 180 天的映射，单批 5000 条、单轮最多 20 批；仅清理会话已不存在、已逻辑删除或处于非活跃相位的行，`RUNNING` / `RESUMING` / `WAITING_APPROVAL` / `CANCELLING` 会话的映射即使很旧也保留。超期映射删除后，旧进度卡不能再触发重试，也不能通过引用该卡反查回复上下文；会话与消息本体不受影响。

## 命令选择

| 场景 | 命令 |
|------|------|
| 列表 | `session list` |
| 分组预览 | `session groups` |
| 分组分页 | `session list --group-key ...` |
| 详情 | `session get` |
| 创建 | `session create` |
| 更新元数据 | `session update` |
| 删除 | `session delete` |
| 标记已读 | `session mark-read` |
| 归档 | `session archive` |
| 看板 | `session dashboard` |
| 云端项目列表 | `session cloud-projects` |
| 边路任务 | `session side-tasks` |
| 子智能体 | `session subagents` |
| 边路任务转主会话 | `session promote-side-task` |

---

## 命令：mao session list

### 参数说明

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--keyword` | 否 | 字符串 | 标题等关键词 → `keyword` |
| `--status` | 否 | 字符串 | 会话状态过滤 → `status` |
| `--group-key` | 否 | 字符串 | 分组 key；提供后返回该分组分页 |
| `--offset` | 否 | 数字 | 分组分页偏移，仅 `--group-key` 时有效 |
| `--limit` | 否 | 数字 | 分组分页条数，仅 `--group-key` 时有效 |

### 示例

```bash
mao session list --keyword 重构 --json
mao session list --group-key project:demo --offset 0 --limit 20
```

---

## 命令：mao session groups

### 用途

获取桌面端任务侧栏使用的会话分组预览。

分组 key 由服务端按工作区 / 来源派生；哨兵会话（来源 `signal`，见 [signal-watcher.md](signal-watcher.md)）归入独立分组 `SIGNAL`，展示名「信号哨兵」，排在各分组最后，且不计未读。

### 参数说明

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--keyword` | 否 | 字符串 | 标题等关键词 |
| `--status` | 否 | 字符串 | 会话状态过滤 |
| `--preview-limit` | 否 | 数字 | 每组预览条数，服务端默认 5 |

### 示例

```bash
mao session groups --preview-limit 8 --json
```

---

## 命令：mao session get

### 参数说明

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--id` | 是 | 数字 | 会话 ID |

### 示例

```bash
mao session get --id 12
```

---

## 命令：mao session create

### 用途

创建会话。`executionMode` 决定工作区参数约束。

### 参数说明

| 参数 | 必填 | 类型 | 取值/格式 | 含义 |
|------|------|------|-----------|------|
| `--agent-id` | 是 | 数字 | — | Agent ID → `agentId` |
| `--execution-mode` | 是 | 字符串 | `LOCAL` \| `CLOUD` | 执行模式 → `executionMode` |
| `--title` | 否 | 字符串 | — | 标题 → `title` |
| `--workspace` | 条件必填 | 字符串 | 本地绝对路径 | LOCAL 必填工作区路径 → `workspace` |
| `--permission-level` | 否 | 字符串 | `READ_ONLY` \| `READ_WRITE` \| `SMART` \| `PROXY` \| `FULL` | 权限级别 → `permissionLevel` |
| `--model-id` | 否 | 数字 | 模型主键 | → `modelId` |
| `--workspace-mode` | 条件必填 | 字符串 | `new` \| `existing` \| `git` | CLOUD 必填 → `workspaceMode` |
| `--cloud-project-key` | 条件必填 | 字符串 | — | `existing` 时必填 → `cloudProjectKey` |
| `--git-clone-url` | 条件必填 | 字符串 | Git URL | `git` 时必填 → `gitCloneUrl` |
| `--git-branch` | 否 | 字符串 | — | Git 分支 → `gitBranch` |
| `--is-git` | 否 | 布尔 | `true/false` | 是否 Git 仓库 → `isGit` |
| `--platform` | 否 | 字符串 | — | 客户端平台 → `platform` |
| `--shell` | 否 | 字符串 | — | Shell 路径 → `shell` |
| `--os-version` | 否 | 字符串 | — | 系统版本 → `osVersion` |

### 参数约束

- `LOCAL`：必须 `--workspace`
- `CLOUD`：必须 `--workspace-mode`
  - `existing` → 必须 `--cloud-project-key`（可先 `session cloud-projects`）
  - `git` → 必须 `--git-clone-url`
  - `new` → 新建云端项目，无需上述两项

### 示例

```bash
# LOCAL
mao session create --agent-id 1 --execution-mode LOCAL --workspace /Users/me/proj --permission-level READ_WRITE

# CLOUD existing
mao session create --agent-id 1 --execution-mode CLOUD --workspace-mode existing --cloud-project-key demo

# CLOUD git
mao session create --agent-id 1 --execution-mode CLOUD --workspace-mode git \
  --git-clone-url https://git.example.com/a/b.git --git-branch main
```

---

## 命令：mao session update

### 参数说明

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--id` | 是 | 数字 | 会话 ID |
| `--title` | 否 | 字符串 | 新标题 |
| `--summary` | 否 | 字符串 | 摘要 |
| `--project-key` | 否 | 字符串 | 项目 key → `projectKey` |
| `--permission-level` | 否 | 字符串 | 权限级别枚举同上 |
| `--model-id` | 否 | 数字 | 模型主键 |

至少提供一个可选更新字段。

### 示例

```bash
mao session update --id 12 --title '新标题' --permission-level SMART
```

---

## 命令：mao session delete

### 参数说明

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--id` | 是 | 数字 | 会话 ID |

### 示例

```bash
mao session delete --id 12
```

---

## 命令：mao session mark-read / archive

### 用途

- `mark-read`：标记已读（`PUT /sessions/{id}/read`）
- `archive`：归档（`PUT /sessions/{id}/archive`）

### 参数说明

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--id` | 是 | 数字 | 会话 ID |

### 示例

```bash
mao session archive --id 12
mao session mark-read --id 12
```

---

## 命令：mao session dashboard

### 用途

获取看板分组会话，通常含 `running` 与 `recent`。

### 参数说明

无。

### 示例

```bash
mao session dashboard --json
```

---

## 命令：mao session cloud-projects

### 用途

列出当前用户云端项目目录，供 `workspace-mode=existing` 使用。

### 返回结果

数组元素：`name`、`path`、`git`（是否含 `.git`）。

### 示例

```bash
mao session cloud-projects
```

---

## 命令：mao session side-tasks

### 用途

列出某父会话下的并行子任务会话摘要。

### 参数说明

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--id` | 是 | 数字 | 父会话 ID |

### 返回结果

元素含 `id`、`title`、`agentId`、`modelId`、`phase`、`createdAt`。`agentId` 是这条边路任务自己的智能体，与主会话独立。

### 示例

```bash
mao session side-tasks --id 12
```

---

## 命令：mao session subagents

### 用途

列出某父会话下由 `delegate` 产生的子智能体会话摘要与执行审计信息。

### 参数说明

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--id` | 是 | 数字 | 父会话 ID |

### 返回结果

元素含 `id`、`title`、`phase`、`createdAt`、`agentType`、`taskDescription`。

### 示例

```bash
mao session subagents --id 12 --json
```

### 子智能体执行记录保留

执行记录默认保留 180 天，按最后一次更新（`updated_at`）计时，后台每小时自动清理。清理条件为：状态已是 `COMPLETED` / `FAILED` / `CANCELLED`，且结果投递状态为 `DELIVERED` / `SUPPRESSED` / `LEGACY`。`RUNNING` / `RECOVERING` 与 `PENDING` 投递记录永不清理。

子会话仍存在（含已归档）时，每个子会话至少保留 `id` 最大的一条记录，`session subagents` 的 `agentType`、`taskDescription` 与阶段兜底不会因清理丢失；子会话被逻辑删除或实体不存在后，其过期终态记录会被全部清理。重试复用同一条执行记录并刷新 `updated_at`，会重新计时。超过 180 天的历史执行审计不可恢复，但子会话及其消息不受影响。

---

## 命令：mao session promote-side-task

### 用途

将一条边路任务（side task）会话提升为独立主会话。提升后原边路任务从父会话树中脱离，成为顶层会话；名下的边路任务子树（如有）随提升自然挂到新主会话名下，子树内各会话的父子关系不变。存在子代理（SUBAGENT）子会话时仍拒绝提升。

### 参数说明

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--id` | 是 | 数字 | 边路任务会话 ID |

### 返回结果

提升后的会话对象。

### 示例

```bash
mao session promote-side-task --id 15 --json
```

---

## 分享与导出

桌面任务列表（含归档区与边路任务）右键提供入口，CLI 不包装这两项。

- **只读分享**：属主 `POST /v1/sessions/:id/share` 生成链接（重复调用返回同一条未撤销链接）。`GET /v1/share/:token` 供已登录用户按创建时的消息水位只读查看；此后新消息不出现，属主 `PUT` 刷新水位后才纳入（水位可因编辑重发截断而回落）。撤回、删除的消息从分享中消失；编辑重发后该条以新内容呈现，其后消息消失。只读页与客户端历史轮次一致：执行过程默认折叠，复制按钮不出现在中间步骤、只留在该轮最终回复；底部文件变更按路径合并（同一文件一行，增删行数合计）。`DELETE` 撤销后链接立即失效。响应不含 thinking。创建、首页访问、撤销写入审计 `objectType=session.share`。
- **JSONL 导出**：属主 `GET /v1/sessions/:id/export/jsonl` 下载 `.jsonl`。首行是 `session_export` 元信息头（会话标题、Agent、导出时间、消息数、文件变更汇总），其后每行一条原始消息，字段与压缩归档 `compaction-NNN.jsonl` 一致（`id`/`role`/`content`/`toolCallId`/`toolCalls`/`metadata`/`tokenCount`/`modelId`/`createdAt`，另按 `messageId` 附 `fileChanges` 摘要），不含 `thinkingContent`，内联图片 base64 替换为占位符。边路任务只含自身消息。正文超过 5MB 时返回 413，改用分享链接。
- **匿名链接（默认关闭）**：管理后台「分享」开关 `share.tokenLinksEnabled`。开启后创建时可带 `publicLink` 与 `expiresInDays`，免登录访问 `GET /v1/share/public/:token`；关闭或过期统一 404。
