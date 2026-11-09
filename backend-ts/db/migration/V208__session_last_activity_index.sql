-- V208: 会话管理列表新增「活跃时间」范围筛选（默认最近 7 天），补 last_activity_at 索引。
-- 背景：关键词搜索此前走全局消息检索，message 表较大时单次可达数十秒并触发前端超时；
-- 现在会话先按 last_activity_at 收敛到时间窗，再在窗口内消息里匹配。
-- last_activity_at 此前无索引：该列既作范围条件又是列表排序键（ORDER BY last_activity_at DESC, id DESC），
-- (last_activity_at, id) 可同时支撑范围扫描与排序 tiebreaker。session 表规模有限，加索引为原地 DDL。
ALTER TABLE `session`
  ADD INDEX `idx_session_last_activity` (`last_activity_at`, `id`);

-- 逆运算（如需回滚）：
--   ALTER TABLE `session` DROP INDEX `idx_session_last_activity`;
