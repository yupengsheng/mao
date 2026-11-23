import Capacitor
import Foundation
import UIKit

/// 服务器地址：存储、规范化、探活，以及改地址后重建整个壳。
///
/// 这个壳是远程加载的 WebView（登录页也由远端提供），地址只能在原生侧、WebView 加载前确定。
/// 默认仍是 https://mao.yupengsheng.cn；用户可改成自建实例，保存在 UserDefaults。
/// 只接受 https 根地址（不带路径）；进入前探一次 /api/v1/health，地址写错当场报错而不是白屏。
enum MaoServerAddress {
    /// 未配置时使用的默认服务器
    static let fallback = "https://mao.yupengsheng.cn"
    private static let storageKey = "maoServerUrl"
    private static let hint = "Mao 服务器地址，仅支持 https，只填根地址（不要带路径）。"

    /// 已保存的地址；首次启动未配置返回 nil
    static var saved: String? {
        guard let value = UserDefaults.standard.string(forKey: storageKey), !value.isEmpty else { return nil }
        return value
    }

    /// WebView 实际加载的地址：未配置先用默认值，等用户在弹窗里确认后重建
    static var effective: String { saved ?? fallback }

    static func save(_ url: String) {
        UserDefaults.standard.set(url, forKey: storageKey)
    }

    /// 规范化输入：缺协议补 https，去尾斜杠与查询串；非 https、无主机、带账号信息、带路径判非法。
    ///
    /// 只接受 origin：Capacitor 把 server.url 同时当作 appUrl 与允许来源，带路径时路由和
    /// /api 前缀都会跟着变形，不如要求用户填根地址。
    static func normalize(_ raw: String) -> String? {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { return nil }
        if !text.contains("://") { text = "https://" + text }
        guard var components = URLComponents(string: text),
              components.scheme?.lowercased() == "https",
              let host = components.host, !host.isEmpty,
              components.user == nil, components.password == nil else { return nil }
        components.scheme = "https"
        components.host = host.lowercased()
        components.query = nil
        components.fragment = nil
        var path = components.path
        while path.hasSuffix("/") { path.removeLast() }
        guard path.isEmpty else { return nil }
        components.path = ""
        guard let url = components.url else { return nil }
        return url.absoluteString
    }

    /// 请求 <url>/api/v1/health，2xx 且响应体 code=0 才算可用（后端返回 Result{code:0,...}）。
    /// 健康检查必须绕开缓存：换地址后旧响应不能冒充新服务器。回调在主线程。
    static func validate(_ url: String, completion: @escaping (Bool) -> Void) {
        guard let health = URL(string: url + "/api/v1/health") else {
            completion(false)
            return
        }
        var request = URLRequest(
            url: health,
            cachePolicy: .reloadIgnoringLocalCacheData,
            timeoutInterval: 5
        )
        request.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        URLSession.shared.dataTask(with: request) { data, response, _ in
            var ok = false
            if let http = response as? HTTPURLResponse,
               (200..<300).contains(http.statusCode),
               let data,
               let object = try? JSONSerialization.jsonObject(with: data),
               let json = object as? [String: Any] {
                ok = (json["code"] as? Int) == 0
            }
            DispatchQueue.main.async { completion(ok) }
        }.resume()
    }

    /// 原生地址弹窗。校验失败时重开一个带错误说明的框（UIAlertController 点一下就消失）。
    /// 取消时回调 onCancel，插件据此 resolve 掉前端 Promise，避免它永挂。
    static func present(
        from presenter: UIViewController,
        firstRun: Bool,
        onSaved: @escaping () -> Void,
        onCancel: (() -> Void)? = nil
    ) {
        showInput(
            from: presenter,
            firstRun: firstRun,
            initial: saved ?? fallback,
            message: hint,
            onSaved: onSaved,
            onCancel: onCancel
        )
    }

