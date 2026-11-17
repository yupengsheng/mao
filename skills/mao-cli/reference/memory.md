# 记忆模块（memory）

## 模块职责

跨会话长期记忆（Memory 层）：用户手工维护或任务完成后自动沉淀「值得记住的长期事实」（用户偏好、项目事实）。记忆条目分「用户级」（USER，跨 Agent、跨项目生效）与「项目级」（PROJECT，绑定 `session.projectKey`，仅该项目会话中注入）。后续会话系统提示词自动注入（用户级 8 条 + 项目级 12 条，`updated_at` 倒序）。

本期 CLI 未封装记忆命令，需要时直接调 REST（登录态 JWT）。

## 使用问答

**Agent 会记住什么？**
只沉淀明确的长期事实或偏好（如「输出报告用中文」「该仓库测试用 Vitest」）。猜测、闲聊、一次性任务细节不抽取；任务失败 / 取消不抽取。

**在哪里管理？**
桌面 / Web / 安卓设置页 →「长期记忆」。可新增、编辑、删除、忽略、恢复，以及一键关闭「任务完成后自动收集记忆」；列表支持按内容或项目关键词搜索，自动沉淀的记忆可从卡片跳回来源会话。

**忽略（DISMISSED）和删除有什么区别？**
忽略是软拒：条目保留、不再注入。用户或管理员主动忽略的条目标记为 `USER`，自动抽取再次遇到相同内容时不复活；系统因容量淘汰的条目标记为 `EVICTED`，相同事实再次出现时可按容量与 LRU 规则恢复。删除是物理删除，后续任务再次抽到相同事实时允许重新插入为新记忆。

**同一事实换了说法会重复记吗？**
不会正常重复。抽取时模型会同时看到已知的生效中自动记忆（用户级全部 + 当前项目级），对同一事实输出「再确认」（仅刷新排序）或「内容更新」（新表述更完整时改写原文），只有判定为全新事实才插入；模型引用错误记忆 id 时该条直接丢弃。精确哈希仍作为廉价前置。用户手写的记忆不参与这一匹配，永不被自动改写。

**生效中记忆满了 200 条会怎样？**
自动抽取到新事实时，优先把受影响分组（用户级 / 当前项目）内最旧的「自动抽取」记忆标记为系统淘汰（`DISMISSED` / `EVICTED`）腾出名额；该分组没有可淘汰的自动记忆时才放弃该条。被系统淘汰的事实再次出现时可恢复，容量已满则仍须在相应分组淘汰自动记忆，用户主动忽略项不自动恢复。手动新增仍受 200 上限约束并提示清理。

**记忆的归属？**
记忆永远个人归属（`user_id` 隔离）；项目级只是「绑定到某项目的个人记忆」，不跨用户共享。

**注入顺序与冲突？**
系统提示词在「最佳实践经验」之后注入「长期记忆」段落，并声明「与用户当前消息或工作区规则冲突时，以用户当前消息为准」。

## 端点说明（REST，登录态）

统一响应 `{ code, message, data }`，`code === 0` 成功。越权与不存在一律按不存在处理（code 3033）。

### GET /api/v1/memory

分页列出当前用户记忆，`updated_at` 倒序。

| 参数 | 必填 | 说明 |
|------|------|------|
| `page` | 否 | 默认 1 |
| `pageSize` | 否 | 默认 20，最大 100 |
| `scope` | 否 | `USER` / `PROJECT` |
| `projectKey` | 否 | 项目标识过滤 |
| `status` | 否 | `ACTIVE` / `DISMISSED` |
| `keyword` | 否 | 关键词，对 `content` / `project_key` 做包含匹配（通配符按字面转义），可与 scope / status 叠加 |

返回 `{ records, total, current, size }`，条目含 `id`、`scope`、`projectKey`、`content`、`source`（AUTO=自动抽取 / MANUAL=手写）、`status`、`originSessionId`、`createdAt`、`updatedAt`。

### POST /api/v1/memory

手工新增：`{ scope, content, projectKey? }`。约束：PROJECT 级必填 `projectKey`（≤128 字符，机器人渠道键无效）；`content` 必填且 ≤500 字；每用户 ACTIVE 状态记忆总量上限 200 条（超限报 code 3036）；同一用户内相同规范化内容唯一（重复报 code 3035）。

### PATCH /api/v1/memory/{id}

编辑 `content`（重算去重哈希，与新哈希冲突报 code 3035；编辑不改变 status）；或切换 `status`（`ACTIVE` ↔ `DISMISSED` 双向，恢复须显式传 `ACTIVE`）。

### DELETE /api/v1/memory/{id}

物理删除。

### GET /api/v1/memory/settings

返回 `{ autoCaptureEnabled }`（无偏好行视为 false，即默认关闭）。

### PATCH /api/v1/memory/settings

更新自动收集开关：`{ autoCaptureEnabled: boolean }`。默认关闭，需用户显式开启后任务收尾才会自动抽取；关闭状态下仅停止抽取，注入与手工管理不受影响。

### GET /api/v1/memory/projects

项目级记忆新增弹窗的项目下拉数据源：当前用户历史会话出现过的 `projectKey` 去重集合，已排除机器人渠道特殊值（微信 / 飞书渠道）。

### 管理后台记忆接口

`GET /api/v1/admin/memory` 需 `memory:read`，支持 `userId/keyword/scope/status/source/projectKey/updatedFrom/updatedTo/page/pageSize` 筛选与分页。未指定 `userId` 的跨用户查询必须至少提供一个非时间筛选条件；仅日期范围不足以执行跨用户扫描。用户详情的「记忆」Tab 固定当前用户。用户选择器使用 `GET /api/v1/admin/memory/users?keyword=...&pageSize=...`，仅返回 id、username、displayName，同样受记忆读权限约束，不要求授予完整用户管理权限。

管理员可通过 `POST /api/v1/admin/memory` 代建记忆、`PATCH /api/v1/admin/memory/{id}` 编辑或切换状态、`DELETE /api/v1/admin/memory/{id}` 物理删除，均需 `memory:write` 并由后台审计记录。只有读权限的账号仍可查询但不能写。代建、编辑和恢复仍遵守归属、重复检测、内容长度及每用户 ACTIVE 容量约束；管理员主动忽略与用户主动忽略均写入 `USER`。CLI 暂无专用记忆子命令。
