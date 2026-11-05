-- V186: 飞书私聊消息映射按创建时间清理的索引
-- docs/plan/2026-11-05-feishu-p2p-message-retention-design.md
--
-- feishu_p2p_message 每个私聊入站/出站消息一行，只用于引用切换与最近入站回复定位。
-- 现有索引以 app_id/session_id 开头，无法服务跨会话的 WHERE created_at < ? 清理；
-- 在线加索引避免阻塞消息映射写入。

ALTER TABLE `feishu_p2p_message`
  ADD INDEX `idx_feishu_p2p_message_created` (`created_at`, `id`),
  ALGORITHM=INPLACE, LOCK=NONE;
