-- V200: 任务域二期等待态与执行租约（docs/plan/2026-11-05-task-domain-phase2-technical-design.md）
--
-- 本迁移只建表，不启用写入与恢复逻辑；等待摘要仅保存脱敏投影，
-- 原始参数、答案与审批意见一律不落库。

CREATE TABLE `execution_wait` (
    `id` BIGINT AUTO_INCREMENT PRIMARY KEY,
    `session_id` BIGINT NOT NULL,
    `execution_id` VARCHAR(128) NOT NULL,
    `request_type` VARCHAR(16) NOT NULL COMMENT 'APPROVAL / QUESTION',
    `request_id` VARCHAR(128) NOT NULL,
    `status` VARCHAR(16) NOT NULL COMMENT 'PENDING / RELEASED / EXPIRED',
    `payload_summary` TEXT NULL COMMENT '仅展示安全的脱敏投影，不存原始参数或答案',
    `payload_digest` CHAR(64) NULL COMMENT '原始请求规范化后的 SHA-256，仅用于幂等与诊断',
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `expires_at` DATETIME NOT NULL,
    `released_at` DATETIME NULL,
    `release_reason` VARCHAR(64) NULL,
    `fencing_token` BIGINT NOT NULL DEFAULT 0 COMMENT '写入时的执行租约 token，恢复与释放时校验',
    `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY `uk_execution_wait_request` (`session_id`, `request_type`, `request_id`),
    KEY `idx_execution_wait_pending` (`status`, `expires_at`),
    KEY `idx_execution_wait_execution` (`execution_id`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `agent_execution_lease` (
    `id` BIGINT AUTO_INCREMENT PRIMARY KEY,
    `session_id` BIGINT NOT NULL,
    `execution_id` VARCHAR(128) NOT NULL,
    `owner_instance` VARCHAR(128) NOT NULL,
    `fencing_token` BIGINT NOT NULL DEFAULT 0,
    `status` VARCHAR(16) NOT NULL COMMENT 'ACTIVE / RELEASED；过期由 expires_at 判定',
    `heartbeat_at` DATETIME NULL,
    `expires_at` DATETIME NOT NULL,
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY `uk_agent_execution_lease_session` (`session_id`),
    KEY `idx_agent_execution_lease_expiry` (`status`, `expires_at`),
    KEY `idx_agent_execution_lease_execution` (`execution_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
