#!/bin/bash
# =============================================================================
# remote-deploy.sh — 在线上服务器执行一次完整部署
#
# 供 GitHub Actions（.github/workflows/ci.yml 的 deploy 任务）或手工调用：
# workflow 只负责 SSH 登录，真正的部署动作全部在服务器上按 DEPLOY.md 的人工口径执行，
# 构建产物留在服务器本地，避免 CI 与线上工具链版本不一致。
#
# 顺序不可调换（DEPLOY.md）：
#   1) deploy-desktop.sh  构建 desktop/dist（Nginx root 直接指向该目录）
#   2) deploy-admin.sh    构建 admin/dist 并 rsync 到 /opt/mao/admin/dist
#   3) restart-backend.sh 构建后端 + 对齐 mao-runtime 镜像 + 蓝绿重启
# 先 desktop 后 admin：管理后台浮窗助手的 Embed SDK 产物由 desktop 部署提供，反序则浮窗不出现。
#
# 用法（在服务器上执行）：
#   bash /opt/mao/scripts/remote-deploy.sh [--ref main] [--expect-commit <sha>] [--no-pull]
#
# 选项：
#   --ref <name>          拉取并检出的分支/标签（默认 main）
#   --expect-commit <sha> CI 校验过的具体提交；线上 HEAD 与之不符时直接中止，
#                         避免部署到未经验证的提交
#   --no-pull             跳过 git pull，只跑三个部署脚本（要求线上代码已是目标版本）
# =============================================================================
set -euo pipefail

REF="main"
EXPECT_COMMIT=""
NO_PULL=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --ref)
      [ "$#" -ge 2 ] || { echo "错误：--ref 需要参数" >&2; exit 2; }
      REF="$2"; shift 2 ;;
    --ref=*)
      REF="${1#*=}"; shift ;;
    --expect-commit)
      [ "$#" -ge 2 ] || { echo "错误：--expect-commit 需要参数" >&2; exit 2; }
      EXPECT_COMMIT="$2"; shift 2 ;;
    --expect-commit=*)
      EXPECT_COMMIT="${1#*=}"; shift ;;
    --no-pull)
      NO_PULL=1; shift ;;
    -h|--help)
      sed -n '2,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *)
      echo "错误：未知参数 $1" >&2
      exit 2 ;;
  esac
done

ROOT_DIR="${MAO_ROOT_DIR:-/opt/mao}"
# 首次部署：线上还没有检出时按 MAO_REPO_URL 克隆（默认项目仓库），
# 之后每次部署只做 git pull，不重复克隆。
REPO_URL="${MAO_REPO_URL:-https://github.com/yupengsheng/mao.git}"

# ---- 前置检查：执行用户必须能写线上目录（构建产物、检出与 .env 都落在 /opt/mao 下）----
# 放在克隆之前，避免非特权用户在 /opt 下留下半个仓库。
if ! mkdir -p "$ROOT_DIR/.remote-deploy-probe" 2>/dev/null; then
  # 非特权用户时自动提权重跑（要求服务器配置了该用户的免密 sudo）
  if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    echo "==> 当前用户无权写入 $ROOT_DIR，以 sudo 重跑..."
    exec sudo -n bash "$ROOT_DIR/scripts/remote-deploy.sh" "$@"
  fi
  echo "错误：当前用户无权写入 $ROOT_DIR。" >&2
  echo "     请把部署用户加入 $ROOT_DIR 的属主/属组，或为其配置免密 sudo 后重试。" >&2
  exit 1
fi
rmdir "$ROOT_DIR/.remote-deploy-probe"

if [ ! -d "$ROOT_DIR/.git" ]; then
  if [ "${NO_PULL}" -eq 1 ]; then
    echo "错误：$ROOT_DIR 不是 git 检出，且指定了 --no-pull，无法部署" >&2
    exit 1
  fi
  echo "==> $ROOT_DIR 尚无检出，首次克隆 $REPO_URL ..."
  git clone "$REPO_URL" "$ROOT_DIR"
fi

cd "$ROOT_DIR"

# ---- 前置检查：线上目录脏时拒绝拉取，避免 git pull 中途失败留下半成品 ----
if [ "$NO_PULL" -eq 0 ]; then
  dirty="$(git status --porcelain)"
  if [ -n "$dirty" ]; then
    echo "错误：$ROOT_DIR 存在未提交改动，拒绝自动拉取。请先人工处理后重试：" >&2
    printf '%s\n' "$dirty" >&2
    exit 1
  fi

  echo "==> 拉取 $REF ..."
  git fetch --prune origin
  git checkout "$REF"
  # --ff-only：线上只做快进，禁止自动生成合并提交，便于事后用 git log 回溯部署内容
  git pull --ff-only origin "$REF"
