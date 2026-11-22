import SwiftUI
import UIKit
import UserNotifications

/// Native notifications. The device token is handed to every machine from
/// inside its own page (MachineWeb.registerPush); each machine's server sends
/// "needs you" / "finished" through APNs (server/apns.js) with `origin` + `pane`
/// in the payload, so a tap opens the right machine and the right session.
@MainActor
final class PushCenter: NSObject, ObservableObject {
    static let shared = PushCenter()

    @Published private(set) var token: String?
    @Published private(set) var authorized: Bool?
    /// Set by a tapped notification; RootView consumes it.
    @Published var pendingOpen: (origin: String, pane: String)?
    /// What's on screen right now — a banner for it would just repeat the page.
    var visibleOrigin: String?

    func start() {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
            Task { @MainActor in
                self.authorized = granted
                if granted { UIApplication.shared.registerForRemoteNotifications() }
            }
        }
    }

    func didRegister(_ deviceToken: Data) {
        token = deviceToken.map { String(format: "%02x", $0) }.joined()
    }

    func clearBadge() {
        UNUserNotificationCenter.current().setBadgeCount(0)
    }
}

extension PushCenter: UNUserNotificationCenterDelegate {
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                            withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
        let origin = notification.request.content.userInfo["origin"] as? String
        Task { @MainActor in
            // The open machine already shows it (glow, chip, sound) — don't double up.
            if let origin, origin == self.visibleOrigin, UIApplication.shared.applicationState == .active {
                done([])
            } else {
                done([.banner, .list, .sound])
            }
        }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                            withCompletionHandler done: @escaping () -> Void) {
        let info = response.notification.request.content.userInfo
        let origin = info["origin"] as? String ?? ""
        let pane = info["pane"] as? String ?? ""
        Task { @MainActor in
            if !origin.isEmpty { self.pendingOpen = (origin, pane) }
            done()
        }
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        MainActor.assumeIsolated { PushCenter.shared.start() }
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        MainActor.assumeIsolated { PushCenter.shared.didRegister(deviceToken) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        print("[FleetView] push registration failed: \(error.localizedDescription)")
    }
}
