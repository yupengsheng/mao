# iOS APP

基于 **Capacitor 7** 的 WKWebView 壳，Bundle ID `cn.yupengsheng.mao.app`，显示名 `Mao`。**仅 CLOUD 模式**（无 `electronAPI`，自动禁用 LOCAL）。

与安卓一致，App **远程加载**生产 Web（默认 `https://mao.yupengsheng.cn`）。前端 UI 改动只需部署 Web，不需要重新出 IPA；只有原生壳（Swift 插件、Info.plist、图标、`ios/capacitor.config.json`）变化时才重新构建。

## 服务器地址

首次启动会弹原生输入框填写服务器地址（仅 `https` 根地址，缺协议自动补、带路径会被拒），确认前请求 `<地址>/api/v1/health` 并校验响应体 `code == 0`（绕开缓存，只认真 Mao 后端），不通过则原地报错；保存进 UserDefaults 后用新地址**重建整个壳**。登录页底部显示当前地址，并提供「更换服务器」入口；首屏 12s 未加载完成时弹「重试 / 更换服务器」，自建服务器挂掉或无响应时仍能改地址。

- 地址在 bridge 创建前注入：`MaoBridgeViewController.instanceDescriptor()` 覆盖 `serverURL`——这是 `server.url` 的唯一入口，改地址只能换一个控制器。
- 未配置时仍按默认地址 `https://mao.yupengsheng.cn` 起加载，输入框盖在上面；离线可点「使用默认地址」跳过探活。
- 「更换服务器」走自研 `MaoServer` 插件（`get` / `open`），保存后 `MaoServerAddress.reloadShell()` 从 storyboard（标识 `MaoBridge`）重建根控制器。
- 相关文件：`ios/App/App/MaoServerAddress.swift`、`ios/App/App/MaoServerPlugin.swift`；前端入口 `desktop/src/utils/nativeServer.ts` + `LoginView.vue`。

## 目录

| 路径 | 用途 |
|------|------|
| `ios/capacitor.config.json` | App ID、远程 URL、iOS 安全区策略 |
| `ios/App/App.xcworkspace` | Xcode 工作区（先 `pod install`） |
| `ios/App/App/` | Swift 源码、Info.plist、Storyboard、图标 |
| `ios/web-stub/` | 远程站点不可达时的占位页，同时满足 Capacitor `webDir` |
| `ios/build-ipa.sh` | 归档并导出 IPA |

## 前置条件

- iOS 部署目标为 **15.0**（Xcode 26 起不再支持 14.0，Podfile 与工程已统一）
- 完整 **Xcode**（不是 Command Line Tools），并执行：
  ```bash
  sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
  ```
- **CocoaPods**：`sudo gem install cocoapods`
- **Node.js / npm**
- Apple Developer 账号与 **Team ID**
- 在 Xcode 登录开发者账号，并为 `cn.yupengsheng.mao.app` 创建 App ID

## 构建 IPA

```bash
cd ios
export MAO_IOS_TEAM_ID=你的TeamID
bash build-ipa.sh --version 1.0.18 --export-method development
```

可选参数：

- `--version`：市场版本号；缺省从根 `CHANGELOG.md` 首条提取
- `--export-method`：`development`（默认）/ `ad-hoc` / `app-store` / `enterprise`
- `--dry-run`：只安装依赖、执行 `cap copy` 并检查配置，不归档；缺完整 Xcode / CocoaPods 时告警并跳过对应步骤，便于在 CI 或纯前端机器上校验工程

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

> App Store 审核对「纯远程 WebView 壳」较严格（常见 4.2 最低功能、2.5.2 远程代码风险）。团队内部分发优先 TestFlight / Ad Hoc / Enterprise；若要公开上架，需要补充原生能力或走审核沟通。

## 原生能力

- **外链**：`ios/App/App/OpenUrlPlugin.swift` 提供与安卓同名的 `OpenUrl` 插件，仅放行 `http` / `https` / `mailto`，由系统浏览器打开。
- **相册**：`Info.plist` 已声明 `NSPhotoLibraryUsageDescription`，用于选择并上传图片或文件。
- **安全区**：`ios.contentInset` 为 `never`，由 CSS 显式避让状态栏与 Home Indicator；顶部导航高度会自动加上 `safe-area-inset-top`。
- **缩放锁定**：iOS 26/27 的 WKWebView 聚焦输入框时会放大整页且不还原；页面侧将可编辑控件统一为 16px、关闭 `-webkit-text-size-adjust`，并在入口脚本与 `main.ts` 双阶段锁定 `minimum-scale=1` / `maximum-scale=1`。`MaoBridgeViewController` 在远程页面加载前禁用双指缩放并监听 `scrollView.zoomScale` / `pageZoom`，一旦被放大立即复位。原生侧改动需重新打包 IPA。
- **键盘表单工具行**：WebKit 会在键盘上方加一行 `‹ › ✓` 的 `inputAccessoryView`，页面侧（CSS / JS / `inputmode`）无法隐藏；`MaoBridgeViewController` 沿用 `@capacitor/keyboard` 的 `hideFormAccessoryBar` 做法，把 `UIResponder` / `WKContentView` 的 `inputAccessoryView` 实现改成返回 `nil`。属原生壳改动，需重新打包 IPA。
- **更新**：页面资源随 Web 部署更新；**没有 APK 式 OTA**。原生壳更新必须重新签名并走 TestFlight / App Store / Ad Hoc。
- **对话引用**：iOS 保留聊天文本选区、文件查看器行区间和 Diff 行区间引用能力；Android 因系统交互限制继续禁用这些引用入口。引用内容仍通过 Web 前端发送，不涉及原生壳 OTA。

