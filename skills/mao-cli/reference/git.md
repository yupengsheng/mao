# Git 凭证模块（git）

## 模块职责

管理当前用户的 Git 访问凭证（域名 + access token），供 CLOUD 模式按 git URL 克隆等场景使用。

## 命令选择

| 场景 | 命令 |
|------|------|
| 列表 | `git list` |
| 新建 | `git create` |
| 更新 | `git update` |
| 删除 | `git delete` |

管理端另有按用户查看/删除凭证的接口：`GET /v1/admin/users/:id/git-credentials`（`user:read`）、
`DELETE /v1/admin/users/:id/git-credentials/:credentialId`（`user:write`），Token 同样脱敏，供用户详情视图使用。

## 系统默认凭据

管理员可在「系统设置 → 系统默认 Git 凭据」按域名维护公共兜底 Token（读需 `settings:read`，写需 `settings:write`）。Token 加密入库，列表仅返回掩码；编辑时 Token 留空保留原值，删除整条配置即取消该域兜底。请仅配置可向平台用户开放的最小权限凭据。

用户「设置 → Git 凭证」会显示本人尚未覆盖的系统默认域名与备注，不展示系统 Token；同域个人凭据始终优先。Agent 编辑页的候选域名来自全站个人凭据与系统默认域的并集，仅返回域名、不返回 Token 或用户归属。

REST：`GET|POST /v1/admin/git-default-credentials`、`PUT|DELETE /v1/admin/git-default-credentials/:id`；`GET /v1/admin/git-domains` 需 `agent:read`；`GET /v1/user/git-default-credentials` 为已登录用户只读列表。CLI 当前未封装系统默认凭据子命令，需要时直接调 REST。

---

## 命令：mao git list

### 用途

列出已保存的 Git 凭证。返回中的 `accessToken` 会被服务端脱敏为 `****`。

### 参数说明

无。

### 示例

```bash
mao git list --json
```

---

## 命令：mao git create

### 用途

新增一条域名凭证。

### 参数说明

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--domain` | 是 | 字符串 | Git 主机域名，如 `github.com` → `domain` |
| `--access-token` | 是 | 字符串 | 访问令牌 → `accessToken` |
| `--description` | 否 | 字符串 | 备注 → `description` |

### 示例

```bash
mao git create --domain git.example.com --access-token 'ghp_xxx' --description '工作账号'
```

---

## 命令：mao git update

### 用途

更新已有凭证。至少提供一个字段。

### 参数说明

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--id` | 是 | 数字 | 凭证 ID |
| `--access-token` | 否 | 字符串 | 新 token |
| `--description` | 否 | 字符串 | 新备注 |

注意：域名创建后不可通过本命令修改。

### 示例

```bash
mao git update --id 2 --access-token 'new_token'
```

---

## 命令：mao git delete

### 参数说明

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--id` | 是 | 数字 | 凭证 ID |

### 示例

```bash
mao git delete --id 2
```

## 注意事项

- access token 属于敏感信息，避免写入 shell 历史时可改用环境变量拼命令
- 克隆地址（`workspace-mode=git` 的 `gitCloneUrl`）**不要携带账号或 Token**，服务端会直接拒绝；鉴权统一由该域名的凭证经 `GIT_ASKPASS` 与 `GIT_TOKEN_<域名>` 环境变量完成
- 凭证会被写进工作区 `.git/config`、会话日志与对话历史，因此任何位置都不要把 Token 拼进仓库 URL
- CLOUD `workspace-mode=git` 前应确保对应域名凭证已配置，否则私有仓库克隆会失败

## Agent 级凭据域

会话所属 Agent 可限制本次会话能注入哪些域名的 Git 凭据。先按域名合并系统默认与当前用户凭据（同域个人凭据优先），再与 Agent 允许域取交集；Shell、终端、CLOUD 容器与 Git 操作走同一套解析。系统默认凭据不会绕过 `strict` 或 Agent 显式禁止。

| Agent 配置 | 行为 |
|------|------|
| 未配置 | 跟随系统设置 `gitToken.scopePolicy`：`lenient`（默认）注入合并后的凭据，`strict` 不注入 |
| `[]` | 显式禁止，任何策略下都不注入 |
| 非空域名列表 | 只注入列表内且个人或系统默认已配置的凭据 |

管理后台入口：Agent 编辑页 →「Git 凭据域」；列表可按「未配置」筛选。系统策略入口：系统设置 →「Git 凭据域策略」。会话或 Agent 解析异常时按空集处理，不会回退到全量凭据。
