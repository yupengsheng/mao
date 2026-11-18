#!/bin/bash
# 构建并蓝绿重启后端服务（生产环境走 backend-ts/restart.sh）
set -euo pipefail

# 线上后端以 mao 用户运行，构建文件必须对运行用户可读。
umask 0022

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BACKEND_DIR="${PROJECT_DIR}/backend-ts"

echo "==> 构建后端（tsc）..."
cd "$BACKEND_DIR"
npm run build

echo "==> 对齐运行时镜像（mao-runtime:latest）..."
bash "${SCRIPT_DIR}/align-runtime-image.sh"

echo "==> 蓝绿重启后端..."
exec bash "${BACKEND_DIR}/restart.sh"
