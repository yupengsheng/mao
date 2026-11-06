ALTER TABLE `signal_watcher_check`
  ADD COLUMN `old_value_snippet` VARCHAR(1024) NULL AFTER `value_hash`,
  ADD COLUMN `new_value_snippet` VARCHAR(1024) NULL AFTER `old_value_snippet`;
