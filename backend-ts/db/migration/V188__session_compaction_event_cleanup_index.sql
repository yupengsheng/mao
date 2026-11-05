-- V188: 会话压缩事件按创建时间清理的索引
-- docs/plan/2026-11-05-session-compaction-event-retention-design.md
--
-- 原有 idx_session_created(session_id, created_at) 只适合按会话读取时间线；
-- 全局按 created_at 清理需要单独索引，避免全表扫描。在线加索引避免阻塞写入。
ALTER TABLE `session_compaction_event`
  ADD INDEX `idx_session_compaction_event_created` (`created_at`, `id`),
  ALGORITHM=INPLACE, LOCK=NONE;
