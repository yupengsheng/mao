-- V184: 登录 state 与待绑定消息按时间清理的索引
-- docs/plan/2026-11-05-auth-state-retention-design.md
--
-- feishu_oauth_state / ecp_oauth_state 已有 expires_at 索引；
-- 这里补齐钉钉 state、钉钉待绑定消息与飞书待绑定消息的清理索引，避免每小时全表扫描。
ALTER TABLE `feishu_pending_binding_message`
  ADD INDEX `idx_feishu_pending_binding_updated` (`updated_at`),
  ALGORITHM=INPLACE, LOCK=NONE;

ALTER TABLE `dingtalk_oauth_state`
  ADD INDEX `idx_dingtalk_oauth_state_expires` (`expires_at`),
  ALGORITHM=INPLACE, LOCK=NONE;

ALTER TABLE `dingtalk_pending_binding_message`
  ADD INDEX `idx_dingtalk_pending_binding_expires` (`expires_at`),
  ALGORITHM=INPLACE, LOCK=NONE;
