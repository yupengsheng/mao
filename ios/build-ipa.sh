#!/bin/bash
# =============================================================================
# build-ipa.sh — 构建 Mao iOS 归档并导出 IPA
#
# iOS 使用 SwiftUI 原生界面，直接访问生产 API / WebSocket；原生代码变化时需要重新出包。
#
# 用法：
#   ./build-ipa.sh                              # 从根 CHANGELOG.md 取版本
#   ./build-ipa.sh --version 1.0.20             # 指定市场版本号
#   ./build-ipa.sh --export-method ad-hoc       # app-store(默认)/development/ad-hoc/enterprise
#   ./build-ipa.sh --dry-run                    # 只做依赖准备与配置检查，不归档
#
# 环境要求：
#   - 完整 Xcode（不是 Command Line Tools），xcodebuild 可用
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
EXPORT_METHOD="${MAO_IOS_EXPORT_METHOD:-app-store}"
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
  app-store-connect) EXPORT_METHOD="app-store" ;;
  development|ad-hoc|app-store|enterprise) ;;
  *) echo "错误：--export-method 仅支持 development / ad-hoc / app-store(app-store-connect) / enterprise"; exit 1 ;;
esac

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
echo "  API:   https://mao.yupengsheng.cn/api/v1"
echo "  导出方式: $EXPORT_METHOD"
echo "  签名 Team: ${MAO_IOS_TEAM_ID:-<dry-run 未设置>}"
echo "=========================================="
echo ""

echo "[1/2] 检查纯原生工程..."
cd "$IOS_DIR"

if $DRY_RUN; then
  echo ""
  echo "=========================================="
  echo "  DRY-RUN：原生工程检查完成，未归档、未签名"
  echo "=========================================="
  exit 0
fi

echo "[1/2] Xcode archive..."
rm -rf "$ARCHIVE_PATH" "$EXPORT_DIR"
mkdir -p "$EXPORT_DIR"

SIGN_ARGS=(
  "DEVELOPMENT_TEAM=$MAO_IOS_TEAM_ID"
  "PRODUCT_BUNDLE_IDENTIFIER=$BUNDLE_ID"
  "MARKETING_VERSION=$VERSION_NAME"
  "CURRENT_PROJECT_VERSION=$BUILD_NUMBER"
  "CODE_SIGN_STYLE=Automatic"
)
if [ -n "${MAO_IOS_PROVISIONING_PROFILE:-}" ]; then
  SIGN_ARGS+=("CODE_SIGN_STYLE=Manual" "PROVISIONING_PROFILE_SPECIFIER=$MAO_IOS_PROVISIONING_PROFILE")
elif [[ "$EXPORT_METHOD" != "app-store" ]]; then
  cat >&2 <<'EOF'
错误：当前 Release 配置使用 App Store Distribution 描述文件。
development / ad-hoc / enterprise 导出请设置对应的 MAO_IOS_PROVISIONING_PROFILE，
或在 Xcode 中把 Release 签名改为自动签名后重试。
EOF
  exit 1
fi

xcodebuild archive \
  -project "$IOS_DIR/App/App.xcodeproj" \
  -scheme App \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$ARCHIVE_PATH" \
  -allowProvisioningUpdates \
  "${SIGN_ARGS[@]}"

if [ ! -d "$ARCHIVE_PATH" ]; then
  echo "错误：archive 产物不存在: $ARCHIVE_PATH"; exit 1
fi

EXPORT_SIGNING_STYLE="automatic"
if [ -n "${MAO_IOS_PROVISIONING_PROFILE:-}" ]; then
  EXPORT_SIGNING_STYLE="manual"
fi

cat > "$EXPORT_OPTIONS" <<ENDPLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key>
  <string>$EXPORT_METHOD</string>
  <key>signingStyle</key>
  <string>$EXPORT_SIGNING_STYLE</string>
  <key>teamID</key>
  <string>$MAO_IOS_TEAM_ID</string>
  <key>destination</key>
  <string>export</string>
  <key>stripSwiftSymbols</key>
  <true/>
  <key>compileBitcode</key>
  <false/>
$(if [ -n "${MAO_IOS_PROVISIONING_PROFILE:-}" ]; then cat <<PROFILE_ENTRY
  <key>provisioningProfiles</key>
  <dict>
    <key>$BUNDLE_ID</key>
    <string>$MAO_IOS_PROVISIONING_PROFILE</string>
  </dict>
PROFILE_ENTRY
fi)
</dict>
</plist>
ENDPLIST

echo "[2/2] 导出 IPA..."
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
