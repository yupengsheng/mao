-- 会话删除时需要按 session_id 直接回收话题映射；现有 (app_id, session_id) 无法覆盖该查询。
ALTER TABLE `feishu_thread_session` ADD KEY `idx_feishu_thread_session_session_id` (`session_id`);
