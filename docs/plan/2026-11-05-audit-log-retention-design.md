# 审计日志保留清理设计

## 背景

`audit_log` 由管理 API 全局审计钩子持续写入，记录登录失败、权限与配置变更等敏感操作。V048 已提供系统设置 `audit.retentionDays`（默认 180 天）与 `idx_audit_created`，但此前没有任何 Job 消费该配置，审计日志会无限增长并持续占用存储。

## 目标

- 每小时读取一次 `audit.retentionDays`，清理超过保留期的审计日志。
- 配置缺失、空值或非法时回落到 180 天。
- 单批最多删除 5000 条，单轮最多 20 批，避免长事务和大范围锁。
- 清理幂等，多实例重复执行安全；异常只记录日志，不阻断进程。
- 不新增数据库迁移，复用 `idx_audit_created`。

## 非目标

- 不归档过期审计日志，不提供导出后删除的合规流水线。
- 不按用户、动作、成功状态或对象类型拆分保留期。
- 不修改审计写入链路、查询接口或管理后台列表行为。
- 不引入跨实例租约；多实例只保证删除条件与结果幂等。

## 实现

- `MysqlAuditLogRepository.deleteBatch(cutoff, limit)` 执行 `DELETE FROM audit_log WHERE created_at < ? ORDER BY id LIMIT <safeLimit>`，返回 `affectedRows`；`LIMIT` 钳制在 1~5000。
- `SystemSettingService.getAuditRetentionDays()` 读取 `audit.retentionDays`，只接受正整数，否则回落 180。
- `AuditLogCleanup` 使用 `setInterval` 每小时触发，`stopped` 控制生命周期，`cleaning` 防止同一进程内重复扫描。
- cutoff 通过 `formatDateTime` 生成，与数据库 `DATETIME` 的上海时区格式一致。
- 调度器装配到 `assembleLifecycle`，关闭流程显式调用 `stop()`。

## 边界

- 单轮达到 20 批上限时，剩余过期记录留到下一小时继续清理，不延长单轮执行时间。
- 多实例同时运行时可能并发删除同一批记录，但条件相同且删除的是同一保留期外的历史行，结果幂等。
- 审计日志列表、详情与分页总数只统计仍保留在库中的记录；被清理的日志不可恢复。
- 保留期修改在下一轮清理时生效，不要求重启后端。
