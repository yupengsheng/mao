-- 信号哨兵 Shell 脚本探针：探针类型/脚本路径/超时，轮询记录保存脚本退出码。
-- 存量哨兵默认 HTTP，行为不变。
ALTER TABLE `signal_watcher`
  ADD COLUMN `probe_type` VARCHAR(16) NOT NULL DEFAULT 'HTTP' COMMENT '探针类型：HTTP/SCRIPT' AFTER `prompt_template`,
  ADD COLUMN `script_path` VARCHAR(512) NULL COMMENT '脚本相对路径（项目工作区内）' AFTER `probe_type`,
  ADD COLUMN `script_timeout_seconds` INT NULL COMMENT '脚本超时秒数（NULL=默认60）' AFTER `script_path`;

ALTER TABLE `signal_watcher_check`
  ADD COLUMN `exit_code` INT NULL COMMENT '脚本退出码（HTTP 探针为 NULL）' AFTER `http_status`;
