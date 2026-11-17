import UIKit
import Capacitor

/// 系统浏览器外链插件：与 Android OpenUrlPlugin 保持同名 JS 接口。
/// 仅放行 http / https / mailto，避免远程页面通过自定义 scheme 唤起任意 App。
@objc(OpenUrlPlugin)
public class OpenUrlPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "OpenUrlPlugin"
    public let jsName = "OpenUrl"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "openUrl", returnType: CAPPluginReturnPromise)
    ]

    @objc func openUrl(_ call: CAPPluginCall) {
        guard let raw = call.getString("url"),
              let url = URL(string: raw),
              let scheme = url.scheme?.lowercased(),
              ["http", "https", "mailto"].contains(scheme) else {
            call.reject("仅支持 http / https / mailto 链接")
            return
        }

        DispatchQueue.main.async {
            UIApplication.shared.open(url, options: [:]) { opened in
                if opened {
                    call.resolve()
                } else {
                    call.reject("系统无法打开该链接")
                }
            }
        }
    }
}
