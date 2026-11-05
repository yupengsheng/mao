-- V192: 飞书进度卡映射按更新时间清理的索引
-- docs/plan/2026-11-05-feishu-progress-card-retention-design.md
--
-- 现有唯一键只服务按会话读取，无法支撑全局按 updated_at 清理。
-- 在线加索引避免阻塞写入。
ALTER TABLE `feishu_progress_card`
  ADD INDEX `idx_feishu_progress_card_updated` (`updated_at`, `id`),
  ALGORITHM=INPLACE, LOCK=NONE;
