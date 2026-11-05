-- V195: 会话删除 / 边路提升时按 session_id 回收任务入口记录
-- docs/plan/2026-11-05-task-session-cleanup-design.md
--
-- agent_task_trigger 现有索引只覆盖 task_id 与 source_event_id；
-- 会话删除直接按 session_id 清理，需要补齐索引以避免全表扫描。
ALTER TABLE `agent_task_trigger`
  ADD INDEX `idx_agent_task_trigger_session` (`session_id`),
  ALGORITHM=INPLACE, LOCK=NONE;
