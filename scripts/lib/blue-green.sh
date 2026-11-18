#!/bin/bash
# Blue-green backend deploy helpers. Sourced by backend-ts/restart.sh and scripts/restart-backend.sh.

set -euo pipefail

: "${MAO_BLUE_GREEN_PORT_A:=9080}"
: "${MAO_BLUE_GREEN_PORT_B:=9081}"
: "${MAO_RUNTIME_DIR:=/opt/mao-data/runtime}"
: "${MAO_NGINX_SITES_DIR:=/etc/nginx/sites-enabled}"
: "${MAO_NGINX_UPSTREAM_CONF:=/etc/nginx/conf.d/mao-upstream.conf}"
: "${MAO_BLUE_GREEN_DRAIN_SEC:=60}"
: "${MAO_BLUE_GREEN_HEALTH_RETRIES:=60}"
: "${MAO_BLUE_GREEN_HEALTH_INTERVAL_SEC:=1}"
: "${MAO_BLUE_GREEN_STALE_LOCK_SEC:=600}"
: "${MAO_BACKEND_LEGACY_SERVICE:=mao.service}"

bg_active_port_file() {
  echo "${MAO_RUNTIME_DIR}/active-backend-port"
}

bg_deploy_lock_file() {
  echo "${MAO_RUNTIME_DIR}/deploy.lock"
}

bg_pid_file_for_port() {
  local app_dir="$1"
  local port="$2"
  echo "${app_dir}/mao-server-ts-${port}.pid"
}

bg_legacy_pid_file() {
  local app_dir="$1"
  echo "${app_dir}/mao-server-ts.pid"
}

bg_ensure_runtime_dir() {
  mkdir -p "${MAO_RUNTIME_DIR}"
}

bg_backend_run_user() {
  if [ -n "${MAO_BACKEND_RUN_USER:-}" ]; then
    echo "${MAO_BACKEND_RUN_USER}"
  elif id mao >/dev/null 2>&1; then
    # 生产数据目录（share/uploads/workspace）属于 mao；部署账号通常只负责构建和发布。
    echo "mao"
  else
    id -un
  fi
}

bg_as_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  else
    sudo -n "$@"
  fi
}

# kill -0 对其他用户的进程会因 EPERM 返回失败，不能用来判断进程是否仍存在。
bg_process_running() {
  local pid="$1"
  [ -n "$pid" ] || return 1
  ps -p "$pid" -o pid= >/dev/null 2>&1 || bg_as_root ps -p "$pid" -o pid= >/dev/null 2>&1
}

bg_process_pgid() {
  local pid="$1"
  local pgid=""
  [ -n "$pid" ] || return 1
  pgid="$(ps -p "$pid" -o pgid= 2>/dev/null | tr -d '[:space:]' || true)"
  if [ -z "$pgid" ]; then
    pgid="$(bg_as_root ps -p "$pid" -o pgid= 2>/dev/null | tr -d '[:space:]' || true)"
  fi
  [ -n "$pgid" ] && printf '%s\n' "$pgid"
}

bg_port_in_use() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    if lsof -tiTCP:"${port}" -sTCP:LISTEN >/dev/null 2>&1; then
      return 0
    fi
  fi
  if command -v ss >/dev/null 2>&1; then
    # Ubuntu 的 hidepid / 受限 /proc 下，普通部署用户运行 lsof 可能什么都看不到，
    # 但 ss 仍能读取监听表。不能再把 lsof 的非零退出当成“端口空闲”。
    ss -H -ltn 2>/dev/null | grep -Eq ":${port}[[:space:]]"
    return $?
  fi
  if command -v netstat >/dev/null 2>&1; then
    netstat -ltn 2>/dev/null | grep -Eq ":${port}[[:space:]]"
    return $?
  fi
  return 1
}

