import SwiftUI
import UIKit
import UserNotifications
import WebKit

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
        // Lock-screen approvals: long-press a "needs you" push → Allow / Deny.
        // Both require Face ID first (authenticationRequired) — they run real
        // commands on your machine. The server only sends this category when
        // the request is a plain allow/deny (server/index.js approvalFor).
        let allow = UNNotificationAction(identifier: "ALLOW", title: "Allow", options: [.authenticationRequired])
        let deny = UNNotificationAction(identifier: "DENY", title: "Deny", options: [.authenticationRequired, .destructive])
        // "No — do this instead": the note goes back with the denial.
        let denyNote = UNTextInputNotificationAction(identifier: "DENY_NOTE", title: "Deny with a note…",
                                                     options: [.authenticationRequired],
                                                     textInputButtonTitle: "Send", textInputPlaceholder: "What should it do instead?")
        // Reply to a finished session ("yes, go ahead") without opening the app.
        let reply = UNTextInputNotificationAction(identifier: "REPLY", title: "Reply",
                                                  options: [.authenticationRequired],
                                                  textInputButtonTitle: "Send", textInputPlaceholder: "Reply…")
        center.setNotificationCategories([
            UNNotificationCategory(identifier: "FLEET_APPROVE", actions: [allow, deny, denyNote], intentIdentifiers: [], options: []),
            UNNotificationCategory(identifier: "FLEET_REPLY", actions: [reply], intentIdentifiers: [], options: []),
        ])
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
        let action = response.actionIdentifier
        let typed = (response as? UNTextInputNotificationResponse)?.userText.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let title = response.notification.request.content.title
        // Answered from the lock screen — the app may have been launched in the
        // background just for this, so nothing here assumes a UI.
        var call: (token: String, action: String, text: String)?
        switch action {
        case "ALLOW": if let t = info["approve"] as? String { call = (t, "allow", "") }
        case "DENY": if let t = info["approve"] as? String { call = (t, "deny", "") }
        case "DENY_NOTE": if let t = info["approve"] as? String { call = (t, "deny", typed) }
        case "REPLY": if let t = info["reply"] as? String, !typed.isEmpty { call = (t, "reply", typed) }
        default: break
        }
        if let call {
            Task { @MainActor in
                await Approvals.perform(origin: origin, token: call.token, action: call.action, text: call.text, title: title)
                done()
            }
            return
        }
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

/// Redeem a lock-screen Allow/Deny with the machine that sent it
/// (POST /api/push/action), signed in as that machine's session in this app:
/// the cookie comes from the machine's own WKWebsiteDataStore, so it works
/// even when the app was launched in the background just for this tap.
@MainActor
enum Approvals {
    static func perform(origin: String, token: String, action: String, text: String, title: String) async {
        let result = await send(origin: origin, token: token, action: action, text: text)
        if let failure = result {
            // Never fail silently — the thing still needs you.
            let c = UNMutableNotificationContent()
            c.title = action == "allow" ? "Couldn't allow it" : action == "reply" ? "Couldn't send your reply" : "Couldn't deny it"
            c.body = "\(title): \(failure) Open FleetView to answer."
            c.sound = .default
            c.userInfo = ["origin": origin]
            try? await UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: c, trigger: nil))
        }
    }

    /// nil = done; otherwise a short reason.
    private static func send(origin: String, token: String, action: String, text: String) async -> String? {
        // Machines are saved by MachineStore under "machines.v1"; read them
        // directly — a background launch may have no UI (and no store) at all.
        guard let data = UserDefaults.standard.data(forKey: "machines.v1"),
              let machines = try? JSONDecoder().decode([Machine].self, from: data),
              let m = machines.first(where: { $0.origin.lowercased() == origin.lowercased() }),
              let url = URL(string: m.origin + "/api/push/action") else { return "That machine isn't in the app." }
        let cookies = await WKWebsiteDataStore(forIdentifier: m.id).httpCookieStore.allCookies()
        var req = URLRequest(url: url, timeoutInterval: 20)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        for (k, v) in HTTPCookie.requestHeaderFields(with: cookies.filter { url.host?.hasSuffix($0.domain.trimmingCharacters(in: CharacterSet(charactersIn: "."))) == true }) {
            req.setValue(v, forHTTPHeaderField: k)
        }
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["token": token, "action": action, "text": text])
        do {
            let (body, resp) = try await URLSession.shared.data(for: req)
            let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
            if status == 200 { return nil }
            if status == 401 || status == 302 { return "You're signed out of \(m.name)." }
            let reason = (try? JSONSerialization.jsonObject(with: body) as? [String: Any])?["reason"] as? String
            return reason ?? "\(m.name) said no (HTTP \(status))."
        } catch {
            return "Couldn't reach \(m.name)."
        }
    }
}

