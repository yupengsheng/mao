-- V181: 入站幂等记录按创建时间清理的索引
--
-- feishu_inbound_event / dingtalk_inbound_event 每个入站消息一行，只用于短期去重。
-- 后台 Job 每小时执行 DELETE ... WHERE created_at < ? ORDER BY id LIMIT n；
-- 原先没有 created_at 索引，清理会退化为全表扫描。在线加索引避免阻塞写入。

ALTER TABLE `feishu_inbound_event`
  ADD INDEX `idx_feishu_inbound_created` (`created_at`),
  ALGORITHM=INPLACE, LOCK=NONE;

ALTER TABLE `dingtalk_inbound_event`
  ADD INDEX `idx_dingtalk_inbound_created` (`created_at`),
  ALGORITHM=INPLACE, LOCK=NONE;