bg_listener_pids() {
  local port="$1"
  local pids="" output=""
  if command -v lsof >/dev/null 2>&1; then
    pids="$(lsof -tiTCP:"${port}" -sTCP:LISTEN 2>/dev/null || true)"
  fi
  if [ -z "$pids" ] && command -v ss >/dev/null 2>&1; then
    output="$(ss -H -ltnp 2>/dev/null | grep -E ":${port}[[:space:]]" || true)"
    pids="$(printf '%s\n' "$output" | grep -o 'pid=[0-9][0-9]*' 2>/dev/null | cut -d= -f2 || true)"
    if [ -z "$pids" ]; then
      output="$(bg_as_root ss -H -ltnp 2>/dev/null | grep -E ":${port}[[:space:]]" || true)"
      pids="$(printf '%s\n' "$output" | grep -o 'pid=[0-9][0-9]*' 2>/dev/null | cut -d= -f2 || true)"
    fi
  fi
  printf '%s\n' "$pids" | awk 'NF && !seen[$0]++'
}

bg_pid_matches_backend() {
  local pid="$1"
  [ -n "$pid" ] || return 1
  local args
  args="$(ps -p "$pid" -o args= 2>/dev/null || true)"
  if [ -z "$args" ]; then
    args="$(bg_as_root ps -p "$pid" -o args= 2>/dev/null || true)"
  fi
  case "$args" in
    *"dist/main.js"*|*"src/main.ts"*|*"mao-server-ts"*) return 0 ;;
  esac
  return 1
}

bg_terminate_process() {
  local pid="$1"
  [ -n "$pid" ] || return 1
  bg_pid_matches_backend "$pid" || return 1
  if ! bg_process_running "$pid"; then
    return 0
  fi
  local pgid
  pgid="$(bg_process_pgid "$pid" || true)"
  # 只有 PGID == PID 时才整组停止：该组由 setsid 专为本实例创建，可同时收掉
  # sudo/nohup 启动器和 Node 子进程。否则只杀 PID，绝不影响其他进程组。
  if [ "$pgid" = "$pid" ]; then
    bg_as_root kill -TERM -- "-${pid}" 2>/dev/null || true
  else
    bg_as_root kill -TERM "$pid" 2>/dev/null || true
  fi
  local i
  for i in $(seq 1 50); do
    if ! bg_process_running "$pid"; then
      return 0
    fi
    sleep 0.1
  done
  if [ "$pgid" = "$pid" ]; then
    bg_as_root kill -KILL -- "-${pid}" 2>/dev/null || true
  else
    bg_as_root kill -KILL "$pid" 2>/dev/null || true
  fi
  return 0
}

bg_stop_legacy_service_if_matches() {
  local pid="$1"
  local service="${MAO_BACKEND_LEGACY_SERVICE:-}"
  [ -n "$pid" ] && [ -n "$service" ] || return 1
  command -v systemctl >/dev/null 2>&1 || return 1
  local main_pid
  main_pid="$(bg_as_root systemctl show "$service" -p MainPID --value 2>/dev/null || true)"
  [ -n "$main_pid" ] && [ "$main_pid" != "0" ] && [ "$main_pid" = "$pid" ] || return 1
  echo "Stopping and disabling legacy systemd service ${service} (PID: ${pid})..."
  bg_as_root systemctl stop "$service" || return 1
  bg_as_root systemctl disable "$service" >/dev/null 2>&1 || true
  return 0
}

