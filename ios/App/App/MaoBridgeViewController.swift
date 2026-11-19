import Capacitor

/// 在 Capacitor 创建桥接后注册自研插件，保持与安卓端一致的 OpenUrl 能力。
final class MaoBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(OpenUrlPlugin())
    }
}
