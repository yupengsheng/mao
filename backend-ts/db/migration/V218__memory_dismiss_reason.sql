-- USER=用户/管理员显式忽略，不自动复活；EVICTED=D14 容量淘汰，可按复现 LRU 复活。
-- 存量 DISMISSED 无法可靠识别来源，统一保守标记 USER，避免复活用户明确忽略的内容。
ALTER TABLE `memory_item`
    ADD COLUMN `dismiss_reason` VARCHAR(16) NOT NULL DEFAULT 'USER'
    COMMENT 'DISMISSED 来源：USER=显式忽略；EVICTED=容量淘汰；ACTIVE 时不读';