bg_validate_backend_runtime() {
  local app_dir="$1"
  local env_file="${app_dir}/.env"
  local run_user current_user
  run_user="$(bg_backend_run_user)"
  current_user="$(id -un)"
  if ! id "$run_user" >/dev/null 2>&1; then
    echo "错误：后端运行用户 ${run_user} 不存在。" >&2
    return 1
  fi
  if [ ! -f "$env_file" ]; then
    echo "错误：后端环境文件不存在：${env_file}。" >&2
    echo "     请先按 DEPLOY.md 创建 .env，再执行部署。" >&2
    return 1
  fi
  if [ ! -r "$env_file" ]; then
    echo "错误：当前部署用户 ${current_user} 无法读取 ${env_file}。" >&2
    echo "     请执行 sudo chown ${current_user}:${run_user} ${env_file} && sudo chmod 640 ${env_file}" >&2
    return 1
  fi
  if [ "$run_user" != "$current_user" ]; then
    if ! sudo -n -u "$run_user" true >/dev/null 2>&1; then
      echo "错误：当前用户 ${current_user} 无法免密切换到后端运行用户 ${run_user}。" >&2
      echo "     请为部署用户配置：sudo -n -u ${run_user} <command>，或设置 MAO_BACKEND_RUN_USER。" >&2
      return 1
    fi
    if ! sudo -n -u "$run_user" test -r "$env_file"; then
      echo "错误：后端运行用户 ${run_user} 无法读取 ${env_file}。" >&2
      echo "     请将 .env 调整为部署用户属主、${run_user} 属组并设 640：" >&2
      echo "     sudo chown ${current_user}:${run_user} ${env_file} && sudo chmod 640 ${env_file}" >&2
      return 1
    fi
  fi
}

# 构建由部署用户完成，后端却以独立用户运行。若部署用户的 umask 是 077，
# dist/node_modules 会变成 700/600，运行用户看不到构建产物，旧脚本甚至会
# 静默回退到 npx tsx 并因缺少依赖退出。启动前必须显式校验，历史产物则一次性
# 补上只读/目录遍历权限；这里只处理构建产物，不触碰运行数据目录。
bg_prepare_backend_artifacts() {
  local app_dir="$1"
  local run_user current_user entry_script modules_dir
  run_user="$(bg_backend_run_user)"
  current_user="$(id -un)"
  entry_script="${app_dir}/dist/main.js"
  modules_dir="${app_dir}/node_modules"

  if [ ! -f "$entry_script" ]; then
    echo "错误：后端构建产物不存在：${entry_script}。" >&2
    echo "     请先执行 backend-ts 的 npm run build，再启动蓝绿部署。" >&2
    return 1
  fi
  if [ ! -d "$modules_dir" ]; then
    echo "错误：后端依赖目录不存在：${modules_dir}。" >&2
    echo "     请先在 backend-ts 执行 npm ci。" >&2
    return 1
  fi

  if [ "$run_user" != "$current_user" ]; then
    if ! sudo -n -u "$run_user" test -r "$entry_script" 2>/dev/null \
      || ! sudo -n -u "$run_user" test -x "$modules_dir" 2>/dev/null; then
      echo "==> 后端构建产物对运行用户 ${run_user} 不可读，修复 dist/node_modules 权限..."
      chmod -R a+rX "$app_dir/dist" "$modules_dir"
    fi
    if ! sudo -n -u "$run_user" test -r "$entry_script" 2>/dev/null; then
      echo "错误：后端运行用户 ${run_user} 仍无法读取 ${entry_script}。" >&2
      return 1
    fi
    if ! sudo -n -u "$run_user" test -x "$modules_dir" 2>/dev/null; then
      echo "错误：后端运行用户 ${run_user} 仍无法进入 ${modules_dir}。" >&2
      return 1
    fi
  fi
}

bg_read_active_port() {
  local file
  file="$(bg_active_port_file)"
  if [ -f "$file" ]; then
    local port
    port="$(tr -d '[:space:]' < "$file")"
    if [ "$port" = "$MAO_BLUE_GREEN_PORT_A" ] || [ "$port" = "$MAO_BLUE_GREEN_PORT_B" ]; then
      echo "$port"
      return 0
    fi
  fi
  if bg_port_in_use "$MAO_BLUE_GREEN_PORT_A"; then
    echo "$MAO_BLUE_GREEN_PORT_A"
  elif bg_port_in_use "$MAO_BLUE_GREEN_PORT_B"; then
    echo "$MAO_BLUE_GREEN_PORT_B"
  else
    echo "$MAO_BLUE_GREEN_PORT_A"
  fi
}

bg_write_active_port() {
  bg_ensure_runtime_dir
  echo "$1" > "$(bg_active_port_file)"
}

