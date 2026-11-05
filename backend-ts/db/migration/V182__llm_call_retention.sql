-- LLM 调用流水保留天数（docs/plan/2026-11-05-llm-call-retention-design.md）
-- 默认 180 天；最低 90 天，确保管理后台 90 天分析窗口始终有完整数据。
INSERT IGNORE INTO `system_setting` (`setting_key`, `value`, `category`, `description`, `editable`)
VALUES ('usage.llmCallRetentionDays', '180', '用量', 'LLM 调用流水保留天数（滚动清理，最少 90 天）', 1);
