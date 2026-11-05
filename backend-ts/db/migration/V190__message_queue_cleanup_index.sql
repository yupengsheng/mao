-- V190: 消息队列终态行按更新时间清理的索引
-- docs/plan/2026-11-05-message-queue-retention-design.md
--
-- 现有 idx_session_status(session_id, status) 只适合按会话读取 PENDING 行，
-- 全局按 updated_at 清理需要独立索引。在线加索引避免阻塞写入。
ALTER TABLE `message_queue`
  ADD INDEX `idx_message_queue_updated` (`status`, `updated_at`, `id`),
  ALGORITHM=INPLACE, LOCK=NONE;
