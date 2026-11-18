import UIKit
import SwiftUI

@main
class AppDelegate: UIResponder, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
    ) -> Bool {
        true
    }

    func application(
        _ app: UIApplication,
        open url: URL,
        options: [UIApplication.OpenURLOptionsKey: Any] = [:]
    ) -> Bool {
        NotificationCenter.default.post(name: .maoOpenURL, object: url)
        return true
    }

    func application(
        _ application: UIApplication,
        continue userActivity: NSUserActivity,
        restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void
    ) -> Bool {
        NotificationCenter.default.post(name: .maoContinueUserActivity, object: userActivity)
        restorationHandler(nil)
        return true
    }
}

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(
        _ scene: UIScene,
        willConnectTo session: UISceneSession,
        options connectionOptions: UIScene.ConnectionOptions
    ) {
        guard let windowScene = scene as? UIWindowScene else { return }

        // The iOS app is a native SwiftUI client. Install the hosting controller
        // directly so the app starts in the native login/chat flow.
        let window = UIWindow(windowScene: windowScene)
        window.rootViewController = UIHostingController(rootView: NativeRootView())
        self.window = window
        window.makeKeyAndVisible()

        if let urlContext = connectionOptions.urlContexts.first {
            open(urlContext)
        }
        if let userActivity = connectionOptions.userActivities.first {
            continueActivity(userActivity)
        }
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        guard let urlContext = URLContexts.first else { return }
        open(urlContext)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        continueActivity(userActivity)
    }

    private func open(_ urlContext: UIOpenURLContext) {
        var options: [UIApplication.OpenURLOptionsKey: Any] = [
            .openInPlace: urlContext.options.openInPlace
        ]
        if let annotation = urlContext.options.annotation {
            options[.annotation] = annotation
        }
        if let sourceApplication = urlContext.options.sourceApplication {
            options[.sourceApplication] = sourceApplication
        }

        _ = options
        NotificationCenter.default.post(name: .maoOpenURL, object: urlContext.url)
    }

    private func continueActivity(_ userActivity: NSUserActivity) {
        NotificationCenter.default.post(
            name: .maoContinueUserActivity,
            object: userActivity
        )
    }
}

extension Notification.Name {
    static let maoContinueUserActivity = Notification.Name("mao.continueUserActivity")
    static let maoOpenURL = Notification.Name("mao.openURL")
}
