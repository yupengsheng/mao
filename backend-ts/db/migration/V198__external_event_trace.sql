-- V198: 外部事件追踪与去重（docs/plan/2026-11-05-external-event-dedup-design.md）
--
-- open_api_call_log 只负责入口幂等与审计；任务域用 (scope, id) 唯一键兜底
-- “流水关闭/写失败/被清理后上游重复投递”的场景。source_event_id 语义不变。

ALTER TABLE `agent_task_trigger`
  ADD COLUMN `external_event_id`    VARCHAR(128) COLLATE utf8mb4_bin NULL COMMENT '上游事件 ID / 幂等键',
  ADD COLUMN `external_event_scope` VARCHAR(64)  COLLATE utf8mb4_bin NULL COMMENT '作用域：token:<id> 或 trigger:<id>',
  ADD UNIQUE KEY `uk_agent_task_trigger_external_event` (`external_event_scope`, `external_event_id`),
  ALGORITHM=INPLACE, LOCK=NONE;

ALTER TABLE `message_queue`
  ADD COLUMN `external_event_id`    VARCHAR(128) COLLATE utf8mb4_bin NULL COMMENT '忙时入队透传的上游事件 ID',
  ADD COLUMN `external_event_scope` VARCHAR(64)  COLLATE utf8mb4_bin NULL COMMENT '忙时入队透传的事件作用域',
  ALGORITHM=INPLACE, LOCK=NONE;
