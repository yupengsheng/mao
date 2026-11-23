# 安卓 APP

基于 **Capacitor 7** WebView 壳，包名 `cn.yupengsheng.mao.app`。**仅 CLOUD 模式**（无 `electronAPI`，自动禁用 LOCAL）。

生产环境**远程加载**与 Web/Electron 相同的桌面 Web URL（你部署的站点，如 `https://mao.example.com`），前端改动**无需打 APK**——部署 Web 后顶栏刷新或等待 `version.json` 提示即可。

## 与桌面 Web 的关系

| 变更类型 | 操作 |
|----------|------|
| 仅 `desktop/` 前端 UI | `deploy-desktop.sh` 或构建 `desktop/dist`，用户刷新 |
| 原生壳（MainActivity、OTA 插件、Capacitor 配置） | 更新发版说明后 `build-apk.sh` |

安卓专用 UI 在 `desktop/` 中用 `android-capacitor` / `Capacitor.isNativePlatform()` 守卫；安卓与 iOS 共享的移动样式用 `native-mobile`。
移动端（安卓 / iOS）历史会话为顶栏汉堡打开的覆盖式抽屉：点击遮罩、关闭按钮或 Esc 收起，选中会话与新建任务后自动关闭。抽屉内的分组、聚焦模式与历史折叠和桌面端同源，仅原生壳样式由 `native-mobile` 统一接管。

## 服务器地址

首次启动弹原生对话框填写服务器地址（仅 `https` 根地址，缺协议自动补、带路径会被拒），确认前请求 `<地址>/api/v1/health` 并校验响应体 `code == 0`（只认真 Mao 后端，静态站点不算），失败原地报错；保存进 SharedPreferences（`mao_server`）后用新地址重建 Activity。登录页底部显示当前地址，并提供「更换服务器」入口；首屏加载超过 8s 时遮罩上除「重新连接」外也给出「更换服务器」，地址填错不必重装 APK。

- `MainActivity` 覆盖 `BridgeActivity.load()`：有地址就用「复制 assets 配置、只替换 `server.url` 的 `CapConfig`」启动 bridge；没有地址先弹框、**不创建 bridge**（不加载任何远端页面）。
- 「更换服务器」走自研 `MaoServer` 插件（`get` / `open`）→ `promptServerChange()` → `recreate()`，重建后 `load()` 自然读到新地址。
- 相关文件：`MaoServerAddress.java`、`MaoServerPlugin.java`、`MainActivity` 的 `load()` / `showServerDialog()`；前端入口 `desktop/src/utils/nativeServer.ts` + `LoginView.vue`。

## 外链打开

App 内点击 http/https/mailto 链接（助手回复、文件预览、下载对话框等）由 `desktop/src/utils/externalLink.ts` 在 document 级统一拦截，经 `openExternalUrl()` 落到原生 `OpenUrl` 插件，用 `ACTION_VIEW` 交给系统浏览器或对应 App。

原因：WebView 未开启多窗口，页面里 `target="_blank"` 的 `window.open` 必然失败，不接管时点击无任何反应。工作区内文件相对链接、锚点跳转不受影响。若设备上没有可处理该链接的应用会给出提示。新增外链协议需同步 `OpenUrlPlugin.openUrl` 的白名单与前端 `EXTERNAL_PROTOCOL_RE`。

## 云端终端（0.0.97 起）

CLOUD 任务可用云端终端（需 `terminal:use` 权限），安卓端额外提供底部虚拟按键条（Esc / Tab / Ctrl 粘滞 / 方向键 / Ctrl+C / Ctrl+D / 粘贴），软键盘弹出时面板自动避让。属纯前端能力，随 Web 部署生效，无需打 APK。LOCAL 任务的本地终端在安卓上仍不可用。详见 [desktop.md](desktop.md#终端)。

## 构建 APK（仅原生壳变更）

环境：JDK 21、Android SDK（`platforms;android-35`、`build-tools;34.0.0`）。

```bash
cd android
export ANDROID_HOME=/opt/android-sdk   # 按本机调整
bash build-apk.sh                      # --dry-run / --version 0.0.x
```

签名：`MAO_KEYSTORE_*` 环境变量或本地 keystore 凭据文件（**勿入 git**）。

默认发布到数据目录 `uploads/releases/`：

- `mao-android-<versionName>-<versionCode>.apk`
- `android-latest.json`（OTA 清单，含原生 changelog）

`versionCode` 脚本按已发布 APK 自增；`versionName` 取自仓库 CHANGELOG 首条版本号。

## 应用内更新

| 类型 | 机制 |
|------|------|
| 页面更新 | 轮询 `version.json`，与 Web/Electron 一致 |
| 原生壳 OTA | `android-latest.json` + `AppUpdate` 插件下载安装 APK |

## 明确不做

LOCAL 能力、工具审批、系统推送、应用商店上架、移动端大改布局、独立后端/admin 功能。

## 部署侧 Nginx

桌面端 `mao.conf` 需反代 `/api/` 与 `/api/ws/`，并可选 `uploads/` 静态别名供 APK 与资源访问。见 [deploy.md](deploy.md)。
