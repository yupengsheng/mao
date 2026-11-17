-- V220: 出站投递恢复需要按最后状态推进时间判断 SENDING 是否卡死。
-- created_at 只表示事件入队时间，不能用于区分仍在执行的老投递。
ALTER TABLE `outbound_delivery`
    ADD COLUMN `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP
        ON UPDATE CURRENT_TIMESTAMP
        AFTER `created_at`,
    ADD COLUMN `claim_token` VARCHAR(64) NULL
        COMMENT '当前 SENDING 认领者的唯一 token；恢复/结算时用于防 ABA'
        AFTER `updated_at`;
