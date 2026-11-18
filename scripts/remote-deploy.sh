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
#   bash /opt/mao/scripts/remote-deploy.sh [--ref main] [--expect-commit <sha>] [--bundle <path>] [--no-pull]
#
# 选项：
#   --ref <name>          拉取并检出的分支/标签（默认 main）
#   --expect-commit <sha> CI 校验过的具体提交；线上 HEAD 与之不符时直接中止，
#                         避免部署到未经验证的提交
#   --bundle <path>      使用 GitHub Actions 上传到服务器的 git bundle 更新代码，
#                         避免服务器直接访问 GitHub（适合服务器出网/TLS 不稳定时）
#   --no-pull             跳过 git pull，只跑三个部署脚本（要求线上代码已是目标版本）
# =============================================================================
set -euo pipefail

REF="main"
EXPECT_COMMIT=""
BUNDLE_PATH=""
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
    --bundle)
      [ "$#" -ge 2 ] || { echo "错误：--bundle 需要参数" >&2; exit 2; }
      BUNDLE_PATH="$2"; shift 2 ;;
    --bundle=*)
      BUNDLE_PATH="${1#*=}"; shift ;;
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

# ---- 前置检查：Docker 权限与运行时目录可写 ----
# 这两项原本只在后端阶段才用到，失败时 desktop/admin 已经发布，会留下
# 「前端新、后端旧」的混合版本。统一提前到拉取之前校验。
if ! docker info >/dev/null 2>&1; then
  echo "错误：当前用户（$(id -un)）无权访问 Docker，运行时镜像对齐与蓝绿重启无法执行。" >&2
  echo "     请执行 sudo usermod -aG docker $(id -un) 后重新登录（组权限需新会话生效），" >&2
  echo "     或为 /var/run/docker.sock 配置 ACL 后重试。" >&2
  exit 1
fi

RUNTIME_DIR="${MAO_RUNTIME_DIR:-/opt/mao-data/runtime}"
if ! mkdir -p "$RUNTIME_DIR" 2>/dev/null || [ ! -w "$RUNTIME_DIR" ]; then
  echo "错误：运行时目录 $RUNTIME_DIR 对 $(id -un) 不可写，蓝绿重启无法创建部署锁。" >&2
  echo "     请执行 sudo chown $(id -un) $RUNTIME_DIR（只需该目录，勿递归改动 channels/workspace）。" >&2
  exit 1
fi

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
  dirty="$(git status --porcelain | awk 'substr($0, 4) != "desktop/.env.production"')"
  if [ -n "$dirty" ]; then
    echo "错误：$ROOT_DIR 存在未提交改动，拒绝自动拉取。请先人工处理后重试：" >&2
    printf '%s\n' "$dirty" >&2
    exit 1
  fi

  # 生产环境允许单独维护 desktop/.env.production。它是已跟踪文件，
  # 即使上面的脏检查排除了它，git pull 仍会因为本地改动可能被覆盖而中止。
  # 拉取期间暂时恢复仓库版本，完成后把线上配置原样写回；失败退出也通过 trap 恢复。
  ENV_FILE="$ROOT_DIR/desktop/.env.production"
  ENV_BACKUP=""
  restore_desktop_env() {
    if [ -n "$ENV_BACKUP" ] && [ -f "$ENV_BACKUP" ]; then
      cp -p "$ENV_BACKUP" "$ENV_FILE"
      rm -f "$ENV_BACKUP"
      ENV_BACKUP=""
    fi
  }
  if [ -f "$ENV_FILE" ] && ! git diff --quiet HEAD -- "$ENV_FILE"; then
    ENV_BACKUP="$(mktemp)"
    cp -p "$ENV_FILE" "$ENV_BACKUP"
    git restore --source=HEAD --staged --worktree -- "$ENV_FILE"
    trap restore_desktop_env EXIT
  fi

  if [ -n "$BUNDLE_PATH" ]; then
    [ -f "$BUNDLE_PATH" ] || {
      echo "错误：找不到提交 bundle：$BUNDLE_PATH" >&2
      exit 1
    }
    echo "==> 使用已校验提交 bundle 更新 $REF ..."
    git fetch --prune "$BUNDLE_PATH" "$REF"
    git checkout "$REF"
    # bundle 来自 CI 已通过的提交；仍只允许快进，避免覆盖线上意外提交。
    git merge --ff-only FETCH_HEAD
  else
    echo "==> 拉取 $REF ..."
    git fetch --prune origin
    git checkout "$REF"
    # --ff-only：线上只做快进，禁止自动生成合并提交，便于事后用 git log 回溯部署内容
    git pull --ff-only origin "$REF"
  fi
  restore_desktop_env
  trap - EXIT
fi

HEAD_SHA="$(git rev-parse HEAD)"
echo "==> 线上 HEAD：${HEAD_SHA}（${REF}）"

if [ -n "$EXPECT_COMMIT" ] && [ "$HEAD_SHA" != "$EXPECT_COMMIT" ]; then
  echo "错误：线上 HEAD ($HEAD_SHA) 与本次 CI 校验的提交 ($EXPECT_COMMIT) 不一致。" >&2
  echo "     可能 $REF 在 CI 期间又前进了提交。请确认线上版本符合预期后重跑，" >&2
  echo "     或改用 --expect-commit $HEAD_SHA 显式放行当前版本。" >&2
  exit 1
fi

if ! git diff --quiet HEAD -- . ':(exclude)desktop/.env.production' 2>/dev/null; then
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
add_need_ci_dir() {
  local dir="$1"
  local existing
  for existing in "${need_ci_dirs[@]-}"; do
    [ "$existing" = "$dir" ] && return
  done
  need_ci_dirs+=("$dir")
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
# 兜底：node_modules 缺失或依赖树不完整时（例如手工清理过单个包）必须安装。
# 仅判断目录存在不够：旧目录可能缺少新加入的直接依赖，导致 vue-tsc 在构建阶段才失败。
for dir in backend-ts admin desktop; do
  if [ ! -d "$ROOT_DIR/$dir/node_modules" ] || ! (cd "$ROOT_DIR/$dir" && npm ls --depth=0 >/dev/null 2>&1); then
    echo "==> $dir 的 node_modules 缺失或依赖树不完整，需安装依赖"
    add_need_ci_dir "$dir"
  fi
done

if [ "${#need_ci_dirs[@]}" -gt 0 ]; then
  for dir in "${need_ci_dirs[@]}"; do
    echo "==> 安装依赖：${dir}（npm ci）..."
    if [ "$dir" = "desktop" ]; then
      # 服务器只构建 desktop/dist，不打 Electron 安装包；跳过 Electron 的二进制下载脚本，
      # 避免服务器出网/TLS 不稳定时 npm ci 因 electron/install.js 失败。
      (cd "$ROOT_DIR/$dir" && npm ci --ignore-scripts)
    else
      (cd "$ROOT_DIR/$dir" && npm ci)
    fi
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
