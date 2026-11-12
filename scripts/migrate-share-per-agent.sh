#!/usr/bin/env bash
# =============================================================================
# migrate-share-per-agent.sh —— share 按 Agent 隔离的存量数据迁移
#
# 背景：容器挂载已由 share 整根 rw 改为只挂当前 Agent 的
#   · agent-experience/<agentId>/（团队经验库，路径不变）
#   · agents/<agentId>/（私有区：投放品、脚本、工具、产物）
# 本脚本负责把线上旧布局搬到新布局，并更新 DB / 文件里的旧绝对路径。
#
# 生产默认值（执行前务必复核）：
#   SHARE_DIR    /opt/mao-data/share
#   BACKEND_ENV  /opt/mao/backend-ts/.env
#   BACKUP_ROOT  /opt/mao-data/backup
#   AGENTS       1,3,4,5,6,7
#   SETTINGS_MAP 1:settings.xml,3:settings.xml,4:settings.xml,5:settings.xml,6:settings_t.xml
#
# 用法：
#   bash migrate-share-per-agent.sh plan                 # 只读预演
#   bash migrate-share-per-agent.sh apply --phase=1      # 备份 + 建目录 + 分发脚本/配置 + README
#   bash migrate-share-per-agent.sh apply --phase=2      # 更新 DB 与文件引用（逐文件备份）
#   bash migrate-share-per-agent.sh apply --phase=3      # 部署并观察后删除根目录旧残留
#   bash migrate-share-per-agent.sh verify               # 默认 pre-phase3
#   bash migrate-share-per-agent.sh verify --post-phase3 # phase3 之后：旧残留计 FAIL
#
# 选项：
#   --yes                 跳过二次确认
#   --share-dir=DIR       覆盖 SHARE_DIR（非默认值仅建议演练；DB/文件内仍按内容原样匹配）
#   --backend-env=FILE    覆盖后端 .env
#   --backup-root=DIR     覆盖备份根
#   --agents=1,3,4,5      覆盖 Agent 列表
#   --settings-map=1:settings.xml,6:settings_t.xml
#                         指定每个 Agent 使用哪份配置；未列出的 Agent 不分发配置
#   --rules-file=FILE     额外文件替换规则，每行 file||old||new，# 开头注释
#   --allow-missing       phase2 规则文件缺失时不中断（verify 残留扫描兜底）
#   --no-db               verify 显式跳过 DB 校验
#
# 阶段顺序（不可跳步）：
#   apply --phase=1 → apply --phase=2 → 部署代码 → verify --pre-phase3 + 回归
#   → 观察 ≥1 天 → apply --phase=3 → verify --post-phase3
#
# 幂等：重复执行安全；命中 0 次打印「无需更新」并继续。
# --share-dir 只影响本脚本读写的目录；文件内容与 DB 中仍按实际记录的原路径匹配，
#   因此在临时副本上演练时，旧路径替换通常为 0 命中，不会误改。
# =============================================================================
set -euo pipefail

SHARE_DIR="/opt/mao-data/share"
BACKEND_ENV="/opt/mao/backend-ts/.env"
BACKUP_ROOT="/opt/mao-data/backup"
AGENT_LIST="1,3,4,5,6,7"
SETTINGS_MAP="1:settings.xml,3:settings.xml,4:settings.xml,5:settings.xml,6:settings_t.xml"
RULES_FILE=""

MODE="plan"; PHASE=""; ASSUME_YES=0
VERIFY_MODE="pre"
ALLOW_MISSING=0
ALLOW_NO_DB=0
for arg in "$@"; do
  case "$arg" in
    plan|verify) MODE="$arg" ;;
    apply) MODE="apply" ;;
    --phase=*) PHASE="${arg#--phase=}" ;;
    --yes) ASSUME_YES=1 ;;
    --pre-phase3) VERIFY_MODE="pre" ;;
    --post-phase3) VERIFY_MODE="post" ;;
    --allow-missing) ALLOW_MISSING=1 ;;
    --no-db) ALLOW_NO_DB=1 ;;
    --share-dir=*) SHARE_DIR="${arg#--share-dir=}" ;;
    --backend-env=*) BACKEND_ENV="${arg#--backend-env=}" ;;
    --backup-root=*) BACKUP_ROOT="${arg#--backup-root=}" ;;
    --agents=*) AGENT_LIST="${arg#--agents=}" ;;
    --settings-map=*) SETTINGS_MAP="${arg#--settings-map=}" ;;
    --rules-file=*) RULES_FILE="${arg#--rules-file=}" ;;
    *) echo "未知参数: $arg" >&2; exit 2 ;;
  esac
