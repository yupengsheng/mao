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

会话所属 Agent 可限制本次会话能注入哪些域名的 Git 凭据。最终注入集合为「当前用户的已保存凭据域 ∩ Agent 允许域」；Shell、终端、CLOUD 容器、文件读写与 Git 操作走同一套解析。

| Agent 配置 | 行为 |
|------|------|
| 未配置 | 跟随系统设置 `gitToken.scopePolicy`：`lenient`（默认）注入用户全部凭据，`strict` 不注入 |
| `[]` | 显式禁止，任何策略下都不注入 |
| 非空域名列表 | 只注入列表内且该用户已保存的凭据 |

管理后台入口：Agent 编辑页 →「Git 凭据域」；列表可按「未配置」筛选。系统策略入口：系统设置 →「Git 凭据域策略」。会话或 Agent 解析异常时按空集处理，不会回退到全量凭据。
