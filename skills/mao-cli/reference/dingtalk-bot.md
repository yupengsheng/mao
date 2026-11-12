# 钉钉机器人通道（dingtalk-bot）

通过**企业内部应用机器人 + Stream** 在钉钉里与 Agent 对话。支持多个机器人，每个可独立绑定 Agent 与模型。这和「任务完成通知」里的自定义机器人 Webhook 不是同一条路，不要混用。

## 功能特性

| 能力 | 说明 |
|------|------|
| 多机器人 | 管理后台配置多个企业内部应用，每个独立 Agent / 模型，Stream 随启停热生效 |
| 绑定 | 「设置 → 渠道绑定 → 钉钉Bot」绑定，或钉钉里点「点我绑定」短链。钉钉身份只绑定已有 Mao 用户，不创建账号，不要求 ECP 票 |
| 私聊 | 文本、富文本、图片、文件。`---`（3 个及以上 `-` 或 `—`）新建会话；执行中收到 `---` 先取消当前任务 |
| 群聊 | 只处理 @ 本机器人之后的文本、富文本、图片。上下文是最近的 @ 往来加上本条引用正文，不是完整群聊 |
| 互动卡片（一卡到底） | 排队中 → 执行中 → 完成 / 失败 / 取消全程共用同一张卡，排队卡被消费时就地升级为进度卡；排队时可立即发送或取消本条；完成卡可点「👎 不满意」（再点取消，汇入桌面 / 飞书同一张反馈统计）；非排队态有「会话详情」跳转。同时出现的按钮排在同一行，PC 端按内容自适应宽度。只允许原发送者点按钮。轮次开始但尚无正文时显示「正在思考…」，在途工具行显示实时耗时并默认每 3 秒刷新 |
| 定时任务结果 | 在钉钉会话里创建的定时任务（以及该会话上的「立即执行」）成功后，最终回复推回原私聊或群。配了卡片模板时发「处理完成」卡；没有模板或投放失败时改发 markdown。失败和取消不推 |
| 网页同步 | 已经打开的网页 / 桌面 / 安卓会话会跟上这一轮执行 |
| 工具 | 钉钉会话提供 `dingtalk_send_image` / `dingtalk_send_file`，不提供 `ask_user_questions` |
| 消息防抖合并 | 同一发送者在同一会话内 1 秒窗口期中连续发出的多条纯文本（含不带图富文本）合并为一次任务触发，正文按到达顺序空行拼接；带图富文本、图片、语音/视频、`---` 仍立即单独触发。窗口时长 `DINGTALK_BOT_MERGE_WINDOW_MS`（默认 1000ms，0 关闭，重启生效） |

明确不做：会话列表、切换会话、引用切会话、话题群、群文件 / 语音 / 视频、出站引用回复、钉钉文档读取、用自定义机器人 Webhook 当通道。

## 角色与操作入口

| 角色 | 操作 | 入口 |
|------|------|------|
| 管理员 | 添加 / 编辑 / 启停 / 删除 / 重连 | 管理后台「能力 → 钉钉机器人」 |
| 普通用户 | 绑定 / 解绑 | 桌面 / Web / 安卓「设置 → 渠道绑定 → 钉钉Bot」 |

## 使用流程