bg_write_deploy_lock() {
  local started_at="$1"
  local old_port="$2"
  local new_port="$3"
  local status="$4"
  bg_ensure_runtime_dir
  cat > "$(bg_deploy_lock_file)" <<EOF
{"startedAt":${started_at},"oldPort":${old_port},"newPort":${new_port},"status":"${status}","drainSec":${MAO_BLUE_GREEN_DRAIN_SEC}}
EOF
}

bg_clear_stale_deploy_lock() {
  local lock_file
  lock_file="$(bg_deploy_lock_file)"
  [ -f "$lock_file" ] || return 0
  local started_at now age
  started_at=$(python3 -c "import json; print(json.load(open('${lock_file}')).get('startedAt',0))" 2>/dev/null || echo 0)
  now=$(date +%s)
  age=$((now - started_at))
  if [ "$age" -gt "$MAO_BLUE_GREEN_STALE_LOCK_SEC" ]; then
    echo "WARN: clearing stale deploy.lock (age=${age}s)"
    rm -f "$lock_file"
  fi
}

bg_rotate_log() {
  local log_file="$1"
  if [ -f "$log_file" ]; then
    local size
    size=$(stat -c%s "$log_file" 2>/dev/null || stat -f%z "$log_file" 2>/dev/null || echo 0)
    local max_bytes=$((100 * 1024 * 1024))
    if [ "$size" -gt "$max_bytes" ] 2>/dev/null; then
      mv "$log_file" "$log_file.$(date +%Y%m%d%H%M%S)"
      ls -t "$log_file".* 2>/dev/null | tail -n +6 | xargs rm -f 2>/dev/null || true
    fi
  fi
}

bg_stop_port() {
  local app_dir="$1"
  local port="$2"
  local pid_file
  pid_file="$(bg_pid_file_for_port "$app_dir" "$port")"
  local pids=""
  if [ -f "$pid_file" ]; then
    local pid
    pid="$(tr -d '[:space:]' < "$pid_file")"
    [ -n "$pid" ] && pids="${pid}"
  fi
  while IFS= read -r pid; do
    [ -n "$pid" ] || continue
    pids="${pids} ${pid}"
  done < <(bg_listener_pids "$port")

  for pid in $(printf '%s\n' "$pids" | tr ' ' '\n' | awk 'NF && !seen[$0]++'); do
    if bg_stop_legacy_service_if_matches "$pid"; then
      continue
    fi
    if bg_pid_matches_backend "$pid"; then
      echo "Stopping mao-server-ts on port ${port} (PID: ${pid})..."
      bg_terminate_process "$pid" || true
    fi
  done
  rm -f "$pid_file"

  if bg_port_in_use "$port"; then
    echo "错误：端口 ${port} 仍被占用，无法安全停止后端。" >&2
    return 1
  fi
}

bg_migrate_legacy_pid() {
  local app_dir="$1"
  local port="$2"
  local legacy
  legacy="$(bg_legacy_pid_file "$app_dir")"
  local target
  target="$(bg_pid_file_for_port "$app_dir" "$port")"
  if [ -f "$legacy" ] && [ ! -f "$target" ]; then
    mv "$legacy" "$target"
  fi
}

