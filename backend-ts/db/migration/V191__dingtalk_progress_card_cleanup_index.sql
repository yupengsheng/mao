-- V191: 钉钉进度卡映射按更新时间清理的索引
-- docs/plan/2026-11-05-dingtalk-progress-card-retention-design.md
--
-- 表以 session_id 为主键，现有索引无法支撑全局按 updated_at 清理。
-- 在线加索引避免阻塞写入。
ALTER TABLE `dingtalk_progress_card`
  ADD INDEX `idx_dingtalk_progress_card_updated` (`updated_at`, `session_id`),
  ALGORITHM=INPLACE, LOCK=NONE;
