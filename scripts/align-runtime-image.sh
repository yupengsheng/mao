#!/usr/bin/env bash
# 部署前把 mao-runtime:latest 对齐到当前 backend-ts/package-lock.json。
#
# 幂等：lock 指纹与 latest 一致时直接退出（--force 可强制重建）。
# 安全切流：新镜像先构建到临时 tag，用当前 backend-ts/dist 做加载冒烟
# （runtime-agent + sharp + node-pty，与后端 precheck 同一条命令）；通过后才创建
# dated tag 并移动 latest。任一步失败旧 latest 保持不变，部署脚本随之中止。
#
# 用法：
#   bash scripts/align-runtime-image.sh            # 指纹不一致时重建并对齐
#   bash scripts/align-runtime-image.sh --force    # 无条件重建
#   bash scripts/align-runtime-image.sh --help
#
# 环境变量：
#   MAO_RUNTIME_IMAGE       镜像名（默认 mao-runtime）
#   MAO_CONTAINER_DIST_DIR  当前 dist 绝对路径（默认 <repo>/backend-ts/dist，
#                           与后端 MAO_CONTAINER_DIST_DIR 同口径）
#   MAO_RUNTIME_ALIGN_KEEP  dated tag 保留数量（默认 2）
#
# 前置：Docker 可用；后端已构建（backend-ts/dist/harness/container/runtime-agent.js 存在）。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
IMAGE="${MAO_RUNTIME_IMAGE:-mao-runtime}"
LOCKFILE="${ROOT_DIR}/backend-ts/package-lock.json"
BUILD_SCRIPT="${SCRIPT_DIR}/build-runtime-image.sh"
DIST_DIR="${MAO_CONTAINER_DIST_DIR:-${ROOT_DIR}/backend-ts/dist}"
KEEP="${MAO_RUNTIME_ALIGN_KEEP:-2}"
DEPS_HASH_LABEL="org.mao.runtime.deps-hash"

FORCE=0

usage() {
  cat <<'EOF'
用法：
  bash scripts/align-runtime-image.sh            # 指纹不一致时重建并对齐
  bash scripts/align-runtime-image.sh --force    # 无条件重建
  bash scripts/align-runtime-image.sh --help

环境变量：
  MAO_RUNTIME_IMAGE       镜像名（默认 mao-runtime）
  MAO_CONTAINER_DIST_DIR  当前 dist 绝对路径（默认 <repo>/backend-ts/dist）
  MAO_RUNTIME_ALIGN_KEEP  dated tag 保留数量（默认 2）

前置：Docker 可用；后端已构建（backend-ts/dist/harness/container/runtime-agent.js 存在）。
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -f|--force) FORCE=1 ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "错误：未知参数 $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

if ! [[ "${KEEP}" =~ ^[0-9]+$ ]] || (( KEEP < 1 )); then
  echo "错误：MAO_RUNTIME_ALIGN_KEEP 必须是正整数（当前 ${KEEP}）" >&2
  exit 2
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "错误：未检测到 docker 命令；运行时镜像对齐需要 Docker（host 模式部署机也需安装）" >&2
  exit 1
fi

if [[ ! -f "${LOCKFILE}" ]]; then
  echo "错误：缺少 ${LOCKFILE}" >&2
  exit 1
fi

WANT="$(bash "${BUILD_SCRIPT}" --print-deps-hash)"