1. 开放平台创建企业内部应用，机器人收消息选 Stream 并发布。在「权限管理」按权限点搜索并开通下表，然后到「版本管理与发布」发一版，权限才生效。登录应用（`DINGTALK_OAUTH_CLIENT_ID` 对应的应用，可以就是这个机器人应用）还要在「登录与分享」登记回调。卡片平台发布**一张合并模板**（排队 / 进度 / 终态一卡到底），按钮 actionId 为 `run`、`cancel`、`retry`（「取消排队」与「取消任务」共用 `cancel`，靠可见性互斥）。可直接导入现成模板，变量契约、导入步骤和改模板注意点见 [../template/README.md](../template/README.md)。

   | 后台名称 | 权限点 | 用途 |
   |----------|--------|------|
   | 企业内机器人发送消息权限 | `qyapi_robot_sendmsg` | 私聊 / 群聊回复，以及下载用户发来的图片、文件 |
   | 互动卡片实例写权限 | `Card.Instance.Write` | 投放并更新进度卡、排队卡 |
   | 成员信息读权限 | `qyapi_get_member` | 绑定：用 unionId 换企业内 userid。接口名是「根据 unionid 获取用户」 |
   | 通讯录个人信息读权限 | `Contact.User.Read` | 绑定：授权后读取当前用户的 unionId |
   | 调用企业 API 的基本权限 | `qyapi_base` | 上传图片、文件。企业内部应用通常默认已有 |

   绑定用的两项（`qyapi_get_member`、`Contact.User.Read`）开在登录应用上；发消息、卡片和上传开在机器人应用上。两边是同一个应用时一次开齐。
2. 后端配置 `APP_DINGTALK_BOT_SECRET`、`DINGTALK_OAUTH_CLIENT_ID` / `DINGTALK_OAUTH_SECRET` / `DINGTALK_OAUTH_REDIRECT_URI`，打开 `DINGTALK_BOT_ENABLED`。登录应用必须和机器人在同一企业。
3. 管理后台添加机器人：内部 App Key、名称、Client ID、Client Secret、Robot Code、可选 Agent / 模型 / 卡片模板 ID，然后启用。
4. 用户在「设置 → 渠道绑定 → 钉钉Bot」绑定，或在钉钉里给机器人发一条消息，按卡片短链登录后再授权。
5. 私聊直接发消息。群里把机器人拉进群后 @ 它。想开新会话就发 `---`。

## 入站幂等记录保留

钉钉入站事件按 `bot_id + message_id` 去重，记录保留 30 天。后台 Job 每小时清理一次过期记录，单批 5000 条、单轮最多 20 批；30 天已远超钉钉事件重投窗口，超期消息再次投递时不再保证去重。

钉钉登录 `state` 与待绑定消息按 `expires_at` 保留 30 天，后台 Job 每小时分批清理；过期记录不能再完成绑定或重放，重新发起绑定即可。

## 活跃会话指针恢复

`dingtalk_chat.session_id` 是当前活跃会话指针，不随会话删除立即改写。读取时按 `session.deleted = 0` 校验；指针已失效时视为无活跃会话，下一条合法入站消息惰性创建新会话并覆盖指针。覆盖时同步 `chat_type`、`owner_user_id` 与 `workspace`，避免沿用旧会话归属；首次入站消息的读取、创建与保存按 `bot_id + conversation_id` 加锁，并发首条消息只创建一个会话。归档会话（未删除）仍可复用。

## 入站队列启动恢复

服务启动时先清理 `dingtalk_inbound_queue` 中指向不存在或已逻辑删除会话的队列行，单批 5000 条、单轮最多 20 批，再恢复存活会话的排队消息。归档但未删除的会话不受影响；`RUNNING` 行仍按消息是否已落库分别删除或复位为 `QUEUED`。清理失败只记录告警，不阻断合法队列恢复。

## 群消息日志保留

群消息日志保留 30 天，后台 Job 每小时分批清理，单批 5000 条、单轮最多 20 批。日志只用于最近 120 分钟的群上下文注入，超过 30 天的历史消息不再保留，也不会出现在后续上下文或历史回查中。

## REST API

### 管理端（读 `dingtalk-bot:read`，写 `dingtalk-bot:write`）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/v1/admin/dingtalk-bots` | 列表。支持 `pageNum` / `pageSize` / `keyword`（名称、Client ID、Robot Code），分页时总数在 `x-total-count`；不传新参数时返回全量数组。不返回 `clientSecret`，只返回 `clientSecretConfigured` |
| GET | `/v1/admin/dingtalk-bots/:id` | 单个 |
| POST | `/v1/admin/dingtalk-bots` | 创建：`appKey`、`name`、`clientId`、`clientSecret`、`robotCode`、`agentId?`、`modelId?`、`cardTemplateId?`（排队/进度/终态共用同一模板）、`enabled?` |
| PUT | `/v1/admin/dingtalk-bots/:id` | 更新。`clientSecret` 空串表示不改 |
| DELETE | `/v1/admin/dingtalk-bots/:id` | 软删除 |
| POST | `/v1/admin/dingtalk-bots/:id/enable` 与 `/disable` | 启停 |
| GET | `/v1/admin/dingtalk-bots/status` | 连接状态：`ready` / `reconnecting` / `failed` / `disabled` |
| POST | `/v1/admin/dingtalk-bots/:id/reconnect` | 仅已启用的机器人 |

