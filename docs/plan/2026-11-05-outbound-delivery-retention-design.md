# 出站事件投递历史留存清理设计

## 背景

`outbound_delivery` 是出站事件订阅的投递流水。重试调度只扫描 `PENDING` / `SENDING`，进入 `SUCCEEDED` / `FAILED` 后不再读取；Repository 虽然已有 `deleteHistory`，但没有调度器调用，导致终态行无限增长。调用流水与任务通知投递均采用 90 天保留口径，本设计与之对齐。

## 目标

- 每小时清理一次超过 90 天的 `SUCCEEDED` / `FAILED` 投递记录。
- 每批删除 5000 条，单轮最多 20 批，避免一次长事务和大范围锁。
- 与出站投递重试调度完全解耦，不影响每 5 秒一次的到期投递领取和发送。
- 清理幂等，多实例重复执行安全；异常只记录日志，不阻断进程。

## 非目标

- 不清理 `PENDING` / `SENDING`，避免影响重试中的投递。
- 不修改订阅配置，不归档投递 payload，不提供可按订阅单独配置的保留期。
- 不处理 Webhook 原始事件 ID 的持久化去重；该能力属于独立后续阶段。

## 实现

- `OutboundDeliveryCleanup` 使用 `setInterval` 每小时触发，`stopped` 控制生命周期，`cleaning` 防止同一进程内重复扫描。
- cutoff 通过 `formatDateTime` 生成，与数据库时间字段格式一致。
- `MysqlOutboundDeliveryRepository.deleteHistory(cutoff, limit)` 只删除 `status IN ('SUCCEEDED', 'FAILED') AND created_at < cutoff` 的行，使用 `ORDER BY id LIMIT <safeLimit>` 并返回 `affectedRows`。
- 调度器装配到 `assembleLifecycle`，关闭流程显式调用 `stop()`；启动与关闭顺序与调用流水清理保持一致。

## 边界

- 单轮达到 20 批上限时剩余历史留到下一小时继续清理，不延长单轮执行时间。
- 多实例同时运行时可能发生并发删除，但删除条件相同且删除终态行，结果幂等；不引入跨实例租约。
- `GET /v1/open/subscriptions/:id/deliveries` 只返回仍保留在库中的记录，90 天前的终态记录会自然消失。