LATEST_EXISTS=0
HAVE=""
if HAVE_RAW="$(docker image inspect "${IMAGE}:latest" \
  --format "{{index .Config.Labels \"${DEPS_HASH_LABEL}\"}}" 2>/dev/null)"; then
  LATEST_EXISTS=1
  HAVE="$(printf '%s' "${HAVE_RAW}" | tr -d '[:space:]')"
  # 旧镜像无 label 时 docker 输出 <no value>；按缺失处理。
  if [[ ! "${HAVE}" =~ ^[0-9a-f]{16}$ ]]; then
    HAVE=""
  fi
fi

if (( ! FORCE )) && [[ "${HAVE}" == "${WANT}" ]]; then
  echo "运行时镜像已对齐：${IMAGE}:latest（deps-hash=${WANT}）"
  exit 0
fi

if [[ ! -f "${DIST_DIR}/harness/container/runtime-agent.js" ]]; then
  echo "错误：找不到 ${DIST_DIR}/harness/container/runtime-agent.js" >&2
  echo "      请先构建后端：cd backend-ts && npm run build" >&2
  exit 1
fi
DIST_DIR="$(cd "${DIST_DIR}" && pwd)"

SHORT_SHA="$(git -C "${ROOT_DIR}" rev-parse --short HEAD 2>/dev/null || true)"
SHORT_SHA="${SHORT_SHA:-nogit}"
BUILD_TAG="build-${SHORT_SHA}-$(date +%Y%m%d%H%M%S)"
DATED_TAG="$(date +%F)-${SHORT_SHA}"

if (( FORCE )); then
  echo "强制重建运行时镜像 ${IMAGE}:${BUILD_TAG}（当前指纹 ${HAVE:-缺失}，期望 ${WANT}）"
elif (( ! LATEST_EXISTS )); then
  echo "运行时镜像 ${IMAGE}:latest 不存在，开始构建 ${IMAGE}:${BUILD_TAG}（deps-hash=${WANT}）"
elif [[ -z "${HAVE}" ]]; then
  echo "运行时镜像缺少依赖指纹 label，开始重建 ${IMAGE}:${BUILD_TAG}（期望 ${WANT}）"
else
  echo "运行时镜像依赖指纹过期（镜像 ${HAVE} ≠ 当前 ${WANT}），开始重建 ${IMAGE}:${BUILD_TAG}"
fi

cleanup_failed() {
  local status=$?
  if (( status != 0 )); then
    docker rmi "${IMAGE}:${BUILD_TAG}" >/dev/null 2>&1 || true
    echo "对齐失败：${IMAGE}:latest 保持不变，可修复后重跑 scripts/align-runtime-image.sh" >&2
  fi
}
trap cleanup_failed EXIT

bash "${BUILD_SCRIPT}" "${BUILD_TAG}"

echo "==> 冒烟：在 ${IMAGE}:${BUILD_TAG} 内加载当前 dist / sharp / node-pty"
SMOKE_CODE="Promise.all([import('file://${DIST_DIR}/harness/container/runtime-agent.js'), import('sharp'), import('node-pty')])"
SMOKE_CODE+=".catch((e) => { console.error('[align]', (e && e.message) || e); process.exit(1); });"
docker run --rm \
  -w "$(dirname "${DIST_DIR}")" \
  -v "${DIST_DIR}:${DIST_DIR}:ro" \
  "${IMAGE}:${BUILD_TAG}" \
  node -e "${SMOKE_CODE}"

# 冒烟通过后才创建可回滚的 dated tag，并把 latest 指向新镜像（切流点）。
docker tag "${IMAGE}:${BUILD_TAG}" "${IMAGE}:${DATED_TAG}"
docker tag "${IMAGE}:${BUILD_TAG}" "${IMAGE}:latest"
echo "运行时镜像已对齐：${IMAGE}:latest -> ${IMAGE}:${DATED_TAG}（deps-hash=${WANT}）"

docker rmi "${IMAGE}:${BUILD_TAG}" >/dev/null 2>&1 || true
docker image prune -f >/dev/null 2>&1 || true

# 只保留最近 KEEP 个 dated tag（默认 2 个，够回滚一版）。按 tag 名倒序即按日期倒序。
pruned=0
index=0
while IFS= read -r tag; do
  [[ -n "${tag}" ]] || continue
  index=$((index + 1))
  if (( index > KEEP )); then
    docker rmi "${IMAGE}:${tag}" >/dev/null 2>&1 || true
    echo "已清理旧镜像 tag：${IMAGE}:${tag}"
    pruned=$((pruned + 1))
  fi
done < <(docker image ls --format '{{.Tag}}' "${IMAGE}" 2>/dev/null \
  | grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9A-Za-z._-]+$' \
  | sort -ru || true)

if (( pruned == 0 )); then
  echo "保留最近 ${KEEP} 个 dated tag；无需要清理的旧 tag"
fi
