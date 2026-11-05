# Mao 开放接口文档

以机器身份把外部系统接入 Mao Agent。API Token 在「设置 → 开放接口」页面签发；本文档说明拿到 Token 之后如何调用。

## 基础约定

| 项 | 值 |
|----|----|
| Base URL | `https://<你的 Mao 域名>/api/v1`（自托管实例换成自己的域名） |
| 鉴权 | 请求头 `Authorization: Bearer mao_xxx`（API Token 明文） |
| 响应格式 | `{ "code": 0, "message": "", "data": {}, "timestamp": 0 }`，`code === 0` 表示成功 |
| Token 权限 | scope 仅 `open:run`，只能调用本文档中的 `/open/**` 端点，调用其它接口一律 401 |
| 限流 | 每 Token 60 次/分钟，超限返回 429 并带 `Retry-After` 头 |

Token 的签发、查看、吊销，以及触发器与订阅的管理只接受登录会话（JWT），不接受 API Token，请在「设置 → 开放接口」页面操作。

## 一、触发一次 Agent 运行

`POST /open/agents/:agentId/run`

异步触发一轮 Agent 执行，恒返回 202：消息进入执行队列后立即返回，不等待执行结果。执行结果可通过 WebSocket / mao-agent 查看，或配置出站订阅推送到你的系统（见第三节）。

请求头：

- `Authorization: Bearer mao_xxx`
- `Content-Type: application/json`
- `Idempotency-Key: <可选，1~128 个可打印 ASCII 字符>`：抵御超时重投。按 Token 隔离，同键同请求只执行一次

请求体：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `message` | string | 是 | 触发消息全文 |
| `sessionId` | integer | 否 | 复用会话；必须是该 Agent 名下的会话，不一致返回参数错误。缺省每次新建会话 |

响应（202）`data`：

| 字段 | 类型 | 说明 |
|------|------|------|
| `sessionId` | integer | 执行所在会话 |
| `messageId` | integer | 本轮消息 ID |
| `queued` | boolean | `true` 表示目标会话正忙，消息已进入待发送队列 |
| `deduplicated` | boolean | 仅在重复请求出现；`true` 表示未再次执行，回放首次受理结果 |
| `processing` | boolean | 重复请求命中 `pending` / `queued` 时为 `true`，表示首次请求仍在处理 |

幂等语义：

- 指纹绑定 `agentId`、`sessionId` 与 `message`；同键但任一字段不同返回参数错误，不会启动执行。
- 首次请求已被拒绝（参数错误、预算拦截等）时，该键不可复用，修正后需换新键。
- 幂等记录复用调用流水，只在流水保留期内有效（默认 90 天，可配 `openapi.callLogRetentionDays`）。
- 首次流水为 `pending` 时，若服务进程崩溃，状态可能长期停留；本期不做自动恢复，需换新键重试。

curl 示例：

```bash
curl -X POST 'https://mao.example.com/api/v1/open/agents/12/run' \
  -H 'Authorization: Bearer mao_xxxxxxxx' \
  -H 'Idempotency-Key: nightly-2026-11-04' \
  -H 'Content-Type: application/json' \
  -d '{"message": "跑一遍 nightly 巡检"}'
```

## 二、入站 Webhook 触发器

`POST /open/hooks/:pathToken`

公开端点，不使用 Bearer Token，改用 HMAC-SHA256 验签。URL 与 Secret 在「设置 → 开放接口」创建触发器时生成，Secret 只展示一次，泄露可轮换。

请求头：

| 头 | 说明 |
|----|------|
| `X-Mao-Event-Id` | 可选，1~128 个可打印 ASCII 字符；按触发器隔离，同一次外部事件重复投递只执行一次 |
| `X-Mao-Timestamp` | Unix 秒级时间戳，容忍 ±300 秒 |
| `X-Mao-Signature` | `sha256=<hex(HMAC-SHA256(secret, "<timestamp>.<原始请求体>"))>` |

签名串为时间戳与请求体原文以英文句点连接，服务端按收到的原始字节校验。请求体原文会作为事件内容交给 Agent（超过 8000 字符截断）。带 `X-Mao-Event-Id` 时，相同事件 ID 但请求体不同会返回参数错误；已拒绝的事件 ID 不能复用。

Python 示例：

```python
import hashlib, hmac, json, time, urllib.request

secret = "<trigger-secret>"
url = "<trigger-url>"
body = json.dumps({"issue": "disk almost full"}).encode()
ts = str(int(time.time()))
digest = hmac.new(secret.encode(), f"{ts}.".encode() + body, hashlib.sha256).hexdigest()
req = urllib.request.Request(url, data=body, method="POST", headers={
    "Content-Type": "application/json",
    "X-Mao-Event-Id": "disk-alert-20261104-001",
    "X-Mao-Timestamp": ts,
    "X-Mao-Signature": f"sha256={digest}",
})
print(urllib.request.urlopen(req).read())
```

响应（202）`data`：`{ "sessionId": 12, "queued": false }`。重复事件会带 `deduplicated: true`；首次仍在处理时还会带 `processing: true`，不会再启动一次执行。

失败返回：

- 404 + `{ "code": 3040, "message": "not found" }`：触发器不存在、已停用或验签失败（统一措辞，不区分）
- 429：触发器限流（绑定会话 30 次/分钟，未绑定 10 次/分钟），读 `Retry-After` 后重试

连续 5 次执行失败会自动停用触发器，并在站内收件箱推送「触发器停用」通知。

## 三、出站事件订阅（Mao → 你的系统）

