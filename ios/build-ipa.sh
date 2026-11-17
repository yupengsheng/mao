#!/bin/bash
# =============================================================================
# build-ipa.sh — 构建 Mao iOS 归档并导出 IPA
#
# iOS 壳远程加载 https://mao.yupengsheng.cn，前端改动部署 Web 即可；只有原生壳
# （Info.plist / Swift 插件 / 图标 / Capacitor 配置）变化时才需要重新出包。
#
# 用法：
#   ./build-ipa.sh                              # 从根 CHANGELOG.md 取版本
#   ./build-ipa.sh --version 1.0.18             # 指定市场版本号
#   ./build-ipa.sh --export-method ad-hoc       # development(默认)/ad-hoc/app-store/enterprise
#   ./build-ipa.sh --dry-run                    # 只做依赖准备与配置检查，不归档
#
# 环境要求：
#   - 完整 Xcode（不是 Command Line Tools），xcodebuild 可用
#   - CocoaPods（pod）
#   - Node.js / npm
#   - Apple Developer Team ID：MAO_IOS_TEAM_ID
#   - 可选：MAO_IOS_BUNDLE_ID（默认 cn.yupengsheng.mao.app）
#   - 可选：MAO_IOS_PROVISIONING_PROFILE（手动描述文件名称；默认自动签名）
#
# 产出：
#   - ios/build/ipa/Mao.ipa
#   - ios/build/Mao.xcarchive
#
# 注意：iOS 不能像 Android APK 一样在应用内下载后直接安装。正式分发走
# TestFlight / App Store，内测走 Ad Hoc（需登记设备 UDID）或企业签名。
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
IOS_DIR="$SCRIPT_DIR"
CHANGELOG_EXTRACT="$PROJECT_ROOT/scripts/changelog-extract.sh"
CHANGELOG_FILE="$PROJECT_ROOT/CHANGELOG.md"

DRY_RUN=false
CUSTOM_VERSION=""
EXPORT_METHOD="${MAO_IOS_EXPORT_METHOD:-development}"
BUNDLE_ID="${MAO_IOS_BUNDLE_ID:-cn.yupengsheng.mao.app}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    --version) CUSTOM_VERSION="$2"; shift 2 ;;
    --export-method) EXPORT_METHOD="$2"; shift 2 ;;
    *) echo "未知参数: $1"; exit 1 ;;
  esac
done

case "$EXPORT_METHOD" in
  development|ad-hoc|app-store|enterprise) ;;
  *) echo "错误：--export-method 仅支持 development / ad-hoc / app-store / enterprise"; exit 1 ;;
esac

if ! command -v npx >/dev/null 2>&1; then
  echo "错误：未找到 npx，请先安装 Node.js"; exit 1
fi

XCODE_PATH="$(xcode-select -p 2>/dev/null || true)"
if ! command -v xcodebuild >/dev/null 2>&1 || [[ "$XCODE_PATH" != *"Xcode.app/Contents/Developer"* ]]; then
  if [ "$DRY_RUN" = true ]; then
    echo "警告：未找到完整 Xcode（当前 ${XCODE_PATH}），dry-run 跳过归档检查"
  else
    echo "错误：归档 IPA 需要完整 Xcode，当前 xcode-select 指向 ${XCODE_PATH}"
    echo "     请执行：sudo xcode-select -s /Applications/Xcode.app/Contents/Developer"
    exit 1
  fi
fi

HAS_POD=true
if ! command -v pod >/dev/null 2>&1; then
  HAS_POD=false
  if [ "$DRY_RUN" = true ]; then
    echo "警告：未找到 CocoaPods，dry-run 跳过 pod install"
  else
    echo "错误：未找到 CocoaPods，请先执行 sudo gem install cocoapods"; exit 1
  fi
fi

if [ -n "$CUSTOM_VERSION" ]; then
  VERSION_NAME="$CUSTOM_VERSION"
else
  VERSION_NAME=$("$CHANGELOG_EXTRACT" version "$CHANGELOG_FILE")
  if [ -z "$VERSION_NAME" ]; then
    echo "错误：无法从 CHANGELOG.md 提取版本号，请使用 --version 手动指定"; exit 1
  fi
fi

