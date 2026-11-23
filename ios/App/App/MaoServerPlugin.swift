import UIKit
import Capacitor

/// 服务器地址插件：与 Android MaoServerPlugin 同名同接口。
/// - get()  返回当前服务器地址与是否已配置
/// - open() 弹出原生地址输入框；保存后壳会用新地址重建 WebView
///
/// 远程页面不知道自己跑在哪台服务器上，登录页展示地址、提供「更换」入口都得问原生。
@objc(MaoServerPlugin)
public class MaoServerPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MaoServerPlugin"
    public let jsName = "MaoServer"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise)
    ]

    @objc func get(_ call: CAPPluginCall) {
        let saved = MaoServerAddress.saved
        call.resolve([
            "url": saved ?? MaoServerAddress.fallback,
            "configured": saved != nil
        ])
    }

    @objc func open(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let presenter = self.bridge?.viewController else {
                call.reject("当前环境不支持修改服务器地址")
                return
            }
            MaoServerAddress.present(from: presenter, firstRun: false, onSaved: {
                call.resolve()
                MaoServerAddress.reloadShell()
            }, onCancel: {
                // 用户取消：必须 resolve，否则前端 Promise 永挂
                call.resolve()
            })
        }
    }
}