ALTER TABLE `feishu_pending_binding_message`
  ADD COLUMN `binding_method` VARCHAR(16) NOT NULL DEFAULT 'OAUTH' COMMENT 'OAUTH/PASSWORD' AFTER `status`,
  ADD COLUMN `replayed_at` DATETIME NULL COMMENT '原消息已受理的时间' AFTER `binding_method`;

ALTER TABLE `dingtalk_pending_binding_message`
  ADD COLUMN `binding_method` VARCHAR(16) NOT NULL DEFAULT 'OAUTH' COMMENT 'OAUTH/PASSWORD' AFTER `status`;
