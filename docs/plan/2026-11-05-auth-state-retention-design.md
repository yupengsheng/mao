# 登录 state 与待绑定消息保留清理设计

## 背景

飞书扫码登录、ECP 飞书登录与钉钉绑定都会把一次性 `state` 写入数据库；飞书 / 钉钉机器人在用户未绑定时还会暂存原始消息，等绑定成功后重放。这些记录只在数分钟的授权窗口内有效，但此前没有清理策略：

- `feishu_oauth_state`、`ecp_oauth_state`、`dingtalk_oauth_state` 每次发起登录写一行；
- `feishu_pending_binding_message`、`dingtalk_pending_binding_message` 每次未绑定用户发消息写一行。

随着登录与机器人使用量增长，这些表会无限变大，其中飞书待绑定消息还会在每次后端重启时被重新扫描。

## 目标

- 每小时清理超过 30 天的登录 state 与待绑定消息。
- 单表单批最多删除 5000 条，单轮最多 20 批，避免长事务和大范围锁。
- 单表异常只记录日志，不影响其它表，也不阻断进程。
- 清理幂等，多实例重复执行安全。
- 为缺少清理索引的三张表补索引，避免每小时全表扫描。

## 非目标

- 不修改登录、绑定、回调与消息重放逻辑。
- 不清理用户、会话、消息、群消息日志或 ECP sessionToken。
- 不提供按渠道或用户区分的保留期，也不增加系统设置项。
- 不归档过期记录。

## 实现

- 保留期固定 30 天：授权窗口只有数分钟，30 天已足够排查登录与绑定问题。
- `AuthStateCleanup` 使用 `setInterval` 每小时触发，按 store 顺序逐表清理；`stopped` 控制生命周期，`cleaning` 防止同一进程内重复扫描。
- cutoff 通过 `formatDateTime` 生成，与数据库 `DATETIME` 的上海时区格式一致。
- 各仓储新增 `deleteBatch(cutoff, limit)`，执行 `DELETE ... ORDER BY id LIMIT <safeLimit>`，返回 `affectedRows`；`LIMIT` 钳制在 1~5000。
- 过期判定：
  - `feishu_oauth_state`、`ecp_oauth_state`、`dingtalk_oauth_state`：`expires_at < cutoff`；
  - `dingtalk_pending_binding_message`：`expires_at < cutoff`；
  - `feishu_pending_binding_message`：没有 `expires_at`，按 `updated_at < cutoff` 删除。绑定链接本身只有数分钟有效期，30 天前的待绑定记录不可能再成功重放。
- 清理器装配到 `assembleLifecycle`，关闭流程显式调用 `stop()`。
- V184 新增 `feishu_pending_binding_message(updated_at)`、`dingtalk_oauth_state(expires_at)`、`dingtalk_pending_binding_message(expires_at)` 索引；飞书 / ECP OAuth state 已有 `expires_at` 索引。

## 边界

- 30 天后过期的登录 state 被删除；用户重新发起登录会生成新的 state，不受影响。
- 飞书待绑定消息超过 30 天后不再参与启动恢复，避免后端重启时重放陈旧消息；绑定窗口内（数分钟）的重放行为不变。
- 单轮达到 20 批上限时，剩余过期记录留到下一小时继续清理。
- 多实例同时运行时可能并发删除同一批记录，但条件相同且删除的是同一保留期外的历史行，结果幂等。
- 清理只影响一次性鉴权记录，不删除已建立的用户绑定、ECP 票或会话。
