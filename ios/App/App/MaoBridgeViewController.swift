import Capacitor
import ObjectiveC
import UIKit
import WebKit

/// Capacitor 原生壳（远程加载 mao.yupengsheng.cn），额外注册 OpenUrl 插件。
///
/// 三处原生兜底：
/// 1. iOS 26/27 的 WKWebView 在聚焦输入框、键盘盖住光标时会把整页放大，键盘收起后也不还原；
///    页面侧的 16px 字号、viewport 缩放限制（maximum-scale / user-scalable）都挡不住。
///    这里禁用双指缩放并盯住缩放状态，一旦被放大立刻复位。
/// 2. WebKit 会给网页表单在键盘上方加一行 ‹ › ✓ 的 input accessory bar，聊天输入框自带
///    发送键，这行纯占高度且页面侧（CSS/JS）管不到，只能在原生侧把它的 inputAccessoryView 置空。
/// 3. 键盘避让可能改写 WKWebView 外层 UIScrollView 的 contentOffset，把整页顶栏推出视口；
///    原生壳锁住外层滚动，网页内部滚动容器仍由网页自己管理。
final class MaoBridgeViewController: CAPBridgeViewController {
    private var zoomObservation: NSKeyValueObservation?
    private var outerScrollObservation: NSKeyValueObservation?
    private var keyboardObservers: [NSObjectProtocol] = []
    private var resettingZoom = false
    private var resettingOuterScroll = false
    private var hidFormAccessoryBar = false
    /// 首次启动只弹一次地址输入框（重建控制器后由新实例重新判断）
    private var promptedServerSetup = false
    /// 首屏加载看门狗：地址不可达时 estimatedProgress 永远到不了 1
    private var progressObservation: NSKeyValueObservation?
    private var loadWatchdog: DispatchWorkItem?
    private var loadWatchdogPresented = false
    /// 超过该时间仍未加载完成就提示「重试 / 更换服务器」（自建服务器挂了时不必杀进程）
    private static let loadWatchdogDelay: TimeInterval = 12

