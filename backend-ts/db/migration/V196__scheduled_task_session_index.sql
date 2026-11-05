-- 会话删除需要按 session_id 回收定时任务与运行状态；运行行也按会话做终态对账。
ALTER TABLE `scheduled_task`
    ADD KEY `idx_scheduled_task_session` (`session_id`);

ALTER TABLE `scheduled_task_run`
    ADD KEY `idx_task_run_session_status` (`session_id`, `status`);
