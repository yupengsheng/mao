import Capacitor
import UIKit
import WebKit

/// Capacitor 原生壳（远程加载 mao.yupengsheng.cn），额外注册 OpenUrl 插件。
///
/// iOS 26/27 的 WKWebView 在聚焦输入框、键盘盖住光标时会把整页放大，键盘收起后也不还原；
/// 页面侧的 16px 字号、viewport 缩放限制（maximum-scale / user-scalable）都挡不住。
/// 这里在原生壳兜底：禁用双指缩放，盯住 WebView 的缩放状态，一旦被放大立刻复位，
/// 非滚动页面顺带把被平移的视口拉回原点。
final class MaoBridgeViewController: CAPBridgeViewController {
    private var zoomObservation: NSKeyValueObservation?
    private var keyboardObservers: [NSObjectProtocol] = []
    private var resettingZoom = false

    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(OpenUrlPlugin())
        // CAPBridgeViewController 在这里已经创建 WebView、但尚未开始加载远程入口；
        // 提前锁定缩放，避免首个输入框聚焦发生在 viewDidAppear 监听安装之前。
        lockdownZoom()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        lockdownZoom()
    }

    deinit {
        zoomObservation?.invalidate()
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
        for name in [UIResponder.keyboardDidShowNotification, UIResponder.keyboardDidHideNotification] {
            keyboardObservers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                self?.resetZoom()
            })
        }
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
}
