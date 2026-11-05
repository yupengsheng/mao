-- V187: 飞书完成卡快照按最后写入时间自动清理（180 天）。
-- 使用 updated_at 而非 created_at：同一张卡重试后会覆盖快照，保留期应从最后一次终态写入重新计算。
ALTER TABLE `feishu_card_snapshot`
    ADD KEY `idx_feishu_card_snapshot_cleanup` (`updated_at`, `id`);
