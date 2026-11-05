-- V183: 会话活动（运行轨迹工具明细）按创建时间清理的索引 + 保留期设置
-- docs/plan/2026-11-05-session-activity-retention-design.md
--
-- session_activity 原有 idx_session_created(session_id, created_at) 只适合按会话查询；
-- 全局按 created_at 清理需要单独索引，避免全表扫描。在线加索引避免阻塞写入。
ALTER TABLE `session_activity`
  ADD INDEX `idx_session_activity_created` (`created_at`),
  ALGORITHM=INPLACE, LOCK=NONE;

-- 默认 180 天；最低 90 天，确保管理后台 90 天分析与运行轨迹榜单窗口有完整数据。
INSERT IGNORE INTO `system_setting` (`setting_key`, `value`, `category`, `description`, `editable`)
VALUES ('usage.sessionActivityRetentionDays', '180', '用量', '会话活动（运行轨迹工具明细）保留天数（滚动清理，最少 90 天）', 1);