    private static func showInput(
        from presenter: UIViewController,
        firstRun: Bool,
        initial: String,
        message: String,
        onSaved: @escaping () -> Void,
        onCancel: (() -> Void)?
    ) {
        let alert = UIAlertController(title: firstRun ? "连接服务器" : "更换服务器", message: message, preferredStyle: .alert)
        alert.addTextField { field in
            field.text = initial
            field.placeholder = fallback
            field.keyboardType = .URL
            field.autocapitalizationType = .none
            field.autocorrectionType = .no
            field.clearButtonMode = .whileEditing
        }
        alert.addAction(UIAlertAction(title: "连接", style: .default) { [weak alert, weak presenter] _ in
            guard let alert, let presenter else { return }
            let raw = alert.textFields?.first?.text ?? ""
            guard let normalized = normalize(raw) else {
                reopen(presenter, firstRun: firstRun, initial: raw,
                       message: "地址无效，请填 https:// 开头的服务器根地址（不要带路径）",
                       onSaved: onSaved, onCancel: onCancel)
                return
            }
            validate(normalized) { ok in
                guard ok else {
                    reopen(presenter, firstRun: firstRun, initial: raw,
                           message: "无法连接该地址，请检查网络或地址是否正确",
                           onSaved: onSaved, onCancel: onCancel)
                    return
                }
                save(normalized)
                onSaved()
            }
        })
        if firstRun {
            // 离线也要能用默认服务器，这里不探活
            alert.addAction(UIAlertAction(title: "使用默认地址", style: .default) { _ in
                save(fallback)
                onSaved()
            })
        } else {
            alert.addAction(UIAlertAction(title: "取消", style: .cancel) { _ in
                onCancel?()
            })
        }
        presentAlert(alert, from: presenter)
    }

    /// 上一个弹窗还在消失动画里，直接 present 会被系统丢掉，稍等一拍再弹。
    private static func reopen(
        _ presenter: UIViewController,
        firstRun: Bool,
        initial: String,
        message: String,
        onSaved: @escaping () -> Void,
        onCancel: (() -> Void)?
    ) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
            showInput(from: presenter, firstRun: firstRun, initial: initial, message: message,
                      onSaved: onSaved, onCancel: onCancel)
        }
    }

    /// presenter 上已有其它弹窗（如校验失败后的重开）时先把它关掉，否则 present 会被系统忽略。
    private static func presentAlert(_ alert: UIAlertController, from presenter: UIViewController) {
        if let presented = presenter.presentedViewController {
            presented.dismiss(animated: false) {
                presenter.present(alert, animated: true)
            }
            return
        }
        presenter.present(alert, animated: true)
    }

    /// 地址变了就得重建整个壳：serverURL 在 bridge 创建时定死，改配置只能换一个控制器。
    /// 调用点都在弹窗按钮回调里，弹窗还在消失动画中，稍等一拍再换根控制器。
    static func reloadShell() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
            let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            // 有多个 scene 时挑前台活跃的，别往后台窗口上换根控制器
            let scene = scenes.first { $0.activationState == .foregroundActive } ?? scenes.first
            guard let scene else {
                CAPLog.print("MaoServerAddress: 没有可用 window scene，无法重建壳")
                return
            }
            guard let window = scene.windows.first(where: { $0.isKeyWindow }) ?? scene.windows.first else {
                CAPLog.print("MaoServerAddress: 没有可用 window，无法重建壳")
                return
            }
            let storyboard = UIStoryboard(name: "Main", bundle: nil)
            guard let fresh = storyboard.instantiateViewController(withIdentifier: "MaoBridge") as? MaoBridgeViewController else {
                CAPLog.print("MaoServerAddress: storyboard 缺少 MaoBridge 标识，无法重建壳")
                return
            }
            // 先收掉仍展示的地址弹窗，避免它挂在即将释放的旧根控制器上
            window.rootViewController?.presentedViewController?.dismiss(animated: false)
            UIView.transition(with: window, duration: 0.25, options: .transitionCrossDissolve) {
                window.rootViewController = fresh
            }
        }
    }
}