# Start backend without inheriting deploy flock or other stray FDs from the parent shell.
bg_start_port() {
  local app_dir="$1"
  local port="$2"
  local log_dir="$3"
  local log_file="${log_dir}/backend-ts-${port}.log"
  local env_file="${app_dir}/.env"
  local pid_file
  pid_file="$(bg_pid_file_for_port "$app_dir" "$port")"

  if [ -f "$pid_file" ]; then
    local existing_pid
    existing_pid="$(tr -d '[:space:]' < "$pid_file")"
    if [ -n "$existing_pid" ] && bg_process_running "$existing_pid"; then
      if bg_pid_matches_backend "$existing_pid"; then
        echo "Backend already running on port ${port} (PID: ${existing_pid})"
        return 0
      fi
      echo "错误：PID 文件 ${pid_file} 指向的进程 ${existing_pid} 不是 Mao 后端，拒绝覆盖。" >&2
      echo "     请人工确认后删除该 PID 文件再重试。" >&2
      return 1
    fi
  fi

  local run_user current_user
  bg_validate_backend_runtime "$app_dir" || return 1
  run_user="$(bg_backend_run_user)"
  current_user="$(id -un)"
  bg_prepare_backend_artifacts "$app_dir" || return 1

  echo "Starting mao-server-ts on port ${port} as ${run_user}..."
  bg_rotate_log "$log_file"
  mkdir -p "$log_dir"
  local entry_script='exec node dist/main.js'
  local launch_cmd=(bash -c "umask 0027; cd \"\$1\" || exit 1; set -a; if [ -f \"\$2\" ]; then . \"\$2\"; fi; set +a; export MAO_TS_PORT=\"\$3\"; ${entry_script}" _ "$app_dir" "$env_file" "$port")
  local launcher_pid
  if [ "$run_user" = "$current_user" ]; then
    setsid nohup "${launch_cmd[@]}" >> "$log_file" 2>&1 </dev/null &
  else
    setsid nohup sudo -n -H -u "$run_user" "${launch_cmd[@]}" >> "$log_file" 2>&1 </dev/null &
  fi
  launcher_pid=$!
  echo "$launcher_pid" > "$pid_file"
  disown 2>/dev/null || true
  echo "Started on port ${port} (PID: ${launcher_pid})"
}

