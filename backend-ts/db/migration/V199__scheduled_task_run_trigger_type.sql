ALTER TABLE `scheduled_task_run`
    ADD COLUMN `trigger_type` VARCHAR(16) NOT NULL DEFAULT 'SCHEDULED'
        COMMENT 'SCHEDULED=按 cron 档期触发 / MANUAL=手动立即执行'
        AFTER `fire_time`;
