-- 后台长期记忆管理：只向系统管理员授予写权限，不扩权现有只读审计角色。
INSERT INTO `permission` (`name`, `code`, `description`)
SELECT '管理用户记忆', 'memory:write', '编辑、忽略、恢复、删除、代建任意用户的长期记忆'
WHERE NOT EXISTS (SELECT 1 FROM `permission` WHERE `code` = 'memory:write');

INSERT IGNORE INTO `role_permission` (`role_id`, `permission_id`)
SELECT 1, id FROM `permission` WHERE `code` = 'memory:write';

UPDATE `permission`
SET `description` = '查询、搜索任意用户的长期记忆内容及记忆用户选择器（治理审计用途）'
WHERE `code` = 'memory:read';