if [ "$DRY_RUN" = false ] && [ -z "${MAO_IOS_TEAM_ID:-}" ]; then
  echo "错误：MAO_IOS_TEAM_ID 未设置（Apple Developer Team ID）"; exit 1
fi

BUILD_NUMBER="$(date +%Y%m%d%H%M)"
ARCHIVE_PATH="$IOS_DIR/build/Mao.xcarchive"
EXPORT_DIR="$IOS_DIR/build/ipa"
EXPORT_OPTIONS="$IOS_DIR/build/ExportOptions.plist"

echo "=========================================="
echo "  Mao iOS IPA 构建"
echo "=========================================="
echo "  版本: $VERSION_NAME ($BUILD_NUMBER)"
echo "  Bundle ID: $BUNDLE_ID"
echo "  远程: https://mao.yupengsheng.cn"
echo "  导出方式: $EXPORT_METHOD"
echo "  签名 Team: ${MAO_IOS_TEAM_ID:-<dry-run 未设置>}"
echo "=========================================="
echo ""

echo "[1/4] 准备 Capacitor 依赖..."
cd "$IOS_DIR"
if [ -f package-lock.json ]; then
  npm ci
else
  npm install
fi
npx cap copy ios

if [ "$HAS_POD" = true ]; then
  echo "[2/4] 安装 CocoaPods 依赖..."
  (cd "$IOS_DIR/App" && pod install)
else
  echo "[2/4] 跳过 CocoaPods（dry-run）"
fi

if $DRY_RUN; then
  echo ""
  echo "=========================================="
  echo "  DRY-RUN：依赖与配置就绪，未归档、未签名"
  echo "=========================================="
  exit 0
fi

echo "[3/4] Xcode archive..."
rm -rf "$ARCHIVE_PATH" "$EXPORT_DIR"
mkdir -p "$EXPORT_DIR"

SIGN_ARGS=(
  "DEVELOPMENT_TEAM=$MAO_IOS_TEAM_ID"
  "PRODUCT_BUNDLE_IDENTIFIER=$BUNDLE_ID"
  "MARKETING_VERSION=$VERSION_NAME"
  "CURRENT_PROJECT_VERSION=$BUILD_NUMBER"
)
if [ -n "${MAO_IOS_PROVISIONING_PROFILE:-}" ]; then
  SIGN_ARGS+=("PROVISIONING_PROFILE_SPECIFIER=$MAO_IOS_PROVISIONING_PROFILE")
fi

xcodebuild archive \
  -workspace "$IOS_DIR/App/App.xcworkspace" \
  -scheme App \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$ARCHIVE_PATH" \
  -allowProvisioningUpdates \
  "${SIGN_ARGS[@]}"

if [ ! -d "$ARCHIVE_PATH" ]; then
  echo "错误：archive 产物不存在: $ARCHIVE_PATH"; exit 1
fi

cat > "$EXPORT_OPTIONS" <<ENDPLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key>
  <string>$EXPORT_METHOD</string>
  <key>signingStyle</key>
  <string>automatic</string>
  <key>teamID</key>
  <string>$MAO_IOS_TEAM_ID</string>
  <key>destination</key>
  <string>export</string>
  <key>stripSwiftSymbols</key>
  <true/>
  <key>compileBitcode</key>
  <false/>
</dict>
</plist>
ENDPLIST

echo "[4/4] 导出 IPA..."
xcodebuild -exportArchive \
  -archivePath "$ARCHIVE_PATH" \
  -exportPath "$EXPORT_DIR" \
  -exportOptionsPlist "$EXPORT_OPTIONS" \
  -allowProvisioningUpdates

IPA_SOURCE="$(find "$EXPORT_DIR" -maxdepth 1 -name '*.ipa' -print -quit)"
if [ -z "$IPA_SOURCE" ]; then
  echo "错误：未找到导出的 IPA"; exit 1
fi
cp "$IPA_SOURCE" "$EXPORT_DIR/Mao.ipa"

echo ""
echo "=========================================="
echo "  构建完成"
echo "=========================================="
echo "  IPA:     $EXPORT_DIR/Mao.ipa"
echo "  Archive: $ARCHIVE_PATH"
echo "  版本:    $VERSION_NAME ($BUILD_NUMBER)"
echo "  分发:    TestFlight / App Store / Ad Hoc"
echo "=========================================="