在「设置 → 开放接口」配置订阅后，任务完成/失败或 Agent 提问时，Mao 向你的 HTTPS 端点 POST 事件。

请求头：

| 头 | 说明 |
|----|------|
| `X-Mao-Event` | 事件类型 |
| `X-Mao-Timestamp` | Unix 秒级时间戳 |
| `X-Mao-Signature` | 签名算法同触发器，对实际发送的字节计算 |

`task.completed` / `task.failed` 请求体：

```json
{
  "event": "task.completed",
  "sessionId": 12,
  "userId": 3,
  "executionId": "exec-xxx",
  "phase": "COMPLETED",
  "title": "会话标题",
  "failureReason": null,
  "source": "API",
  "sentAt": "2026-10-12 10:00:00"
}
```

`question.pending` 请求体：

```json
{
  "event": "question.pending",
  "sessionId": 12,
  "userId": 3,
  "requestId": "req-xxx",
  "sentAt": "2026-10-12 10:00:00"
}
```

`digest.daily`（每日运营摘要）请求体：

```json
{
  "event": "digest.daily",
  "coveredDate": "2026-10-11",
  "digest": {
    "coveredDate": "2026-10-11",
    "tasks": { "completed": 3, "failed": 1, "failedTop": [] },
    "scheduled": null,
    "watchers": null,
    "approvals": null,
    "cost": { "totalMicros": 3420000, "unpricedCalls": 0, "calls": 5, "top": [] },
    "openApi": null
  },
  "text": "# 昨日运营摘要（2026-10-11）\n...",
  "sentAt": "2026-10-12 09:30:00"
}
```

`digest` 为六板块结构化数据（tasks / scheduled / watchers / approvals / cost / openApi，无数据的板块为 null），`text` 为 Markdown 全文，任选其一渲染。

投递语义：返回 2xx 视为成功；429 与 5xx 按 1 / 5 / 25 分钟退避重试，3 次后置为失败并保留记录，不会无限重投。最近投递记录可在订阅卡片上查看。投递记录保留 90 天，成功 / 失败历史每小时自动清理；排队中与发送中的记录不会被清理。

## 四、错误码

| code | 含义 | 处理 |
|------|------|------|
| 1001 | 未登录 / Token 无效 | 检查 Token 是否过期或已吊销，或用在了 `/open` 之外的端点 |
| 1002 | 无权限 | 用登录会话 JWT 调了 run 端点；run 只接受 `mao_` Token |
| 1007 | 请求过于频繁 | 超过每 Token 60 次/分钟，读 `Retry-After` 后重试 |
| 2001 | 参数校验失败 | 检查 `message` 为字符串、`sessionId` 为正整数且属于该 Agent；也可能是幂等键格式不合法、同键不同指纹、或复用了已拒绝的键 |
| 3040 | 触发器不存在 | 不存在 / 已停用 / 验签失败，统一措辞不区分 |
| 3043 | Token 已自动停用 | 一小时内连续失败达到阈值；在设置页「重新启用」后恢复 |
| 3054 | 触发来源未通过准入 | 固定短语，不区分具体原因；检查 Token scope / 状态、触发器启用与绑定会话、哨兵状态与复用指针 |
| 3055 | 准入检查暂不可用 | 服务端读取准入资源失败；稍后重试，不会启动执行 |

## 五、排障

| 现象 | 原因与处理 |
|------|-----------|
| run 返回 403「该端点仅接受 API Token（mao_）调用」 | 用了登录会话 JWT 调 run；run 只认 `mao_` Token |
| run 返回 401 | Token 过期 / 已吊销，或 Token 用在了 `/open` 之外的端点 |
| run 返回 403「Token 已因连续失败被自动停用」 | 一小时内失败达到阈值；在设置页「重新启用」后恢复 |
| hook 返回 404 + `not found` | 触发器不存在、已停用，或签名 / 时间戳不通过 |
| hook 返回 429 | 触发器限流；读 `Retry-After` 后重试 |
| 收件箱出现「触发器停用」 | 连续 5 次执行失败已自动停用；排除外部系统问题后重新启用 |
| run 返回 403 + `3054` | Token 缺少 `open:run`、已吊销 / 过期 / 自动停用，或归属不匹配；对应原因修正后重试 |
| hook 返回 403 + `3054` | 触发器已停用、Agent 或绑定会话与本次请求不一致；确认触发器配置后重新启用 |
| 返回 503 + `3055` | 准入依赖暂不可用，执行未启动；稍后重试。该错误不计入触发器连续失败 |
| 重试返回 `deduplicated: true` | 幂等键命中了首次请求，未再次执行；`processing: true` 表示首次仍在处理 |
| 重试一直返回 `processing: true` | 首次流水仍是 `pending` / `queued`。查调用记录确认；若进程崩溃导致 `pending` 长期不结束，本期无自动恢复，需换新键 |
| 返回「幂等键已用于其他请求」 | 同键的 `agentId` / `sessionId` / `message` 或 Webhook 原始请求体已变化；修正后换新键 |
| 返回「该幂等键对应的请求已被拒绝」 | 首次请求已失败，不能复用该键；修正原因后换新键 |

每次调用（含参数错误、鉴权失败、限流拒绝）都会留下流水：Token / 触发器卡片上的「调用记录」看自己的，管理后台「开放调用」看全量。带幂等键的重复请求不新增流水，只回放首次受理结果。默认只记录消息长度与字段名，不记正文；如需完整请求体，可在 Token 卡片上开启「完整记录」（可能含敏感信息，操作留审计）。
