# runtime — 运行监控

管理后台已移除「运行监控」页面；本 CLI 与后端接口仍保留，用于查看运行态会话。

## 用途

查看运行相关会话列表。

## 命令选择

| 场景 | 命令 |
|------|------|
| 运行态会话列表 | `runtime sessions` |

与 `session list` 的区别：未传 `--phase` 时，服务端默认聚焦  
`RUNNING,RESUMING,WAITING_APPROVAL,CANCELLING,FAILED,CANCELLED`（活跃相位来自 `ACTIVE_PHASES`）。

## 命令：runtime sessions

| 参数 | 必填 | 类型 | 默认 | 含义 | 后端字段 |
|------|------|------|------|------|----------|
| `--page` | 否 | 整数 | 1 | 页码 | `page` |
| `--size` | 否 | 整数 | 20 | 每页 | `size` |
| `--user-id` | 否 | 整数 | — | 用户 ID | `userId` |
| `--agent-id` | 否 | 整数 | — | Agent ID | `agentId` |
| `--execution-mode` | 否 | 字符串 | — | `CLOUD`/`LOCAL` 等 | `executionMode` |
| `--phase` | 否 | 字符串 | 见上默认 | 阶段过滤（可逗号多值，由服务端解析） | `phase` |
| `--keyword` | 否 | 字符串 | — | 关键词 | `keyword` |
| `--status` | 否 | 字符串 | — | 状态 | `status` |

`GET /admin/runtime/sessions`（需 `session:read`）

```bash
mao runtime sessions --page 1 --size 20
mao runtime sessions --phase RUNNING --execution-mode LOCAL
```

## 执行环境注入

云端 shell、Web 终端、容器 shell 与容器 MCP 会从系统设置的站点根地址注入 `MAO_BASE_URL`，供 `mao` / `mao-agent` 等客户端明确连接当前站点；未配置站点地址时不会注入。容器脚本探针还会收到 `MAO_DEPS_DIR`，用于校验 npm / pip 依赖路径必须位于当前用户的依赖根下。

LOCAL 父会话若绑定了目标设备，创建子代理时会继承该设备。目标设备离线时请求会失败，不会为了“找一台在线设备”广播到同一用户的其他设备。

## 成功失败判断

- `code===0` 成功
- 列表结构与管理端会话列表一致（`records`/`total`/`page`/`size`）
