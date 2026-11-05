-- V201: 崩溃恢复后的等待只读投影标记（docs/plan/2026-11-05-task-domain-phase2-technical-design.md §7.3）
--
-- recovered_at 非空表示该 PENDING 行已由恢复扫描投影为只读通知；旧 Promise 不再存在，
-- 客户端只能查看，不能在此审批或回答。空值表示仍由进程内等待链路承载。

ALTER TABLE `execution_wait`
    ADD COLUMN `recovered_at` DATETIME NULL
        COMMENT '恢复扫描标记为只读投影的时间；NULL 表示仍由进程内 Promise 承载'
        AFTER `release_reason`;
