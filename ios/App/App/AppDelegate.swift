import UIKit
import Capacitor

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
        ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(
        _ application: UIApplication,
        continue userActivity: NSUserActivity,
        restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void
    ) -> Bool {
        ApplicationDelegateProxy.shared.application(
            application,
            continue: userActivity,
            restorationHandler: restorationHandler
        )
    }
}

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(
        _ scene: UIScene,
        willConnectTo session: UISceneSession,
        options connectionOptions: UIScene.ConnectionOptions
    ) {
        guard scene is UIWindowScene else { return }

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

        _ = ApplicationDelegateProxy.shared.application(
            UIApplication.shared,
            open: urlContext.url,
            options: options
        )
    }

    private func continueActivity(_ userActivity: NSUserActivity) {
        _ = ApplicationDelegateProxy.shared.application(
            UIApplication.shared,
            continue: userActivity,
            restorationHandler: { _ in }
        )
    }
}
