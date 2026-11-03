CREATE TABLE IF NOT EXISTS `agent_task` (
    `id` BIGINT AUTO_INCREMENT PRIMARY KEY,
    `user_id` BIGINT NOT NULL,
    `agent_id` BIGINT NULL,
    `session_id` BIGINT NOT NULL,
    `title` VARCHAR(512) NOT NULL,
    `stage` VARCHAR(32) NOT NULL,
    `source` VARCHAR(32) NOT NULL,
    `policy_version` VARCHAR(64) NULL,
    `last_execution_id` VARCHAR(128) NULL,
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    `deleted` TINYINT NOT NULL DEFAULT 0,
    UNIQUE KEY `uk_agent_task_session` (`session_id`),
    KEY `idx_agent_task_user_stage_updated` (`user_id`, `stage`, `updated_at`),
    KEY `idx_agent_task_user_source_updated` (`user_id`, `source`, `updated_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `agent_task_trigger` (
    `id` BIGINT AUTO_INCREMENT PRIMARY KEY,
    `task_id` BIGINT NOT NULL,
    `session_id` BIGINT NOT NULL,
    `source` VARCHAR(32) NOT NULL,
    `source_event_id` VARCHAR(128) NOT NULL,
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY `uk_agent_task_trigger_event` (`source_event_id`),
    KEY `idx_agent_task_trigger_task` (`task_id`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `agent_task_execution` (
    `id` BIGINT AUTO_INCREMENT PRIMARY KEY,
    `task_id` BIGINT NOT NULL,
    `session_id` BIGINT NOT NULL,
    `execution_id` VARCHAR(128) NOT NULL,
    `attempt_no` INT NOT NULL,
    `status` VARCHAR(32) NOT NULL,
    `started_at` DATETIME NULL,
    `finished_at` DATETIME NULL,
    `failure_reason` TEXT NULL,
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY `uk_agent_task_execution_id` (`execution_id`),
    KEY `idx_agent_task_execution_task_created` (`task_id`, `created_at`),
    KEY `idx_agent_task_execution_session_created` (`session_id`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
