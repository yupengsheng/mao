# 飞书进度卡映射保留清理设计

## 背景

`feishu_progress_card` 记录每个飞书会话当前活跃的进度卡片（Bot、`card_message_id`、聊天类型、群 ID、触发者 `open_id`），用于任务进行中的卡片续更、进程重启后的崩溃恢复续更，以及取消按钮鉴权。

正常投递结束且终态不是失败时，`onExecutionFinished` 会调用 `deleteBySessionId` 删除映射。失败会话不会删除，进程中断也可能留下残留行；表只有 `session_id` 唯一键，缺少按时间清理的扫描路径，长期运行会持续增长。

## 目标

- 每小时清理一次超过 180 天的进度卡映射。
- 只清理会话已不存在、已逻辑删除、或处于非活跃相位的行。
- 活跃相位（`RUNNING` / `RESUMING` / `WAITING_APPROVAL` / `CANCELLING`）永不清理，保证运行中的卡片续更、崩溃恢复与取消鉴权不受影响。
- 单批最多删除 5000 条，单轮最多 20 批，避免长事务与大范围锁。
- 清理幂等，多实例重复执行安全；异常只记录日志，不阻断进程。
- 新增 `(updated_at, id)` 索引支撑按时间扫描。

## 非目标

- 不改变进度卡创建、更新、恢复与取消逻辑。
- 不删除飞书入站消息、私聊消息 → 会话映射或会话本体。
- 不按 Bot、聊天类型或用户拆分保留期。
- 不归档过期映射；超过保留期后不能从数据库恢复。

## 保留期与时间口径

- **180 天**：映射只服务进行中会话与崩溃恢复，半年足够覆盖排障与低频恢复。
- **按 `updated_at` 清理**：卡片映射更新会刷新 `updated_at`，从最后一次使用开始计时。
- **活跃相位保护**：即使映射超过 180 天，只要对应会话仍在活跃相位就保留。活跃相位统一取 `ACTIVE_PHASES`，SQL 条件由 `ACTIVE_PHASE_SQL_LIST` 派生，避免与运行态口径漂移。
- **每小时执行**：与现有清理 Job 一致；单轮未完成时跳过后续触发。

## 索引

V192 新增：

- `feishu_progress_card (updated_at, id)`

现有 `uk_feishu_progress_card_session(session_id)` 只服务按会话读取与去重，无法支撑全局按更新时间扫描。新索引前缀匹配 `updated_at < cutoff`，后缀支撑稳定排序与分批。

## 实现

- `MysqlFeishuProgressCardRepository.deleteStaleBatch(cutoff, limit)`：
  - 先用派生表从 `feishu_progress_card p LEFT JOIN session s` 选出候选 `id`；
  - 条件为 `p.updated_at < ?` 且（`s.id IS NULL` 或 `s.deleted = 1` 或 `s.phase IS NULL` 或 `s.phase NOT IN (活跃相位)`）；
  - `ORDER BY p.updated_at, p.id LIMIT n`；
  - 再按主键删除，返回 `affectedRows`。
- `limit` 钳制到 `1..5000`，非法值回落 1，不把外部输入拼进 SQL。
- `FeishuProgressCardCleanup` 使用 `setInterval` 每小时触发，`stopped` 控制生命周期，`cleaning` 防止同一进程内并发扫描。
- cutoff 通过 `formatDateTime` 生成，与数据库 `DATETIME` 格式一致。
- 单批异常被捕获并记录日志，返回本轮已成功删除的数量；下一小时继续执行。
- 清理器装配到 `assembleLifecycle`，关闭流程显式调用 `stop()`。

## 边界

- 映射删除后，超期旧进度卡不能再续更，也不能通过取消按钮回查会话；会话消息本体不受影响。
- 会话被逻辑删除后，其过期映射会被清理；会话恢复不在现有产品能力内。
- 单轮达到 20 批上限时，剩余记录留到下一小时继续清理。
- 多实例同时运行可能并发删除同一批行；条件相同且删除幂等，不引入跨实例租约。

## 测试

- repository：按 `updated_at` 截止、联表条件覆盖不存在 / 已删除 / 非活跃相位、活跃相位不进入候选、稳定排序、返回 `affectedRows`，并钳制 0、`NaN`、`Infinity` 与超限值。
- cleanup：180 天 cutoff、分批、20 批上限、start 幂等 / stop、并发跳过、异常日志与已删除数量返回。