bg_wait_healthy() {
  local app_dir="$1"
  local port="$2"
  local log_dir="$3"
  local pid_file log_file i code
  pid_file="$(bg_pid_file_for_port "$app_dir" "$port")"
  log_file="${log_dir}/backend-ts-${port}.log"
  for i in $(seq 1 "$MAO_BLUE_GREEN_HEALTH_RETRIES"); do
    if [ -f "$pid_file" ]; then
      local pid
      pid="$(tr -d '[:space:]' < "$pid_file")"
      if [ -n "$pid" ] && ! bg_process_running "$pid"; then
        echo "错误：端口 ${port} 的后端进程在健康检查前退出（PID: ${pid}）。" >&2
        bg_log_tail "$log_file"
        return 1
      fi
    fi
    code=$(curl --max-time 3 -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${port}/api/v1/health" 2>/dev/null || true)
    [ -n "$code" ] || code=000
    if [ "$code" = "200" ]; then
      echo "Health check passed on port ${port} (HTTP ${code})"
      return 0
    fi
    sleep "$MAO_BLUE_GREEN_HEALTH_INTERVAL_SEC"
  done
  echo "Health check failed on port ${port} after ${MAO_BLUE_GREEN_HEALTH_RETRIES} attempts" >&2
  bg_log_tail "$log_file"
  return 1
}

bg_log_tail() {
  local log_file="$1"
  if [ -f "$log_file" ]; then
    echo "---- ${log_file} (last 40 lines) ----" >&2
    tail -n 40 "$log_file" >&2 || true
    echo "---- end ${log_file} ----" >&2
  fi
}

bg_validate_nginx_upstream() {
  command -v nginx >/dev/null 2>&1 || return 0
  local sites_dir="${MAO_NGINX_SITES_DIR}"
  if [ ! -d "$sites_dir" ]; then
    echo "错误：Nginx sites 目录不存在：${sites_dir}，无法切换蓝绿流量。" >&2
    return 1
  fi
  if grep -RqsE 'proxy_pass[[:space:]]+http://(127\.0\.0\.1|localhost):[0-9]+([;[:space:]]|$)' "$sites_dir"; then
    echo "错误：${sites_dir} 仍有硬编码回环端口的 proxy_pass。" >&2
    echo "     蓝绿切换必须改用 http://mao_backend，否则 upstream 文件更新不会真正切流。" >&2
    echo "     请先把站点配置的两处 proxy_pass 改为 http://mao_backend，并执行 nginx -t。" >&2
    return 1
  fi
  if ! grep -RqsE 'proxy_pass[[:space:]]+http://mao_backend([;[:space:]]|$)' "$sites_dir"; then
    echo "错误：${sites_dir} 未找到 proxy_pass http://mao_backend。" >&2
    echo "     请按 DEPLOY.md 的 Nginx upstream 配置接入后再部署。" >&2
    return 1
  fi
  return 0
}

bg_switch_nginx_upstream() {
  local port="$1"
  bg_validate_nginx_upstream || return 1
  if [ ! -d "$(dirname "$MAO_NGINX_UPSTREAM_CONF")" ]; then
    echo "错误：Nginx conf 目录不存在：$(dirname "$MAO_NGINX_UPSTREAM_CONF")" >&2
    return 1
  fi
  local tmp
  tmp="$(mktemp "${TMPDIR:-/tmp}/mao-upstream.XXXXXX")"
  chmod 644 "$tmp"
  cat > "$tmp" <<EOF
upstream mao_backend {
    server 127.0.0.1:${port};
}
EOF
  local backup=""
  if [ -f "$MAO_NGINX_UPSTREAM_CONF" ]; then
    backup="$(mktemp "${TMPDIR:-/tmp}/mao-upstream-backup.XXXXXX")"
    bg_as_root cp -p "$MAO_NGINX_UPSTREAM_CONF" "$backup"
  fi
  if ! bg_as_root mv "$tmp" "$MAO_NGINX_UPSTREAM_CONF" || ! bg_as_root nginx -t || ! bg_as_root systemctl reload nginx; then
    if [ -n "$backup" ]; then
      bg_as_root cp -p "$backup" "$MAO_NGINX_UPSTREAM_CONF" 2>/dev/null || true
    else
      bg_as_root rm -f "$MAO_NGINX_UPSTREAM_CONF" 2>/dev/null || true
    fi
    bg_as_root nginx -t >/dev/null 2>&1 || true
    bg_as_root systemctl reload nginx >/dev/null 2>&1 || true
    rm -f "$tmp" 2>/dev/null || true
    bg_as_root rm -f "$backup" 2>/dev/null || true
    echo "错误：Nginx upstream 写入、校验或重载失败，已回滚。" >&2
    return 1
  fi
  bg_as_root rm -f "$backup" 2>/dev/null || true
  echo "Nginx upstream switched to port ${port}"
}

bg_write_drain_script() {
  local app_dir="$1"
  local old_port="$2"
  local new_port="$3"
  local script="$4"
  cat > "$script" <<EOS
#!/bin/bash
set -euo pipefail
echo "[\$(date -Iseconds)] drain: stopping port ${old_port} if active stays ${new_port}"
export BG_LIB_PATH="${BG_LIB_PATH}"
# shellcheck source=/dev/null
source "\$BG_LIB_PATH"
active="\$(bg_read_active_port)"
if [ "\$active" != "${new_port}" ]; then
  echo "Skip drain stop on ${old_port}: active port is \$active (expected ${new_port})"
  exit 0
fi
bg_stop_port "${app_dir}" "${old_port}"
bg_write_deploy_lock \$(date +%s) "${old_port}" "${new_port}" "drained"
EOS
  chmod +x "$script"
}

# Schedule drain via systemd timer (survives cloud shell session teardown).
bg_schedule_drain_systemd() {
  local unit="$1"
  local drain="$2"
  local script="$3"
  local drain_log="$4"
  command -v systemd-run >/dev/null 2>&1 || return 1
  systemd-run \
    --on-active="${drain}s" \
    --unit="$unit" \
    --collect \
    --property="StandardOutput=append:${drain_log}" \
    --property="StandardError=append:${drain_log}" \
    bash "$script" >/dev/null 2>&1
}

# Fallback: atd queue (also independent of caller process tree).
bg_schedule_drain_at() {
  local drain="$1"
  local script="$2"
  local drain_log="$3"
  local wrapper="${MAO_RUNTIME_DIR}/stop-old-backend-at.sh"
  command -v at >/dev/null 2>&1 || return 1
  if ! systemctl is-active atd >/dev/null 2>&1 && ! pgrep -x atd >/dev/null 2>&1; then
    return 1
  fi
  cat > "$wrapper" <<EOS
#!/bin/bash
set -euo pipefail
sleep ${drain}
bash "${script}"
EOS
  chmod +x "$wrapper"
  echo "bash ${wrapper} >> ${drain_log} 2>&1" | at now >/dev/null 2>&1
}

# Last resort: nohup sleep (may be killed when restart.sh runs inside cloud shell).
bg_schedule_drain_nohup() {
  local drain="$1"
  local script="$2"
  local drain_log="$3"
  setsid nohup bash -c "sleep ${drain}; exec bash '${script}'" >> "${drain_log}" 2>&1 </dev/null &
  disown 2>/dev/null || true
}

bg_schedule_stop_old() {
  local app_dir="$1"
  local old_port="$2"
  local new_port="$3"
  local drain="$4"
  local log_dir="$5"
  local drain_log="${log_dir}/blue-green-drain.log"
  local script="${MAO_RUNTIME_DIR}/stop-old-backend.sh"
  local unit="mao-backend-drain-${old_port}-$(date +%s)"
  local scheduler="nohup"

  mkdir -p "$log_dir"
  bg_write_drain_script "$app_dir" "$old_port" "$new_port" "$script"
  {
    echo "[$(date -Iseconds)] drain: scheduled stop port ${old_port} in ${drain}s if active stays ${new_port}"
  } >> "$drain_log"

  if bg_schedule_drain_systemd "$unit" "$drain" "$script" "$drain_log"; then
    scheduler="systemd"
  elif bg_schedule_drain_at "$drain" "$script" "$drain_log"; then
    scheduler="at"
  else
    bg_schedule_drain_nohup "$drain" "$script" "$drain_log"
  fi

  echo "Scheduled stop of old instance on port ${old_port} in ${drain}s via ${scheduler} (log: ${drain_log})"
}

# Main entry: blue-green deploy for backend-ts directory.
# Usage: BG_LIB_PATH=/path/to/blue-green.sh bg_deploy /opt/mao/backend-ts
bg_deploy() {
  local app_dir="$1"
  BG_LIB_PATH="${BG_LIB_PATH:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/blue-green.sh}"
  bg_ensure_runtime_dir
  bg_clear_stale_deploy_lock
  bg_validate_backend_runtime "$app_dir" || exit 1
  bg_validate_nginx_upstream || exit 1

  local flock_file="${MAO_RUNTIME_DIR}/deploy.flock"
  if [ ! -e "$flock_file" ] && [ ! -w "$MAO_RUNTIME_DIR" ]; then
    echo "错误：运行时目录 ${MAO_RUNTIME_DIR} 对 $(id -un) 不可写，无法创建 ${flock_file}。" >&2
    echo "     请执行 sudo chown $(id -un) ${MAO_RUNTIME_DIR} 后重试（勿递归改动 channels/workspace）。" >&2
    exit 1
  fi
  if [ -e "$flock_file" ] && [ ! -w "$flock_file" ]; then
    echo "错误：部署锁 ${flock_file} 对 $(id -un) 不可写。" >&2
    echo "     请执行 sudo rm -f ${flock_file} 后重试（确认没有进行中的 restart.sh）。" >&2
    exit 1
  fi
  # Short-lived mutex only — must release before starting Node (FD inheritance bug).
  exec 9>"$flock_file"
  if ! flock -n 9; then
    echo "Another blue-green deploy is already in progress" >&2
    echo "If this is stale, remove ${flock_file} after confirming no restart.sh is running." >&2
    exit 1
  fi

  local env_file="${app_dir}/.env"
  if [ -f "$env_file" ]; then
    set -a
    # shellcheck source=/dev/null
    source "$env_file"
    set +a
  fi

  local log_dir="${MAO_LOG_DIR:-${app_dir}/logs}"
  mkdir -p "$log_dir"

  local current_port new_port started_at
  current_port="$(bg_read_active_port)"
  if [ "$current_port" = "$MAO_BLUE_GREEN_PORT_A" ]; then
    new_port="$MAO_BLUE_GREEN_PORT_B"
  else
    new_port="$MAO_BLUE_GREEN_PORT_A"
  fi

  bg_migrate_legacy_pid "$app_dir" "$current_port"
  started_at=$(date +%s)
  bg_write_deploy_lock "$started_at" "$current_port" "$new_port" "starting"

  # Release flock before any long-running / child backend process.
  exec 9>&-

  if bg_port_in_use "$current_port"; then
    echo "Current active port: ${current_port}"
    echo "Deploying new instance on port: ${new_port}"
    # 空闲端口上若还有遗留进程（上次部署排水未完成或孤儿），必须先停掉：
    # bg_start_port 遇到存活 pid 会直接返回，health 检查会被旧进程的 200 骗过，
    # 结果把流量切到运行旧代码的实例，CI 全绿但线上接口仍是旧版本。
    if bg_port_in_use "$new_port"; then
      echo "Stale instance detected on idle port ${new_port}; stopping before start"
      if ! bg_stop_port "$app_dir" "$new_port"; then
        bg_write_deploy_lock "$started_at" "$current_port" "$new_port" "failed"
        exit 1
      fi
      if bg_port_in_use "$new_port"; then
        echo "错误：空闲端口 ${new_port} 仍被占用，终止部署以免切到旧实例。" >&2
        bg_write_deploy_lock "$started_at" "$current_port" "$new_port" "failed"
        exit 1
      fi
    fi
    if ! bg_start_port "$app_dir" "$new_port" "$log_dir"; then
      bg_stop_port "$app_dir" "$new_port" || true
      bg_write_deploy_lock "$started_at" "$current_port" "$new_port" "failed"
      exit 1
    fi
    if ! bg_wait_healthy "$app_dir" "$new_port" "$log_dir"; then
      bg_stop_port "$app_dir" "$new_port" || true
      bg_write_deploy_lock "$started_at" "$current_port" "$new_port" "failed"
      exit 1
    fi
    bg_switch_nginx_upstream "$new_port" || {
      bg_stop_port "$app_dir" "$new_port" || true
      bg_write_deploy_lock "$started_at" "$current_port" "$new_port" "failed"
      exit 1
    }
    bg_write_active_port "$new_port"
    bg_write_deploy_lock "$started_at" "$current_port" "$new_port" "switched"
    bg_schedule_stop_old "$app_dir" "$current_port" "$new_port" "$MAO_BLUE_GREEN_DRAIN_SEC" "$log_dir"
    echo "Blue-green deploy complete: traffic on ${new_port}, old instance on ${current_port} draining"
  else
    echo "No backend listening on ${current_port}; starting fresh on ${current_port}"
    if bg_port_in_use "$new_port"; then
      echo "Stopping orphan instance on alternate port ${new_port} (active port ${current_port} was down)"
      if ! bg_stop_port "$app_dir" "$new_port"; then
        bg_write_deploy_lock "$started_at" "$current_port" "$current_port" "failed"
        exit 1
      fi
    fi
    if ! bg_start_port "$app_dir" "$current_port" "$log_dir"; then
      bg_stop_port "$app_dir" "$current_port" || true
      bg_write_deploy_lock "$started_at" "$current_port" "$current_port" "failed"
      exit 1
    fi
    if ! bg_wait_healthy "$app_dir" "$current_port" "$log_dir"; then
      bg_stop_port "$app_dir" "$current_port" || true
      bg_write_deploy_lock "$started_at" "$current_port" "$current_port" "failed"
      exit 1
    fi
    bg_switch_nginx_upstream "$current_port" || {
      bg_stop_port "$app_dir" "$current_port" || true
      bg_write_deploy_lock "$started_at" "$current_port" "$current_port" "failed"
      exit 1
    }
    bg_write_active_port "$current_port"
    bg_write_deploy_lock "$started_at" "$current_port" "$current_port" "started"
    echo "Backend started on port ${current_port}"
  fi
}