done
[[ "$MODE" == "apply" && ! "$PHASE" =~ ^[123]$ ]] && { echo "apply 需要 --phase=1|2|3" >&2; exit 2; }
[[ -n "$AGENT_LIST" ]] || { echo "--agents 不能为空" >&2; exit 2; }

AGENTS=()
IFS=',' read -r -a _raw_agents <<< "$AGENT_LIST"
for _a in "${_raw_agents[@]}"; do
  _a="${_a//[[:space:]]/}"
  [[ -n "$_a" ]] || continue
  [[ "$_a" =~ ^[0-9]+$ ]] || { echo "非法 Agent ID: $_a" >&2; exit 2; }
  AGENTS+=("$_a")
done
[[ ${#AGENTS[@]} -gt 0 ]] || { echo "--agents 解析后为空" >&2; exit 2; }

if [[ "$SHARE_DIR" != "/opt/mao-data/share" ]]; then
  echo "WARN: --share-dir 非生产默认值（${SHARE_DIR}）：仅建议用于演练。" >&2
  echo "      文件与 DB 中的旧路径按内容原样匹配；路径不一致时替换为 0 命中。" >&2
fi

TS="$(date +%Y%m%d-%H%M%S)"
BK="$BACKUP_ROOT/share-migrate-$TS"
MIGRATED_ON="$(date +%F)"

log()  { printf '%s\n' "$*"; }
note() { printf '  - %s\n' "$*"; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
head2() { printf '\n== %s ==\n' "$*"; }

require_root() { [[ "$(id -u)" -eq 0 ]] || die "需要 root 执行（share 与工作区文件均为 root 属主）"; }

confirm() {
  [[ "$ASSUME_YES" -eq 1 ]] && return 0
  printf '\n确认执行以上动作？输入 yes 继续：'
  read -r answer || answer=""; [[ "$answer" == "yes" ]] || die "已取消"
}

settings_file_for_agent() { # $1=agentId → 输出文件名；未配置输出空
  local a="$1" entry
  local IFS=','
  for entry in $SETTINGS_MAP; do
    [[ "${entry%%:*}" == "$a" ]] && { printf '%s' "${entry#*:}"; return 0; }
  done
  return 0
}

has_agent() { # $1=agentId
  local a
  for a in "${AGENTS[@]}"; do [[ "$a" == "$1" ]] && return 0; done
  return 1
}

# --- 小工具 ----------------------------------------------------------------
replace_in_file() { # $1 文件 $2 旧串 $3 新串 $4 是否写(1/0)
  local file="$1" old="$2" new="$3" apply="$4"
  if [[ ! -f "$file" ]]; then note "[跳过·不存在] $file"; return 0; fi
  python3 - "$file" "$old" "$new" "$apply" <<'PY'
import os, shutil, sys
path, old, new, apply = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4] == '1'
with open(path, encoding='utf-8', errors='surrogateescape') as f:
    s = f.read()
n = s.count(old)
if n == 0:
    print(f"    [0命中] {path}")
elif apply:
    tmp = path + '.migrate-tmp'
    with open(tmp, 'w', encoding='utf-8', errors='surrogateescape') as f:
        f.write(s.replace(old, new))
    shutil.copystat(path, tmp)
    os.replace(tmp, path)
    print(f"    [已替换 x{n}] {path}\n        {old}\n     -> {new}")
else:
    print(f"    [将替换 x{n}] {path}\n        {old}\n     -> {new}")
PY
}

backup_file() {
  local f="$1"
  [[ -f "$f" ]] || return 0
  mkdir -p "$BK/files"
  local flat; flat="$(printf '%s' "$f" | sed 's#^/##; s#/#_#g')"
  cp -p "$f" "$BK/files/$flat"
}

copy_if_missing() { # $1 源 $2 目标
  if [[ ! -e "$1" ]]; then note "[跳过·源不存在] $1"; return 0; fi
  if [[ -e "$2" ]]; then
    if diff -q "$1" "$2" >/dev/null 2>&1; then note "[已存在且一致] $2"
    else note "[已存在且不一致！保留现状，需人工确认] $2"; fi
    return 0
  fi
  note "cp $1 -> $2"
  [[ "$1" == "$2" ]] || { [[ "$APPLY_NOW" == "1" ]] && cp -p "$1" "$2"; }
  return 0
}

copy_dir_if_missing() { # $1 源目录 $2 目标目录
  if [[ ! -d "$1" ]]; then note "[跳过·源不存在] $1"; return 0; fi
  if [[ -e "$2" ]]; then note "[已存在] $2（保留现状）"; return 0; fi
  local tmp="$2.migrate-tmp"
  note "cp -a $1 -> $2（临时目录完成后原子 mv）"
  if [[ "$APPLY_NOW" == "1" ]]; then
    rm -rf "$tmp"
    cp -a "$1" "$tmp"
    rm -rf "$tmp/__pycache__"
    mv "$tmp" "$2"
  fi
  return 0
}

# --- DB 工具 ---------------------------------------------------------------
init_db_vars() {
  DB_URL=""; DB_USER=""; DB_PASS=""
  DB_HOST=""; DB_PORT=""; DB_NAME=""
  [[ -f "$BACKEND_ENV" ]] || return 1
  read_envvar() {
    grep -E "^$1=" "$BACKEND_ENV" | head -1 | cut -d= -f2- \
      | sed -e "s/^'//" -e "s/'$//" -e 's/^"//' -e 's/"$//'
  }
  DB_URL="$(read_envvar MYSQL_URL)"; DB_USER="$(read_envvar MYSQL_USERNAME)"; DB_PASS="$(read_envvar MYSQL_PASSWORD)"
  [[ -n "$DB_URL" && -n "$DB_USER" ]] || return 1
  if [[ "$DB_URL" =~ jdbc:mysql://([^:/]+):([0-9]+)/([^?]+) ]]; then
    DB_HOST="${BASH_REMATCH[1]}"; DB_PORT="${BASH_REMATCH[2]}"; DB_NAME="${BASH_REMATCH[3]}"
  else
    return 1
  fi
  return 0
}
db_sql() { MYSQL_PWD="$DB_PASS" mysql -h"$DB_HOST" -P"$DB_PORT" -u"$DB_USER" "$DB_NAME" \
  --default-character-set=utf8mb4 -N -B -e "$1"; }

db_available() { command -v mysql >/dev/null 2>&1 && init_db_vars && db_sql "SELECT 1" >/dev/null 2>&1; }

# 将被修改的行导出为前像（REPLACE 语句）
db_dump_before() {
  local dump_bin
  dump_bin="$(command -v mysqldump || true)"
  if [[ -z "$dump_bin" && -x /usr/bin/mysqldump ]]; then dump_bin="/usr/bin/mysqldump"; fi
  [[ -n "$dump_bin" ]] || die "mysqldump 缺失，无法导出 DB 前像，请先安装 mysql-client"
  mkdir -p "$BK"
  : > "$BK/db-before.sql"
  local -a common=(-h"$DB_HOST" -P"$DB_PORT" -u"$DB_USER" --no-create-info --skip-extended-insert
                   --replace --skip-triggers --skip-lock-tables --set-gtid-purged=OFF
                   --default-character-set=utf8mb4 "$DB_NAME")
  MYSQL_PWD="$DB_PASS" "$dump_bin" "${common[@]}" agent_experiences \
    --where="content LIKE '%${SHARE_DIR}/%' OR content LIKE '%跨用户共享的文件一律放到%'" >> "$BK/db-before.sql"
  MYSQL_PWD="$DB_PASS" "$dump_bin" "${common[@]}" scheduled_task \
    --where="prompt LIKE '%${SHARE_DIR}/%'" >> "$BK/db-before.sql"
  MYSQL_PWD="$DB_PASS" "$dump_bin" "${common[@]}" session_workspace_rules \
    --where="rules_text LIKE '%${SHARE_DIR}/%'" >> "$BK/db-before.sql"
}

db_run_update() { # $1=描述 $2=SQL
  local desc="$1" sql="$2" out affected
  out="$(db_sql "$sql"$'\nSELECT ROW_COUNT();')"
  affected="$(printf '%s\n' "$out" | tail -1)"
  note "[$desc] affected=$affected"
}

# ============================================================================
# phase 1：数据面（备份 + 建结构 + 分发 + README + 删试验副本）
# ============================================================================
phase1_actions() {
  APPLY_NOW="$1"
  head2 "phase1 · 数据面"
  note "备份目录：${BK}（share-full.tgz + 后续文件级备份）"
  if [[ "$APPLY_NOW" == "1" ]]; then
    require_root
    mkdir -p "$BK"
    tar -czf "$BK/share-full.tgz" -C "$(dirname "$SHARE_DIR")" "$(basename "$SHARE_DIR")"
    note "已生成全量备份：$BK/share-full.tgz"
  fi

  note "mkdir -p $SHARE_DIR/agents/{${AGENTS[*]}}"
  if [[ "$APPLY_NOW" == "1" ]]; then
    for a in "${AGENTS[@]}"; do mkdir -p "$SHARE_DIR/agents/$a"; done
  fi

  local a sf
  for a in "${AGENTS[@]}"; do
    sf="$(settings_file_for_agent "$a")"
    if [[ -n "$sf" ]]; then
      copy_if_missing "$SHARE_DIR/$sf" "$SHARE_DIR/agents/$a/$sf"
    else
      note "Agent $a 未配置 settings 映射（跳过）"
    fi
  done

  for a in "${AGENTS[@]}"; do
    copy_dir_if_missing "$SHARE_DIR/scripts" "$SHARE_DIR/agents/$a/scripts"
  done
  for a in "${AGENTS[@]}"; do
    copy_dir_if_missing "$SHARE_DIR/tools" "$SHARE_DIR/agents/$a/tools"
  done

  note "修正各副本内自引用：agents/{${AGENTS[*]}}/scripts/push_fast.sh 的 SHARE 路径"
  if [[ "$APPLY_NOW" == "1" ]]; then
    for a in "${AGENTS[@]}"; do
      replace_in_file "$SHARE_DIR/agents/$a/scripts/push_fast.sh" \
        "$SHARE_DIR/scripts" "$SHARE_DIR/agents/$a/scripts" 1
    done
  else
    note "（apply 时执行）"
  fi

  local readme="$SHARE_DIR/README.md"
  if [[ -e "$readme" ]]; then note "[已存在] $readme"; else
    note "写 ${readme}（结构说明与投放指引）"
    if [[ "$APPLY_NOW" == "1" ]]; then
      cat > "$readme" <<EOM
# ${SHARE_DIR} 结构说明与投放指引（迁移于 ${MIGRATED_ON}）

本目录已按 Agent 隔离，不再有全员共享的公共投放区。

## 结构
- \`agent-experience/{agentId}/\`：团队经验库（平台管理；Agent 会话内经工作区 \`团队经验/\` 软链访问）。
- \`agents/{agentId}/\`：该 Agent 的私有区（脚本、配置、工具、产物、投放品）。

## 管理员/运维投放指引
- 投放：把文件放到 \`agents/<目标AgentId>/\`——目录级挂载，即时生效（无需重启/重建容器）。
- 多 Agent 需要同一文件时逐个复制（无公共区）。
- 备份请放 \`${BACKUP_ROOT}\`（勿放任何用户挂载面，避免经用户级共享面泄露）。

## 迁移说明
- 原 \`share/scripts\` → \`agents/<agentId>/scripts/\`（每个 Agent 一份）。
- 原 \`share/tools\` → \`agents/<agentId>/tools/\`（存在时）。
- 各 Agent 的 \`settings.xml\` / \`settings_t.xml\` 按部署映射分发到 \`agents/<agentId>/\`。
- \`agent-experience/{agentId}/\` 路径不变。
EOM
    fi
  fi

  head2 "phase1 · 删除试验副本（agent-experience/*/share）"
  for a in "${AGENTS[@]}"; do
    local victim="$SHARE_DIR/agent-experience/$a/share"
    if [[ -e "$victim" ]]; then
      note "rm -rf $victim"
      [[ "$APPLY_NOW" == "1" ]] && rm -rf "$victim"
    fi
  done
  return 0
}

# ============================================================================
# phase 2：引用更新（DB + 文件）
# ============================================================================
db_apply_updates() {
  local a sf
  for a in "${AGENTS[@]}"; do
    db_run_update "agent_experiences agent=$a scripts 路径" \
      "UPDATE agent_experiences SET content = REPLACE(content, '$SHARE_DIR/scripts/', '$SHARE_DIR/agents/$a/scripts/') WHERE agent_id = $a AND content LIKE '%$SHARE_DIR/scripts/%';"
    db_run_update "agent_experiences agent=$a tools 路径" \
      "UPDATE agent_experiences SET content = REPLACE(content, '$SHARE_DIR/tools/', '$SHARE_DIR/agents/$a/tools/') WHERE agent_id = $a AND content LIKE '%$SHARE_DIR/tools/%';"
    sf="$(settings_file_for_agent "$a")"
    if [[ -n "$sf" && -f "$SHARE_DIR/agents/$a/$sf" ]]; then
      db_run_update "agent_experiences agent=$a $sf 路径" \
        "UPDATE agent_experiences SET content = REPLACE(content, '$SHARE_DIR/$sf', '$SHARE_DIR/agents/$a/$sf') WHERE agent_id = $a AND content LIKE '%$SHARE_DIR/$sf%';"
    fi
    db_run_update "agent_experiences agent=$a 共享文案" \
      "UPDATE agent_experiences SET content = REPLACE(content, '有需要跨用户共享的文件一律放到 $SHARE_DIR 目录下', '本 Agent 的文件一律放到 $SHARE_DIR/agents/$a/ 目录下（share 已按 Agent 隔离，无跨 Agent 公共共享目录；旧路径已迁移，勿自行重建）') WHERE agent_id = $a AND content LIKE '%有需要跨用户共享的文件一律放到 $SHARE_DIR 目录下%';"
    db_run_update "scheduled_task agent=$a scripts 路径" \
      "UPDATE scheduled_task SET prompt = REPLACE(prompt, '$SHARE_DIR/scripts/', '$SHARE_DIR/agents/$a/scripts/') WHERE agent_id = $a AND prompt LIKE '%$SHARE_DIR/scripts/%';"
    db_run_update "scheduled_task agent=$a tools 路径" \
      "UPDATE scheduled_task SET prompt = REPLACE(prompt, '$SHARE_DIR/tools/', '$SHARE_DIR/agents/$a/tools/') WHERE agent_id = $a AND prompt LIKE '%$SHARE_DIR/tools/%';"
  done
  # 快照含旧路径时删除，下轮 resolve 自动重建（避免旧规则继续注入）
  db_run_update "session_workspace_rules 旧 share 快照" \
    "DELETE FROM session_workspace_rules WHERE (rules_text LIKE '%$SHARE_DIR/scripts%' OR rules_text LIKE '%$SHARE_DIR/settings%' OR rules_text LIKE '%$SHARE_DIR/tools/%');"
}

# 自动发现的文件替换规则：agent-experience/{a}/ 内所有文本文件
auto_file_rules() {
  local a f sf
  for a in "${AGENTS[@]}"; do
    [[ -d "$SHARE_DIR/agent-experience/$a" ]] || continue
    while IFS= read -r f; do
      [[ -n "$f" ]] || continue
      printf '%s||%s||%s\n' "$f" "$SHARE_DIR/scripts/" "$SHARE_DIR/agents/$a/scripts/"
      printf '%s||%s||%s\n' "$f" "$SHARE_DIR/tools/" "$SHARE_DIR/agents/$a/tools/"
      sf="$(settings_file_for_agent "$a")"
      if [[ -n "$sf" && -f "$SHARE_DIR/agents/$a/$sf" ]]; then
        printf '%s||%s||%s\n' "$f" "$SHARE_DIR/$sf" "$SHARE_DIR/agents/$a/$sf"
      fi
    done < <(
      grep -rlF -e "$SHARE_DIR/scripts/" -e "$SHARE_DIR/tools/" -e "$SHARE_DIR/settings" \
        "$SHARE_DIR/agent-experience/$a" --exclude-dir=share --exclude-dir=__pycache__ 2>/dev/null || true
    )
  done
}

phase2_actions() {
  APPLY_NOW="$1"
  head2 "phase2 · 引用更新"
  if [[ "$APPLY_NOW" == "1" ]]; then
    require_root
    local a
    for a in "${AGENTS[@]}"; do
      [[ -d "$SHARE_DIR/agents/$a/scripts" ]] || die "phase1 未完成（缺少 agents/$a/scripts），请先执行 apply --phase=1"
    done
    for a in "${AGENTS[@]}"; do
      local sf; sf="$(settings_file_for_agent "$a")"
      if [[ -n "$sf" ]]; then
        [[ -f "$SHARE_DIR/agents/$a/$sf" ]] || die "phase1 未完成（缺少 agents/$a/${sf}），请先执行 apply --phase=1"
      fi
    done
  fi

  head2 "phase2 · DB 引用更新"
  if db_available; then
    note "当前值预览："
    db_sql "SELECT id, agent_id, LEFT(content, 200) FROM agent_experiences WHERE content LIKE '%$SHARE_DIR/%' ORDER BY id;" | sed 's/^/    /'
    db_sql "SELECT id, agent_id, LEFT(prompt, 160) FROM scheduled_task WHERE prompt LIKE '%$SHARE_DIR/%' ORDER BY id;" | sed 's/^/    /'
    db_sql "SELECT session_id, workspace, source_path FROM session_workspace_rules WHERE rules_text LIKE '%$SHARE_DIR/%' LIMIT 20;" | sed 's/^/    /'
    if [[ "$APPLY_NOW" == "1" ]]; then
      head2 "phase2 · DB 前像导出"
      db_dump_before
      note "已导出：$BK/db-before.sql（回滚：MYSQL_PWD=… mysql -h… $DB_NAME < $BK/db-before.sql）"
      db_apply_updates
      note "更新后校验（期望：旧串计数为 0）："
      db_sql "SELECT 'agent_experiences_old', COUNT(*) FROM agent_experiences WHERE content LIKE '%$SHARE_DIR/scripts/%' OR content LIKE '%$SHARE_DIR/tools/%' OR content LIKE '%$SHARE_DIR/settings%' UNION ALL SELECT 'scheduled_task_old', COUNT(*) FROM scheduled_task WHERE prompt LIKE '%$SHARE_DIR/scripts/%' UNION ALL SELECT 'session_workspace_rules_old', COUNT(*) FROM session_workspace_rules WHERE rules_text LIKE '%$SHARE_DIR/scripts%' OR rules_text LIKE '%$SHARE_DIR/settings%' OR rules_text LIKE '%$SHARE_DIR/tools/%';" | sed 's/^/    /'
    else
      note "（apply 时执行上述 REPLACE/DELETE；命中 0 次即已是最新）"
    fi
  else
    if [[ "$APPLY_NOW" == "1" ]]; then
      die "DB 不可达或 mysql 缺失——phase2 必须更新 DB，请检查 --backend-env（${BACKEND_ENV}）"
    fi
    note "（DB 不可达或 mysql 缺失——预演跳过 DB；apply 时会强制要求 DB 可达）"
  fi

  head2 "phase2 · 文件引用更新"
  local rule file rest old new
  local -a rules=()
  while IFS= read -r rule; do [[ -n "$rule" ]] && rules+=("$rule"); done < <(auto_file_rules)
  if [[ -n "$RULES_FILE" ]]; then
    [[ -f "$RULES_FILE" ]] || die "规则文件不存在：$RULES_FILE"
    while IFS= read -r rule; do
      [[ -z "$rule" || "$rule" == \#* ]] && continue
      [[ "$rule" == *"||"*"||"* ]] || die "规则文件行格式错误（需 file||old||new）：$rule"
      rules+=("$rule")
    done < "$RULES_FILE"
  fi
  note "共 ${#rules[@]} 条规则（自动发现 + $( [[ -n "$RULES_FILE" ]] && printf '%s' "$RULES_FILE" || printf '无额外规则')）"

  local -a missing=()
  for rule in ${rules[@]+"${rules[@]}"}; do
    file="${rule%%||*}"; rest="${rule#*||}"
    old="${rest%%||*}"; new="${rest#*||}"
    if [[ ! -f "$file" ]]; then
      missing+=("$file")
      note "[缺失] $file ← 可能已改名/删除，需人工核对"
      continue
    fi
    if [[ "$APPLY_NOW" == "1" ]] && grep -qF -- "$old" "$file" 2>/dev/null; then
      backup_file "$file"
    fi
    replace_in_file "$file" "$old" "$new" "$APPLY_NOW"
  done
  if [[ ${#missing[@]} -gt 0 ]]; then
    if [[ "$APPLY_NOW" == "1" && "$ALLOW_MISSING" -ne 1 ]]; then
      log "  以下规则目标文件缺失（${#missing[@]} 个）："
      printf '    %s\n' "${missing[@]}"
      die "phase2 中止：请核对规则目标，确认可忽略后加 --allow-missing 重跑"
    fi
    note "WARN：${#missing[@]} 个规则目标文件缺失（plan 演练或 --allow-missing 放行）；verify 残留扫描兜底"
  fi
  return 0
}

# ============================================================================
# phase 3：清理旧残留
# ============================================================================
phase3_actions() {
  APPLY_NOW="$1"
  head2 "phase3 · 清理旧残留"
  log "  将删除：$SHARE_DIR/scripts/"
  log "          $SHARE_DIR/settings.xml"
  log "          $SHARE_DIR/settings_t.xml"
  log "  警告：执行后历史消息中的旧路径失效（已接受项）。前置条件："
  log "        ① 代码已部署（挂载已切换） ② verify --pre-phase3 通过（FAIL=0） ③ 已观察 ≥1 天"
  log "        ④ 待删残留将先打包到 $BK/phase3-residual.tgz"
  if [[ "$APPLY_NOW" == "1" ]]; then
    require_root
    mkdir -p "$BK"
    local -a resid=()
    local x
    for x in scripts settings.xml settings_t.xml; do
      [[ -e "$SHARE_DIR/$x" ]] && resid+=("$x")
    done
    if [[ ${#resid[@]} -gt 0 ]]; then
      tar -czf "$BK/phase3-residual.tgz" -C "$SHARE_DIR" "${resid[@]}"
      note "已备份待删残留（${resid[*]}）：$BK/phase3-residual.tgz"
    else
      note "待删残留均不存在（可能已清理）"
    fi
    rm -rf "$SHARE_DIR/scripts"
    rm -f  "$SHARE_DIR/settings.xml" "$SHARE_DIR/settings_t.xml"
    note "已删除。当前顶层："
    ls -la "$SHARE_DIR" | sed 's/^/    /'
  fi
  return 0
}

# ============================================================================
# verify
# ============================================================================
do_verify() {
  head2 "verify · 结构与残留（模式：$([[ "$VERIFY_MODE" == "post" ]] && echo post-phase3 || echo pre-phase3)）"
  local OK=0 FAIL=0 WARN=0
  pass() { note "[OK] $1"; OK=$((OK+1)); }
  fail() { note "[FAIL] $1"; FAIL=$((FAIL+1)); }
  soft() {
    if [[ "$VERIFY_MODE" == "post" ]]; then fail "$1"
    else note "[WARN] $1（pre-phase3 不计 FAIL；--post-phase3 时计 FAIL）"; WARN=$((WARN+1)); fi
  }
  warn_only() { note "[WARN] $1"; WARN=$((WARN+1)); }
  check() { local desc="$1"; shift; if "$@" >/dev/null 2>&1; then pass "$desc"; else fail "$desc"; fi; }

  check "README.md 存在" test -f "$SHARE_DIR/README.md"
  local a sf
  for a in "${AGENTS[@]}"; do
    check "agents/$a 目录存在" test -d "$SHARE_DIR/agents/$a"
    if [[ -d "$SHARE_DIR/agent-experience/$a" ]]; then
      pass "agent-experience/$a 目录存在"
    else
      warn_only "agent-experience/$a 目录不存在（无团队经验，跳过隔离检查）"
    fi
    check "agents/$a/scripts 目录存在" test -d "$SHARE_DIR/agents/$a/scripts"
    sf="$(settings_file_for_agent "$a")"
    if [[ -n "$sf" ]]; then check "agents/$a/$sf 存在" test -f "$SHARE_DIR/agents/$a/$sf"; fi
  done

  local leftovers rc
  leftovers="$(find "$SHARE_DIR/agent-experience" -maxdepth 2 -name share -type d 2>/dev/null)" && rc=0 || rc=$?
  if [[ "$rc" -ne 0 ]]; then
    fail "试验副本清理检查（find 执行失败 rc=${rc}）"
  elif [[ -z "$leftovers" ]]; then
    pass "试验副本已清除（agent-experience/*/share 不存在）"
  else
    fail "试验副本仍存在：$(printf '%s' "$leftovers" | tr '\n' ' ')"
  fi

  local pfbad="" pf
  for a in "${AGENTS[@]}"; do
    pf="$SHARE_DIR/agents/$a/scripts/push_fast.sh"
    if [[ ! -f "$pf" ]] || grep -q "$SHARE_DIR/scripts" "$pf" 2>/dev/null; then pfbad+="agents/$a "; fi
  done
  if [[ -z "$pfbad" ]]; then pass "副本内 push_fast.sh 自引用已更新"
  else fail "副本内 push_fast.sh 自引用未更新或缺失：$pfbad"; fi

  residual_check() { # $1 描述；其余为 grep 目标
    local desc="$1"; shift
    local hits="" n=0
    if hits="$(grep -rn -F --exclude-dir=__pycache__ \
        -e "$SHARE_DIR/scripts" -e "$SHARE_DIR/settings" -e "$SHARE_DIR/tools" "$@" 2>/dev/null)"; then
      n="$(printf '%s\n' "$hits" | wc -l)"
      log "    命中 $n 处（前 20 行）："
      printf '%s\n' "$hits" | head -20 | sed 's/^/      /'
      soft "${desc}：命中 ${n} 处旧路径"
    else
      pass "$desc"
    fi
  }
  residual_check "经验库（agent-experience/**）无旧路径残留" "$SHARE_DIR/agent-experience"
  for a in "${AGENTS[@]}"; do
    if [[ -d "$SHARE_DIR/agents/$a/scripts" ]]; then
      residual_check "agents/$a/scripts 无旧路径残留" "$SHARE_DIR/agents/$a/scripts"
    else
      fail "agents/$a/scripts 不存在（phase1 未完成）"
    fi
  done

  local -a oldroot=()
  local x
  for x in scripts settings.xml settings_t.xml; do
    [[ -e "$SHARE_DIR/$x" ]] && oldroot+=("$x")
  done
  if [[ ${#oldroot[@]} -eq 0 ]]; then pass "根目录旧残留已清理（phase3 后生效）"
  else soft "根目录仍有旧残留：${oldroot[*]}（phase3 删除）"; fi

  if db_available; then
    db_count_check() {
      local desc="$1" sql="$2" c
      c="$(db_sql "$sql" | head -1)"
      if [[ "$c" == "0" ]]; then pass "$desc"
      else log "    ${desc}：当前 ${c} 行"; soft "${desc}（残留 ${c} 行）"; fi
    }
    db_count_check "DB agent_experiences 无旧路径" \
      "SELECT COUNT(*) FROM agent_experiences WHERE content LIKE '%$SHARE_DIR/scripts/%' OR content LIKE '%$SHARE_DIR/settings%' OR content LIKE '%$SHARE_DIR/tools/%';"
    db_count_check "DB scheduled_task 无旧路径" \
      "SELECT COUNT(*) FROM scheduled_task WHERE prompt LIKE '%$SHARE_DIR/scripts/%' OR prompt LIKE '%$SHARE_DIR/tools/%';"
    db_count_check "DB session_workspace_rules 无旧快照" \
      "SELECT COUNT(*) FROM session_workspace_rules WHERE rules_text LIKE '%$SHARE_DIR/scripts%' OR rules_text LIKE '%$SHARE_DIR/settings%' OR rules_text LIKE '%$SHARE_DIR/tools/%';"
  else
    if [[ "$ALLOW_NO_DB" -eq 1 ]]; then note "[SKIP] DB 校验（--no-db 显式跳过）"
    else fail "DB 不可达（如确需跳过请显式加 --no-db）"; fi
  fi

  head2 "verify · 容器级验证命令（手动执行，以 user36/agent5 为例）"
  cat <<'EOM'
  docker exec mao-user-36-agent-5 ls /opt/mao-data/share/agent-experience/     # 期望：仅 5
  docker exec mao-user-36-agent-5 ls /opt/mao-data/share/agents/               # 期望：仅 5
  docker exec mao-user-36-agent-5 cat /opt/mao-data/share/agent-experience/6/x 2>&1  # 期望：ENOENT
  docker exec mao-user-36-agent-5 sh -c 'echo x > /opt/mao-data/share/agents/5/.t && rm /opt/mao-data/share/agents/5/.t'  # 期望：成功
EOM

  head2 "verify · 汇总（模式：$([[ "$VERIFY_MODE" == "post" ]] && echo post-phase3 || echo pre-phase3)）"
  log "  OK=$OK FAIL=$FAIL WARN=$WARN"
  if [[ "$FAIL" -eq 0 ]]; then log "  结论：PASS"; return 0; fi
  log "  结论：FAIL"; return 1
}

# ============================================================================
# 入口
# ============================================================================
apply_phase() {
  local n="$1"
  log "========== 预演（phase${n}）=========="
  "phase${n}_actions" 0
  confirm
  log "========== 执行（phase${n}）=========="
  "phase${n}_actions" 1
  return 0
}

case "$MODE" in
  plan)
    log "== 只读预演：share=${SHARE_DIR}（不会改动任何文件/数据）=="
    phase1_actions 0
    phase2_actions 0
    phase3_actions 0
    log ""
    log "预演完成。执行顺序：apply --phase=1 → apply --phase=2 → 部署代码"
    log "  → verify --pre-phase3 + 回归 → 观察 ≥1 天 → apply --phase=3 → verify --post-phase3"
    ;;
  apply) apply_phase "$PHASE" ;;
  verify) do_verify ;;
esac
