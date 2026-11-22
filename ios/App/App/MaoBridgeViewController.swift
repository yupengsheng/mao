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

    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(OpenUrlPlugin())
        // CAPBridgeViewController 在这里已经创建 WebView、但尚未开始加载远程入口；
        // 提前锁定缩放，避免首个输入框聚焦发生在 viewDidAppear 监听安装之前。
        lockdownZoom()
        lockdownOuterScroll()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        lockdownZoom()
        lockdownOuterScroll()
        hideFormAccessoryBar()
    }

    deinit {
        zoomObservation?.invalidate()
        outerScrollObservation?.invalidate()
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
