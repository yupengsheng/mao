-- V194: 会话删除时按 session_id 回收 Webhook 触发器绑定
-- docs/plan/2026-11-05-webhook-session-binding-recovery-design.md
--
-- 现有索引只覆盖 user_id；会话删除与绑定失效自愈都需要按 session_id 定位触发器。
-- 在线加索引避免阻塞写入。
ALTER TABLE `webhook_trigger`
  ADD INDEX `idx_webhook_trigger_session` (`session_id`),
  ALGORITHM=INPLACE, LOCK=NONE;
