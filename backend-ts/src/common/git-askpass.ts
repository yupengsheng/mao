/**
 * Git askpass 脚本模板与 GIT_TOKEN_* 变量名规则（多注入通道共用）。
 *
 * 保持为无依赖的 leaf 模块：容器运行时代码可以复用凭据注入规则，而不引入
 * git/file 域服务或数据库依赖。
 */

/** askpass 脚本内容：从 GIT_TOKEN_{host} 反查 token，用户名固定回 oauth2。 */
export const ASKPASS = `#!/bin/bash
PROMPT="$1"
if echo "$PROMPT" | grep -qi 'username'; then
  echo "oauth2"
  exit 0
fi
URL=$(echo "$PROMPT" | sed -n "s/.*'https:\\/\\/\\([^']*\\)'.*/\\1/p")
if [ -z "$URL" ]; then
  URL=$(echo "$PROMPT" | sed -n "s/.*'http:\\/\\/\\([^']*\\)'.*/\\1/p")
fi
if [ -z "$URL" ]; then
  exit 1
fi
HOST="\${URL##*@}"
HOST="\${HOST%%/*}"
VARNAME="GIT_TOKEN_$(echo "$HOST" | tr '.-' '__')"
VALUE="\${!VARNAME}"
if [ -n "$VALUE" ]; then
  echo "$VALUE"
fi
`;

/** git 域名 → GIT_TOKEN_* 环境变量名（`.`/`-` 归一为 `_`）。 */
export function gitTokenEnvKey(domain: string): string {
  return `GIT_TOKEN_${domain.replace(/[.-]/g, '_')}`;
}

/** 兼容现有 GitCredentialService 的命名。 */
export const envVarNameForDomain = gitTokenEnvKey;
