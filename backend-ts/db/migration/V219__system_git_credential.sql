-- 系统默认 Git 凭据：管理员按域名托管加密 Token，用户未配置同域时兜底。
-- 与 user_git_credential 共用 APP_GIT_CREDENTIAL_SECRET（AES-CBC），不引入新密钥。
CREATE TABLE IF NOT EXISTS `system_git_credential` (
    `id`           BIGINT PRIMARY KEY AUTO_INCREMENT,
    `domain`       VARCHAR(255) NOT NULL COMMENT 'Git 服务器域名',
    `access_token` VARCHAR(2048) NOT NULL COMMENT 'Access Token（AES 加密存储）',
    `description`  VARCHAR(512) NULL COMMENT '备注',
    `created_at`   DATETIME DEFAULT CURRENT_TIMESTAMP,
    `updated_at`   DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY `uk_system_git_domain` (`domain`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  COMMENT='系统默认 Git 凭据（管理员配置，用户未配置时兜底）';
