ALTER TABLE `signal_watcher`
  ADD COLUMN `last_change_old_snippet` VARCHAR(1024) NULL AFTER `last_value_snippet`,
  ADD COLUMN `last_change_new_snippet` VARCHAR(1024) NULL AFTER `last_change_old_snippet`;