fi

HEAD_SHA="$(git rev-parse HEAD)"
echo "==> 线上 HEAD：$HEAD_SHA（$REF）"

if [ -n "$EXPECT_COMMIT" ] && [ "$HEAD_SHA" != "$EXPECT_COMMIT" ]; then
  echo "错误：线上 HEAD ($HEAD_SHA) 与本次 CI 校验的提交 ($EXPECT_COMMIT) 不一致。" >&2
  echo "     可能 $REF 在 CI 期间又前进了提交。请确认线上版本符合预期后重跑，" >&2
  echo "     或改用 --expect-commit $HEAD_SHA 显式放行当前版本。" >&2
  exit 1
fi

if ! git diff --quiet HEAD -- . 2>/dev/null; then
  echo "错误：检出后工作区仍不干净，终止部署。" >&2
  exit 1
fi

# ---- 依赖安装：仅在相对上次部署有依赖变化时重装 ----
# node_modules 常驻线上，全量 npm ci 每次部署要数分钟。用标记文件记录上次部署的提交，
# 只在该区间内依赖清单变化时才重装，避免每次部署都跑完整安装。
MARKER="$ROOT_DIR/.last-deployed-sha"
PREV_SHA=""
if [ -f "$MARKER" ]; then
  PREV_SHA="$(tr -d ' \n\r' < "$MARKER")"
fi

deps_changed=""
if [ -n "$PREV_SHA" ] && git merge-base --is-ancestor "$PREV_SHA" HEAD 2>/dev/null; then
  # 上次部署在当前 HEAD 的历史上：比对该区间，覆盖多提交累积的依赖变化
  deps_changed="$(git diff --name-only "$PREV_SHA" HEAD -- \
    'backend-ts/package.json' 'backend-ts/package-lock.json' \
    'admin/package.json' 'admin/package-lock.json' \
    'desktop/package.json' 'desktop/package-lock.json')"
elif [ -z "$PREV_SHA" ]; then
  # 首次自动部署：线上没有历史标记，按最近一次提交判断，宁可多装一次
  deps_changed="$(git diff --name-only HEAD~1 HEAD -- \
    'backend-ts/package.json' 'backend-ts/package-lock.json' \
    'admin/package.json' 'admin/package-lock.json' \
    'desktop/package.json' 'desktop/package-lock.json' 2>/dev/null || true)"
fi

need_ci_dirs=()
declare -A need_ci_dir_seen=()
add_need_ci_dir() {
  local dir="$1"
  if [ -z "${need_ci_dir_seen[$dir]+x}" ]; then
    need_ci_dirs+=("$dir")
    need_ci_dir_seen["$dir"]=1
  fi
}
if [ -n "$deps_changed" ]; then
  echo "==> 检测到依赖清单变化，需重装依赖："
  printf '    %s\n' "$deps_changed"
  for dir in backend-ts admin desktop; do
    case "$deps_changed" in
      *"$dir/package.json"*|*"$dir/package-lock.json"*) add_need_ci_dir "$dir" ;;
    esac
  done
fi
# 兜底：node_modules 缺失时（首次部署或被清理）必须安装
for dir in backend-ts admin desktop; do
  if [ ! -d "$ROOT_DIR/$dir/node_modules" ]; then
    echo "==> $dir 缺少 node_modules，需安装依赖"
    add_need_ci_dir "$dir"
  fi
done

if [ "${#need_ci_dirs[@]}" -gt 0 ]; then
  for dir in "${need_ci_dirs[@]}"; do
    echo "==> 安装依赖：$dir（npm ci）..."
    (cd "$ROOT_DIR/$dir" && npm ci)
  done
else
  echo "==> 依赖清单与 node_modules 均无变化，跳过 npm ci"
fi

# ---- 部署三端 ----
echo "==> 部署 desktop（构建 desktop/dist）..."
bash "$ROOT_DIR/scripts/deploy-desktop.sh"

echo "==> 部署 admin（构建并同步 /opt/mao/admin/dist）..."
bash "$ROOT_DIR/scripts/deploy-admin.sh"

echo "==> 部署 backend-ts（构建 + 对齐运行时镜像 + 蓝绿重启）..."
bash "$ROOT_DIR/scripts/restart-backend.sh"

# 记录本次部署的提交，供下次部署比对依赖变化
echo "$HEAD_SHA" > "$MARKER"
echo "已记录本次部署提交到 $MARKER"

echo "部署完成：HEAD=$HEAD_SHA"
