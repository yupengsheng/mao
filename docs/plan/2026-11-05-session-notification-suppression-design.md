# 会话删除与边路提升抑制未发送通知设计

## 背景

`task_notification_delivery` 保存任务完成 / 失败、提问待答与审批待办的外部提醒。会话删除后，该会话可能仍有 `WAITING_WS`、`PENDING` 或 `SENDING` 的投递行：它们会按重试计划继续发往钉钉 / 飞书 / 邮件，且正文里的会话详情链接已经失效。虽然调度器最终会把重试耗尽的行置为 `FAILED`，不会永久停留，但删除会话后继续收到提醒不符合用户预期。

边路任务提升是「插入新主会话 + 逻辑删除旧边路会话」，同样不会经过 `onSessionDeleted`。旧边路会话不再可达，若其未发送提醒继续外推，用户会收到指向已失效会话的通知，因此提升路径需要同一抑制语义。

## 目标

- 删除会话时，同一用户的该会话所有未终态投递行立即抑制为 `SUPPRESSED_WS`。
- 边路任务提升时，在同一事务内抑制旧边路会话的所有未终态投递行。
- 清空 `next_retry_at`，调度器不再挑选这些行。
- 已成功 / 已失败的历史投递行保持原状，便于事后排障。
- 抑制失败只告警，不阻断会话删除或其他会话级资源回收。

## 非目标

- 不删除任何投递流水，不改变 90 天历史清理周期。
- 不改变通知偏好、WS 抑制、发送前状态重查与终态 CAS 的既有语义。
- 不迁移历史投递流水到提升后的新会话：提醒属于旧边路会话的等待期，提升后不再有继续外推的意义。
- 不为历史已删除会话做一次性补扫。

## 实现

### 存储层

`DeliveryDbStore.suppressPendingBySession(sessionId)`：

```sql
UPDATE task_notification_delivery
   SET status = 'SUPPRESSED_WS', next_retry_at = NULL
 WHERE session_id = ? AND status IN ('WAITING_WS', 'PENDING', 'SENDING');
```

仅命中非终态行；单条条件更新与调度器 `claim` / 发送前重查天然竞争安全。

### 服务与删除钩子

`TaskNotificationDeliveryService.suppressPendingBySession(sessionId)` 校验内部 ID 后调用存储层，便于其他装配复用。`create-app.ts` 的 `onSessionDeleted` 在清理 Webhook 绑定之后、回收任务域之前调用，并单独捕获异常告警。

`SessionService.promoteSideTaskToMainSession()` 在同一事务内、逻辑删除旧边路会话之前执行同样的条件更新：参数为旧边路会话 ID，状态集合与存储层一致，清空 `next_retry_at`。提升失败整体回滚，不会出现「会话已提升但提醒仍可投递」的中间态。

### 竞态

- 行已被 `claim` 成 `SENDING`：`deliver()` 发送前会 `findById` 重查，看到 `SUPPRESSED_WS` 即跳过发送。
- 发送已越过重查：终态回写使用 `WHERE status = 'SENDING'` 的 CAS，抑制后的行不会被覆盖回 `SUCCEEDED` / `PENDING`；极窄窗口内可能仍发出一次，与现有 WS 抑制竞态语义一致。
- 删除钩子执行失败：行保持原状态，按既有重试 / 失败收敛，不产生永久停留。

## 测试

- 服务层只对合法正会话 ID 调用存储层，非法 ID 直接返回。
- 存储层 SQL 只更新三类非终态，并清空重试时间。
- 边路提升事务用例断言抑制 SQL 以旧边路会话 ID 执行，且状态集合仅含非终态。
- 现有通知抑制、调度重试与终态 CAS 用例保持通过。
