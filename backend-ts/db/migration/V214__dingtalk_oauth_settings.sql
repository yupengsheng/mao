-- V214: 钉钉 OAuth 登录配置后台化。绑定用登录应用，须与机器人同一企业。
-- 旧环境变量 DINGTALK_OAUTH_CLIENT_ID / DINGTALK_OAUTH_SECRET / DINGTALK_OAUTH_REDIRECT_URI
-- 由 SettingsBootstrap 首次启动导入；后台保存过的行不被覆盖。
INSERT IGNORE INTO `system_setting` (`setting_key`, `value`, `category`, `description`, `editable`) VALUES
('dingtalk.oauth.clientId', NULL, '集成配置', '钉钉 OAuth Client ID（绑定用登录应用，须与机器人同一企业）', 1),
('dingtalk.oauth.clientSecret', NULL, '集成配置', '钉钉 OAuth Client Secret', 1),
('dingtalk.oauth.redirectUri', NULL, '集成配置', '钉钉 OAuth 回调地址', 1);

UPDATE `system_setting` SET `is_secret` = 1 WHERE `setting_key` = 'dingtalk.oauth.clientSecret';
