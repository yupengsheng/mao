ALTER TABLE `open_api_call_log`
    ADD COLUMN `idempotency_scope` VARCHAR(64) COLLATE utf8mb4_bin NULL COMMENT '幂等作用域：token:<id> 或 trigger:<id>',
    ADD COLUMN `idempotency_key` VARCHAR(128) COLLATE utf8mb4_bin NULL COMMENT '外部幂等键/事件 ID',
    ADD COLUMN `request_fingerprint` CHAR(64) NULL COMMENT '请求语义 SHA-256',
    ADD UNIQUE KEY `uk_open_api_call_idempotency` (`idempotency_scope`, `idempotency_key`);
