# iOS APP

Mao iOS 客户端使用 **SwiftUI 原生界面**，Bundle ID `cn.yupengsheng.mao.app`，显示名 `Mao`。核心聊天页面不再加载远程 WKWebView，直接通过原生 URLSession 调用生产 API 与 WebSocket。当前原生版本覆盖登录、Keychain 令牌、历史会话抽屉与折叠、会话切换、消息历史、发送消息和流式回复，统一使用 CLOUD 会话。

## 目录

| 路径 | 用途 |
|------|------|
| `ios/App/App/NativeRootView.swift` | SwiftUI 原生登录、抽屉、聊天与输入界面 |
| `ios/App/App/NativeAPI.swift` | REST API、令牌刷新与 Keychain 存储 |
| `ios/App/App/NativeStore.swift` | 会话状态、WebSocket 流式消息与连接恢复 |
| `ios/App/App.xcodeproj` | 纯原生 Xcode 工程，不依赖 CocoaPods 或 Capacitor |
| `ios/App/App.xcworkspace` | 兼容原有打开路径的 Xcode 工作区，仅包含原生工程 |
| `ios/App/App/` | Swift 源码、Info.plist、LaunchScreen、图标 |
| `ios/build-ipa.sh` | 归档并导出 IPA |

## 前置条件

- iOS 部署目标为 **15.0**
- 完整 **Xcode**（不是 Command Line Tools），并执行：
  ```bash
  sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
  ```
- Apple Developer 账号与 **Team ID**
- 在 Xcode 登录开发者账号，并为 `cn.yupengsheng.mao.app` 创建 App ID

## 构建 IPA

```bash
cd ios
export MAO_IOS_TEAM_ID=你的TeamID
bash build-ipa.sh --version 1.0.20 --export-method app-store
```

可选参数：

- `--version`：市场版本号；缺省从根 `CHANGELOG.md` 首条提取
- `--export-method`：`app-store`（默认）/ `development` / `ad-hoc` / `enterprise`；`app-store-connect` 是 `app-store` 的兼容别名。导出 development、ad-hoc 或 enterprise 时设置对应的 `MAO_IOS_PROVISIONING_PROFILE`。
- `--dry-run`：只检查原生工程，不归档；缺完整 Xcode 时告警并跳过归档，便于在 CI 或纯前端机器上校验工程

脚本产出：

- `ios/build/ipa/Mao.ipa`
- `ios/build/Mao.xcarchive`

可用环境变量：

| 变量 | 说明 |
|------|------|
| `MAO_IOS_TEAM_ID` | Apple Developer Team ID，正式构建必填 |
| `MAO_IOS_BUNDLE_ID` | 覆盖 Bundle ID，默认 `cn.yupengsheng.mao.app` |
| `MAO_IOS_EXPORT_METHOD` | 等价于 `--export-method` |
| `MAO_IOS_PROVISIONING_PROFILE` | 手动描述文件名；不填则自动签名 |

## 分发

上传 TestFlight 前先满足出口合规：工程 `Info.plist` 已声明 `ITSAppUsesNonExemptEncryption = false`（只用系统 HTTPS，属豁免加密），新构建不再出现“缺少出口合规证明”。历史构建可在 App Store Connect → TestFlight → 构建版本 → 管理 里手动选“不包含加密”后保存。

iOS **不能**像 Android APK 一样在 App 内下载后直接安装：

| 方式 | 适用场景 |
|------|----------|
| TestFlight | 内测与灰度，需上传 App Store Connect 审核 |
| App Store | 正式公开分发 |
| Ad Hoc | 小范围内测，设备 UDID 必须写入描述文件 |
| Enterprise | 企业内部分发，需企业开发者账号 |

IPA 必须签名；未签名产物只能用于归档检查，无法安装到真机。

> 当前聊天主链路已是 SwiftUI 原生界面，公开分发仍需按 App Store 的登录、隐私和账号权限要求准备审核材料。

## 原生能力

- **认证**：登录与刷新令牌写入 Keychain，网络请求遇到 401 会自动刷新并重试。
- **聊天流**：原生客户端使用 URLSessionWebSocketTask 连接 `/api/ws/stream`，接收 `content_delta`、`message_end`、`session_status` 与错误事件。
- **会话来源**：服务端当前没有 `ios` 来源值，原生 iOS 创建的 CLOUD 会话暂使用通用 `web` 来源，避免伪装成安卓客户端。
- **历史会话**：原生抽屉按服务端分组展示会话，支持「历史会话」总折叠、会话切换和新建会话。
- **更新**：原生代码变化必须重新签名并走 TestFlight / App Store / Ad Hoc；服务端 API 与聊天协议变化可在下次原生版本中同步。
- **纯原生工程**：启动入口、聊天 UI、REST、WebSocket 和令牌存储均由 Swift/SwiftUI 实现，工程不再编译 Capacitor、Cordova、WKWebView 或旧 Web 资源。

## 排障

| 现象 | 处理 |
|------|------|
| `xcode-select` 指向 CommandLineTools | 切到完整 Xcode 后重试 |
| 签名失败 | 确认 Team ID、App ID、设备已登记；或在 Xcode 打开 `App.xcworkspace`（或 `App.xcodeproj`）手动修复签名 |
| 更新后仍显示旧 WebView 界面 | 删除旧版 Mao 后重新安装原生 IPA，并确认安装的是本次构建产物；原生入口不读取远程网页缓存 |
| 打开后白屏 | 检查 Xcode 控制台是否有原生启动错误，并确认 API 地址可访问；原生入口不依赖 WKWebView 页面 |
