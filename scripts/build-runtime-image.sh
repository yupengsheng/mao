#!/usr/bin/env bash
# 构建 Mao 用户运行时容器镜像 mao-runtime:<tag>（技术方案 §6 部署）。
#
# 前置：宿主机已安装 Docker；在仓库根目录执行。
# 依赖来源 = backend-ts/package-lock.json（npm ci --omit=dev）；构建时写入 lock 指纹 label，
# 后端 precheck 用它判断镜像是否与当前代码依赖对齐。镜像内 Node 版本由 FROM 固定（node:22），
# 宿主机 Node 升级后必须同步重建镜像。
#
# 用法：
#   bash scripts/build-runtime-image.sh                  # 构建并更新 mao-runtime:latest
#   bash scripts/build-runtime-image.sh <tag>            # 只构建 <tag>，不改动 latest
#   bash scripts/build-runtime-image.sh <tag> --tag-latest  # 构建 <tag> 并同步 latest
#   bash scripts/build-runtime-image.sh --print-deps-hash   # 只打印 lock 指纹（不依赖 Docker）
#
# 部署自动对齐用 scripts/align-runtime-image.sh：它先构建临时 tag、冒烟通过后才切 latest。
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCKFILE="${ROOT_DIR}/backend-ts/package-lock.json"
IMAGE="${MAO_RUNTIME_IMAGE:-mao-runtime}"

sha256_hex() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$1" | awk '{print $NF}'
  else
    echo "错误：需要 sha256sum、shasum 或 openssl 计算依赖指纹" >&2
    return 1
  fi
}

if [[ ! -f "${LOCKFILE}" ]]; then
  echo "错误：缺少 ${LOCKFILE}" >&2
  exit 1
fi

DEPS_HASH="$(sha256_hex "${LOCKFILE}" | cut -c1-16)"

# 供后端单测对拍；不依赖 Docker，也不产生镜像。
TAG="latest"
TAG_SET=0
TAG_LATEST=0
PRINT_HASH=0

usage() {
  cat <<'EOF'
用法：
  bash scripts/build-runtime-image.sh                     # 构建并更新 mao-runtime:latest
  bash scripts/build-runtime-image.sh <tag>               # 只构建 <tag>，不改动 latest
  bash scripts/build-runtime-image.sh <tag> --tag-latest  # 构建 <tag> 并同步 latest
  bash scripts/build-runtime-image.sh --print-deps-hash   # 只打印 lock 指纹（不依赖 Docker）

部署自动对齐用 scripts/align-runtime-image.sh：它先构建临时 tag、冒烟通过后才切 latest。
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --print-deps-hash) PRINT_HASH=1 ;;
    --tag-latest) TAG_LATEST=1 ;;
    -h|--help) usage; exit 0 ;;
    --*)
      echo "错误：未知参数 $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      if (( TAG_SET )); then
        echo "错误：只能指定一个 tag（已指定 ${TAG}，又收到 $1）" >&2
        exit 2
      fi
      TAG="$1"
      TAG_SET=1
      ;;
  esac
  shift
done

if (( PRINT_HASH )); then
  echo "${DEPS_HASH}"
  exit 0
fi

if [[ -z "${TAG}" ]]; then
  echo "错误：tag 不能为空" >&2
  exit 2
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "错误：未检测到 docker 命令，请先安装 Docker" >&2
  exit 1
fi

# Debian 源：默认官方源；访问不了 deb.debian.org 的构建机可传 APT_MIRROR=mirrors.aliyun.com
APT_MIRROR="${APT_MIRROR:-deb.debian.org}"
echo "构建 ${IMAGE}:${TAG}（deps-hash=${DEPS_HASH}, apt=${APT_MIRROR}）"

docker build \
  --label "org.mao.runtime.deps-hash=${DEPS_HASH}" \
  --build-arg APT_MIRROR="${APT_MIRROR}" \
  -f "${ROOT_DIR}/Dockerfile.runtime" \
  -t "${IMAGE}:${TAG}" \
  "${ROOT_DIR}"

# latest 是部署切流点：自定义 tag 默认不改动它，避免构建窗口内新建容器拿到
# 「新镜像 + 旧后端」的组合；部署对齐请用 scripts/align-runtime-image.sh。
if [[ "${TAG}" == "latest" ]]; then
  echo "完成：${IMAGE}:latest（deps-hash=${DEPS_HASH}）"
elif (( TAG_LATEST )); then
  docker tag "${IMAGE}:${TAG}" "${IMAGE}:latest"
  echo "完成：${IMAGE}:${TAG}（deps-hash=${DEPS_HASH}，已同步 tag ${IMAGE}:latest）"
else
  echo "完成：${IMAGE}:${TAG}（deps-hash=${DEPS_HASH}，未改动 ${IMAGE}:latest）"
fi