### 用户端

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/v1/dingtalk/binding` | 已登录时发起绑定，返回 `authUrl` |
| GET | `/v1/dingtalk/binding/status` | `bound`、`userid`、`unionId`、`boundAt` |
| DELETE | `/v1/dingtalk/binding` | 解绑。会话和工作区保留 |
| GET | `/v1/dingtalk/bind/:state` | 短链。无登录态时先到登录页，登录后再跳钉钉授权 |
| GET | `/v1/dingtalk/oauth/callback` | 钉钉授权回调 |

## 排障

- **保存机器人报「未配置 APP_DINGTALK_BOT_SECRET」**：先配密钥再重启。
- **钉钉里回复「管理员尚未配置钉钉登录」**：补齐 `DINGTALK_OAUTH_*`，回调地址要和开放平台「登录与分享」一致。
- **绑定页提示「没有调用该接口的权限」**：登录应用未开通「成员信息读权限」（`qyapi_get_member`）。到该应用「权限管理」开通后发布版本，再重新绑定。若报错里的权限点是 `Contact.User.Read`，同样开通「通讯录个人信息读权限」并发布。
- **全员无法识别身份**：应用未发布，回调里没有 `senderStaffId`。发布后再测。外部群成员没有企业 userid，第一期不支持。
- **已绑定其他账号**：一个 userid 只能绑一个 Mao 用户，一个 Mao 用户只能绑一个钉钉身份。先解绑再绑，不会自动改绑。
- **有时没反应**：同一个 Client ID 只能有一条 Stream。本地调试用另一个应用。配重了也不会静默共存——重复的那条会被标记为失败，它此前建立的连接会被一并断开，只保留一条；反过来已持有连接的认领方不会被误杀。
- **重连太频繁 / 太慢**：连接失败后按 1s、2s、4s … 指数退避到上限重试，连续失败计数跨重连保留，不会每次都从第一档开始；在管理后台点「重连」是管理员显式动作，会把计数归零重新开始。
- **点「取消排队」或「取消任务」后卡片已变成已取消，钉钉仍提示取消失败**：模板里的按钮成功判定若还是字符串 `status == cancelled`，卡片平台会把它编译成空条件，Toast 恒走失败文案。把 `skills/mao-cli/template/dingtalk-card.json` 重新导入卡片平台，保存并**发布**；后端成功回包带 `requestOk=true`，模板用 `isTrue(requestOk)` 判定。立即发送、重试、点踩的 Toast 一并修复。
- **进度卡没出来**：模板 ID 为空时任务仍会跑，只发一条「正在处理」，结束时另发 markdown。模板 ID 填了仍不出卡，先看后端日志有没有 `钉钉进度卡片创建失败`：`param.templateUnpublished` 表示模板仍是草稿；`chatbot not exist` 通常是 Robot Code 填成了 Client ID；`param.openDeliverModelError` 表示投放模型缺失，确认模板已发布且机器人在同一企业，必要时重连机器人。
- **定时任务跑完钉钉没收到**：只在任务成功时推回创建该任务的钉钉会话。机器人未启用或用户已解绑时日志是 `定时任务钉钉回复跳过`；发送失败时是 `Error sending DingTalk reply for scheduled task`。配了模板但投放失败会改发 markdown，不会丢掉结果。
- **群里看不到没 @ 的讨论**：这是平台限制。需要机器人看到某句时，引用那条或把原话写进 @ 内容。