## 移动端交互

安卓与 iOS 共用同一套 Web 前端：

- 窄屏顶栏左侧为汉堡按钮，打开覆盖式历史会话抽屉。
- 抽屉支持遮罩点击、关闭按钮、Esc 收起；选中会话和新建任务后自动关闭。
- 抽屉内保留分组、聚焦模式与「历史」折叠区。
- iOS WebView 偶尔会报告桌面级 CSS 宽度；前端同时按原生移动 UA / `native-mobile` 标记识别，仍会进入移动抽屉布局。
- 原生壳共享样式由 `native-mobile` 标记，iOS 专属安全区由 `ios-capacitor` 标记。
- 原生壳顶栏入口多时整条工具栏可横向滑动（隐藏滚动条），不会再把右侧按钮挤出屏幕。
- 触屏不启用分组拖拽排序（HTML5 `draggable` 会让 iOS 第一次点击被拖拽吞掉，抽屉里的历史会话需要点两次），行内重命名/删除按钮隐藏时不接收点击。
- 会话行激活走 `composables/useTouchTap`：触屏在 `touchend` 判定轻点（位移 ≤ 10px、非行内按钮）后立即激活，随后 iOS 补发的合成 `click` 按 300ms 去重；桌面鼠标仍只走 `click`。抽屉滑入后的新合成层上合成 `click` 偶发不派发，只监听 `click` 就会「点两次才进会话」。新增会话点击交互时同样接这套 handler。

## 排障

| 现象 | 处理 |
|------|------|
| `xcode-select` 指向 CommandLineTools | 切到完整 Xcode 后重试 |
| `pod: command not found` | 安装 CocoaPods |
| 签名失败 | 确认 Team ID、App ID、设备已登记；或在 Xcode 打开 `App.xcworkspace` 手动修复签名 |
| 更新后仍显示旧三栏布局 | 从后台彻底结束 Mao 后重开；仍未更新时删除 App 并重新安装，远程入口文档需由 Nginx 返回 `Cache-Control: no-cache` |
| 点开输入框后背景继续抖动 | 页面侧将 `html/body/#app` 锁定为固定不可滚动画布，消息列表关闭 WebKit 滚动锚定；`.layout` 高度持续跟随 `visualViewport`，只响应 `resize`，忽略 WebKit 为光标避让触发的临时 `scroll`，且不叠加 CSS 过渡；原生壳另外锁住 `WKWebView` 外层 `UIScrollView` 的 `contentOffset`，防止系统键盘避让把顶栏推出视口。需重新构建包含原生修复的 IPA；网页内部消息列表仍可滚动 |
| 打开后白屏 | 检查 `https://mao.yupengsheng.cn` 是否可访问、证书是否有效；远程站点需允许 WKWebView 加载 |
| 点开输入框后整页变宽变高或背景跳动 | iOS 缩放与根滚动问题由多层防护处理：`style.css` 在 `html.ios-capacitor` 下把输入框、文本域、`[contenteditable]` 统一为 16px、关闭自动字号调整，并将 `html/body/#app` 锁为固定不可滚动画布；`index.html` 与 `main.ts` 双阶段锁定 viewport（`minimum-scale=1, maximum-scale=1, user-scalable=no`）；`utils/ios-keyboard-viewport.ts` 在键盘弹出时把 `.layout` 夹到 `visualViewport` 上方；`MaoBridgeViewController` 在远程页面加载前锁住 WebView 外层滚动、监听 `contentOffset`，并安装缩放监听把 `zoomScale`/`pageZoom` 复位。聊天中心态保持原有居中排列，程序化聚焦关闭额外滚动，避免键盘避让与输入框滚动叠加。页面改动随 Web 部署生效，原生侧改动需重新打包 IPA；仍复现时确认 iOS 加载到最新 `desktop/dist` 与包含本修复的最新 IPA。 |
| 键盘上方多出 `‹ › ✓` 一行 | 这是 WebKit 的 `inputAccessoryView`，CSS / JS / `inputmode` 都去不掉；`MaoBridgeViewController` 已在原生侧把 `UIResponder` / `WKContentView` 的 `inputAccessoryView` 置空（同 `@capacitor/keyboard` 的 `hideFormAccessoryBar`），需重新打包 IPA |
| 外链点击无反应 | 检查链接协议是否在 `OpenUrlPlugin` 白名单内 |
