-- V189: 子代理执行记录按终态与更新时间清理的索引
-- docs/plan/2026-11-05-subagent-execution-retention-design.md
--
-- 现有 idx_sae_status / idx_sae_recovery 只能按状态筛选，无法支撑全局
-- UPDATE 时间清理。在线加索引避免阻塞写入。
ALTER TABLE `subagent_execution`
  ADD INDEX `idx_sae_cleanup` (`status`, `delivery_status`, `updated_at`, `id`),
  ALGORITHM=INPLACE, LOCK=NONE;