    /// 服务器地址由原生侧决定（见 MaoServerAddress）：这个壳远程加载整站，登录页也在远端，
    /// 所以只能在 bridge 创建前把存储的地址塞进 InstanceDescriptor（server.url 的唯一入口）。
    override func instanceDescriptor() -> InstanceDescriptor {
        let descriptor = super.instanceDescriptor()
        descriptor.serverURL = MaoServerAddress.effective
        return descriptor
    }

    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(OpenUrlPlugin())
        bridge?.registerPluginInstance(MaoServerPlugin())
        // CAPBridgeViewController 在这里已经创建 WebView、但尚未开始加载远程入口；
        // 提前锁定缩放，避免首个输入框聚焦发生在 viewDidAppear 监听安装之前。
        lockdownZoom()
        lockdownOuterScroll()
        watchInitialLoad()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        lockdownZoom()
        lockdownOuterScroll()
        hideFormAccessoryBar()
        promptServerSetupIfNeeded()
    }

    /// 首次启动（还没存过地址）先问地址：存下后改用新地址重建整个壳。
    /// 未配置时 WebView 已按默认地址起加载，弹窗盖在上面，用户确认完立刻切过去。
    private func promptServerSetupIfNeeded() {
        guard view.window != nil, MaoServerAddress.saved == nil, !promptedServerSetup else { return }
        promptedServerSetup = true
        MaoServerAddress.present(from: self, firstRun: true) {
            MaoServerAddress.reloadShell()
        }
    }

    /// 首屏加载看门狗：preferred server 不可达时 estimatedProgress 卡在 1 以下，
    /// 页面没有任何东西可点，只能由原生给「重试 / 更换服务器」。
    private func watchInitialLoad() {
        guard let webView = webView, progressObservation == nil else { return }
        progressObservation = webView.observe(\.estimatedProgress, options: [.new]) { [weak self] webView, _ in
            guard let self else { return }
            if webView.estimatedProgress >= 1 {
                // 文档加载完成；是否真正渲染由页面自己负责，这里只管「连不上」
                self.cancelLoadWatchdog()
            } else {
                self.armLoadWatchdog()
            }
        }
        if webView.estimatedProgress < 1 {
            armLoadWatchdog()
        }
    }

    private func armLoadWatchdog() {
        guard loadWatchdog == nil, !loadWatchdogPresented else { return }
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.loadWatchdog = nil
            guard self.view.window != nil else { return }
            guard UIApplication.shared.applicationState == .active else {
                // 后台不弹窗，回前台后重新计时
                DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
                    self?.armLoadWatchdog()
                }
                return
            }
            if self.presentedViewController != nil {
                // 地址输入框等原生弹窗还开着，稍后再判断，别和它抢着 present
                DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
                    self?.armLoadWatchdog()
                }
                return
            }
            self.loadWatchdogPresented = true
            self.presentLoadFailure()
        }
        loadWatchdog = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.loadWatchdogDelay, execute: work)
    }

    private func cancelLoadWatchdog() {
        loadWatchdog?.cancel()
        loadWatchdog = nil
    }

    private func presentLoadFailure() {
        let alert = UIAlertController(
            title: "无法连接服务器",
            message: "加载 \(MaoServerAddress.effective) 失败，可以重试或更换服务器地址。",
            preferredStyle: .alert
        )
        alert.addAction(UIAlertAction(title: "重试", style: .default) { [weak self] _ in
            guard let self else { return }
            self.loadWatchdogPresented = false
            self.webView?.reload()
            self.armLoadWatchdog()
        })
        alert.addAction(UIAlertAction(title: "更换服务器", style: .default) { [weak self] _ in
            guard let self else { return }
            self.loadWatchdogPresented = false
            MaoServerAddress.present(from: self, firstRun: false, onSaved: {
                MaoServerAddress.reloadShell()
            }, onCancel: { [weak self] in
                self?.armLoadWatchdog()
            })
        })
        alert.addAction(UIAlertAction(title: "稍后再说", style: .cancel) { [weak self] _ in
            self?.loadWatchdogPresented = false
        })
        present(alert, animated: true)
    }

    deinit {
        zoomObservation?.invalidate()
        outerScrollObservation?.invalidate()
        progressObservation?.invalidate()
        loadWatchdog?.cancel()
        keyboardObservers.forEach { NotificationCenter.default.removeObserver($0) }
    }

    private func lockdownZoom() {
        guard let webView = webView, zoomObservation == nil else { return }
        let scrollView = webView.scrollView
        scrollView.pinchGestureRecognizer?.isEnabled = false
        scrollView.minimumZoomScale = 1
        scrollView.maximumZoomScale = 1
        scrollView.bouncesZoom = false
        zoomObservation = scrollView.observe(\.zoomScale, options: [.new]) { [weak self] _, _ in
            self?.resetZoom()
        }
        let center = NotificationCenter.default
        for name in [
            UIResponder.keyboardWillChangeFrameNotification,
            UIResponder.keyboardDidShowNotification,
            UIResponder.keyboardDidHideNotification,
        ] {
            keyboardObservers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                self?.resetZoom()
                self?.enforceOuterScrollLock()
            })
        }
    }

    /// 页面根节点已经由 Web 侧锁为固定画布，WKWebView 外层 UIScrollView 也不能参与键盘避让。
    ///
    /// iOS 在输入框聚焦、键盘开始上推动画时，可能先改写这个 scroll view 的 contentOffset，
    /// 把整页（包括顶栏）推出视口；下一帧 WebKit 再按 visualViewport 恢复，于是用户看到一次
    /// 明显的「背景跳一下」。isScrollEnabled=false 阻止系统滚动，KVO 兜底处理已经发生的
    /// 偏移。消息列表等网页内部 overflow 容器仍可独立滚动。
    private func lockdownOuterScroll() {
        guard let webView = webView, outerScrollObservation == nil else { return }
        let scrollView = webView.scrollView
        scrollView.contentInsetAdjustmentBehavior = .never
        scrollView.contentInset = .zero
        scrollView.scrollIndicatorInsets = .zero
        scrollView.bounces = false
        scrollView.alwaysBounceVertical = false
        scrollView.alwaysBounceHorizontal = false
        scrollView.isScrollEnabled = false
        resetOuterScroll(scrollView)
        outerScrollObservation = scrollView.observe(\.contentOffset, options: [.new]) { [weak self] scrollView, _ in
            self?.resetOuterScroll(scrollView)
        }
    }

    private func enforceOuterScrollLock() {
        guard let scrollView = webView?.scrollView else { return }
        if scrollView.isScrollEnabled {
            scrollView.isScrollEnabled = false
        }
        resetOuterScroll(scrollView)
    }

    private func resetOuterScroll(_ scrollView: UIScrollView) {
        guard !resettingOuterScroll else { return }
        let offset = scrollView.contentOffset
        guard abs(offset.x) > 0.5 || abs(offset.y) > 0.5 else { return }
        resettingOuterScroll = true
        scrollView.setContentOffset(.zero, animated: false)
        resettingOuterScroll = false
    }

    private func resetZoom() {
        guard !resettingZoom, let webView = webView else { return }
        resettingZoom = true
        let scrollView = webView.scrollView
        if scrollView.zoomScale != 1 {
            scrollView.setZoomScale(1, animated: false)
        }
        if webView.pageZoom != 1 {
            webView.pageZoom = 1
        }
        // 固定布局的应用界面本身不可滚动，缩放时被 WebKit 平移的视口也一并拉回原点。
        if scrollView.contentSize.height <= scrollView.bounds.height + 1, scrollView.contentOffset != .zero {
            scrollView.setContentOffset(.zero, animated: false)
        }
        resettingZoom = false
    }

    /// 与 @capacitor/keyboard 的 hideFormAccessoryBar 同一套做法：
    /// 把 UIResponder / WKContentView 的 inputAccessoryView 实现改成返回 nil。
    private func hideFormAccessoryBar() {
        guard !hidFormAccessoryBar else { return }
        hidFormAccessoryBar = true
        let selector = NSSelectorFromString("inputAccessoryView")
        let nilAccessory: @convention(block) (AnyObject) -> UIView? = { _ in nil }
        let implementation = imp_implementationWithBlock(nilAccessory)
        if let method = class_getInstanceMethod(UIResponder.self, selector) {
            _ = method_setImplementation(method, implementation)
        }
        let contentViewClass = NSClassFromString("WKContentView")
            ?? webView?.scrollView.subviews
                .first { String(describing: type(of: $0)).hasPrefix("WKContent") }
                .flatMap { object_getClass($0) }
        if let contentViewClass = contentViewClass,
           let method = class_getInstanceMethod(contentViewClass, selector) {
            _ = method_setImplementation(method, implementation)
        }
    }
}
