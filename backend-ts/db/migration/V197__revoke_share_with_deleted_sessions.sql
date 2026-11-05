-- V197: 会话删除后，历史分享行可能仍保持 revoked_at = NULL（读取侧已按会话存在性拒绝）。
-- 回填撤销：会话已逻辑删除或已不存在时，链接不应继续显示为“未撤销”。
UPDATE `session_share` ss
LEFT JOIN `session` s ON s.id = ss.session_id
SET ss.revoked_at = CURRENT_TIMESTAMP
WHERE ss.revoked_at IS NULL
  AND (s.id IS NULL OR s.deleted = 1);
