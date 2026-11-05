-- V185: 群消息日志按创建时间清理的索引
-- docs/plan/2026-11-05-group-message-log-retention-design.md
--
-- 原有索引都以 app_id/chat_id 或 bot_id/conversation_id 开头，无法服务跨会话的
-- WHERE created_at < ? ORDER BY created_at, id 清理查询。在线加索引避免阻塞写入。

ALTER TABLE `feishu_group_message_log`
  ADD INDEX `idx_feishu_group_message_created` (`created_at`, `id`),
  ALGORITHM=INPLACE, LOCK=NONE;

ALTER TABLE `dingtalk_group_message_log`
  ADD INDEX `idx_dingtalk_group_message_created` (`created_at`, `id`),
  ALGORITHM=INPLACE, LOCK=NONE;
