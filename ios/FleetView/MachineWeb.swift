import AuthenticationServices
import SafariServices
import SwiftUI
import UIKit
import WebKit

/// One machine's FleetView page: a WKWebView with that machine's OWN cookie
/// store, so two machines' passkey sessions never mix. Kept alive while you
/// switch between machines, so coming back is instant and its sockets stay up.
///
/// Sign-in: passkeys can't run inside a WKWebView for a tailnet host (Apple
/// has to verify an associated domain over the public internet), so when the
/// page lands on the gate's sign-in we open it in ASWebAuthenticationSession —
/// a Safari sheet where passkeys work — and the gate hands back a one-time
/// code (fleetview://auth?code=…) that we trade for our own cookie at
/// /gate/app-token. See server/gate.js "Native app sign-in handoff".
@MainActor
final class MachineWeb: NSObject, ObservableObject {
    let machine: Machine
    let webView: WKWebView
    /// Set when the page can't be reached / signed in; drives the error overlay.
    @Published var problem: String?
    @Published var signingIn = false
    /// The page finished loading AND is FleetView itself (not the gate) — safe
    /// to talk to: register for push, open panes.
    private(set) var ready = false
    /// Prompts on this machine waiting for a reply (app-bridge.ts reportWaiting).
    @Published private(set) var waiting = 0
    /// The machine can't be reached (Reach.probe failed): show the offline
    /// screen instead of a blank page that hangs. WebPool re-checks it.
    @Published private(set) var offline = false
    /// Why the last check failed ("no answer within 10 seconds"…), for the offline screen.
    @Published private(set) var offlineReason: String?
    /// Parked on about:blank while offline in the background, so its page
    /// isn't left retrying every pane's socket against a dead host.
    private(set) var suspended = false
    /// Bumped by every load/suspend: an older load's probe or watchdog that
    /// finishes late must not act on a newer state.
    private var loadToken = 0
    /// Told when a load finds the machine up/down (WebPool keeps the set).
    var onReach: ((Bool) -> Void)?
    /// Is another machine offline? (dims its quick-switch button)
    var isOffline: ((UUID) -> Bool)?

    var onRequestSwitcher: (() -> Void)?
    /// Quick switch (the machine buttons in the page's top bar).
    var onSwitch: ((UUID) -> Void)?
    var machineList: (() -> [Machine])?
    private var authSession: ASWebAuthenticationSession?

    init(machine: Machine) {
        self.machine = machine
        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = WKWebsiteDataStore(forIdentifier: machine.id)
        cfg.applicationNameForUserAgent = "FleetViewApp/1"
        cfg.allowsInlineMediaPlayback = true
        cfg.mediaTypesRequiringUserActionForPlayback = []
        let content = WKUserContentController()
        cfg.userContentController = content
        webView = WKWebView(frame: .zero, configuration: cfg)
        super.init()
        content.add(WeakHandler(self), name: "fleetApp")
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.isOpaque = false
        let bg = UIColor(red: 0x0d / 255, green: 0x11 / 255, blue: 0x17 / 255, alpha: 1)
        webView.backgroundColor = bg
        webView.underPageBackgroundColor = bg
        webView.scrollView.backgroundColor = bg
        // The page lays itself out with viewport-fit=cover + safe-area insets.
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.allowsBackForwardNavigationGestures = false
        #if DEBUG
        webView.isInspectable = true
        #endif
        load()
    }

    /// Check the machine is reachable FIRST (5s), then load. Offline → the
    /// offline screen at once, never a blank page hanging for a minute.
    func load(fragment: String? = nil) {
        problem = nil
        ready = false
        suspended = false
        loadToken += 1
        let token = loadToken
        Task { @MainActor in
            let reason = await Reach.check(machine.base)
            guard token == loadToken else { return }
            let up = reason == nil
            onReach?(up)
            offline = !up
            offlineReason = reason
            // Load the page EITHER way: a failed check isn't final (a phone's
            // tunnel waking up can outlast it). If FleetView loads, its
            // "ready" clears the offline screen; if the machine really is
            // away, this just waits quietly behind it.
            var c = URLComponents(url: machine.base, resolvingAgainstBaseURL: false)!
            c.path = "/"
            c.fragment = fragment
            webView.load(URLRequest(url: c.url!))
            guard up else { return }
            // Reachable a moment ago but the page still hasn't arrived: say so
            // (with ways out) rather than leave a blank screen.
            try? await Task.sleep(for: .seconds(15))
            guard token == loadToken, webView.isLoading, !signingIn, problem == nil else { return }
            webView.stopLoading()
            problem = "\(machine.name) is taking too long to answer."
        }
    }

    func reload() {
        if webView.url == nil || problem != nil || offline || suspended { load() } else { webView.reload() }
    }

    /// Back from the background. A short absence: the page rebuilds its own
    /// sockets (main.ts fleetResume — dead ones look open after iOS froze the
    /// app). A long one, or a page that can't answer because iOS discarded
    /// its process: load it fresh.
    func resume(after away: TimeInterval) {
        guard !suspended, !offline, !signingIn else { return }
        if away > 10 * 60 {
            load()
            return
        }
        // Still loading (or showing its can't-reach overlay): leave it be.
        guard ready else { return }
        webView.evaluateJavaScript("window.fleetResume ? (window.fleetResume(), true) : false") { [weak self] result, error in
            Task { @MainActor in
                guard let self else { return }
                if error != nil { self.load() } // the page is gone
                else if (result as? Bool) != true { self.webView.reload() } // an old page without fleetResume
            }
        }
    }

    /// The machine went offline while you're looking at another one: stop its
    /// page (and every socket in it retrying) until it's back.
    func suspend() {
        guard !suspended else { return }
        loadToken += 1
        suspended = true
        offline = true
        ready = false
        webView.stopLoading()
        webView.load(URLRequest(url: URL(string: "about:blank")!))
    }

    /// WebPool saw it come back: load it again (no-op if already fine).
    func cameBack() {
        guard offline || suspended else { return }
        load()
    }

    /// Open a pane: in the live page if it's up, else via the #pane= deep link.
    func openPane(_ id: String) {
        let safe = id.filter { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }
        guard !safe.isEmpty else { return }
        if ready && !suspended {
            webView.evaluateJavaScript("window.fleetOpenPane ? window.fleetOpenPane('\(safe)') : false") { [weak self] result, _ in
                if (result as? Bool) != true { self?.load(fragment: "pane=\(safe)") }
            }
        } else {
            load(fragment: "pane=\(safe)")
        }
    }

    /// Give the page the machine list for its quick-switch buttons
    /// (app-bridge.ts fleetSetMachines). This page's own machine is "current".
    func sendMachines() {
        guard ready, let list = machineList?() else { return }
        // Icons go in as data: URLs fetched by the app, so this page never has
        // to load another machine's image (which failed on a real phone: one
        // machine's tile showed as a bare letter inside the other's page).
        // Not fetched yet → the URL now, and a re-send once it arrives.
        let items: [[String: Any]] = list.map {
            // `icon` stays the plain https URL — pages from before iconData only
            // accept that, and a machine may not have updated yet (sending a
            // data: URL there turned every tile into a letter). Newer pages
            // prefer `iconData`.
            ["id": $0.id.uuidString, "name": $0.name,
             "icon": $0.icon?.absoluteString ?? NSNull(),
             "iconData": IconCache.shared.dataURL(for: $0.icon) ?? NSNull(),
             "current": $0.id == machine.id,
             "offline": $0.id != machine.id && (isOffline?($0.id) ?? false)]
        }
        for m in list where IconCache.shared.dataURL(for: m.icon) == nil {
            IconCache.shared.fetch(m.icon) { [weak self] in self?.sendMachines() }
        }
        guard let json = try? JSONSerialization.data(withJSONObject: items),
              let str = String(data: json, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.fleetSetMachines && window.fleetSetMachines(\(str))")
    }

    /// Tell this machine where to send notifications. Runs INSIDE the page, so
    /// it carries the gate cookie and passes the server's same-origin check.
    func registerPush(token: String) {
        guard ready else { return }
        let body: [String: String] = ["token": token, "origin": machine.origin, "name": UIDevice.current.name]
        guard let json = try? JSONSerialization.data(withJSONObject: body),
              let str = String(data: json, encoding: .utf8) else { return }
        webView.evaluateJavaScript(
            "fetch('/api/push/apns',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(\(str))}).catch(function(){})"
        )
    }

    // MARK: Sign-in

    private func startSignIn() {
        guard authSession == nil, !signingIn else { return }
        signingIn = true
        // A gate from before the app existed has no /gate/app-login: the sheet
        // would sign you in and then show FleetView INSIDE itself, never handing
        // back. Ask first (gate.js /gate/status reports appLogin) and say what
        // to do instead.
        Task { @MainActor in
            var ok = true
            if let (data, resp) = try? await URLSession.shared.data(from: machine.base.appendingPathComponent("gate/status")),
               (resp as? HTTPURLResponse)?.statusCode == 200,
               let status = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                ok = status["appLogin"] as? Bool == true
            }
            if ok {
                openSignInSheet()
            } else {
                signingIn = false
                problem = "\(machine.name)'s sign-in gate is out of date. On that machine: git pull, then restart its gate service — then Try again."
            }
        }
    }

    private func openSignInSheet() {
        let start = machine.base.appendingPathComponent("gate/app-login")
        let session = ASWebAuthenticationSession(url: start, callbackURLScheme: "fleetview") { [weak self] url, error in
            Task { @MainActor in
                guard let self else { return }
                self.authSession = nil
                self.signingIn = false
                if let url, let code = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                    .queryItems?.first(where: { $0.name == "code" })?.value {
                    var c = URLComponents(url: self.machine.base.appendingPathComponent("gate/app-token"), resolvingAgainstBaseURL: false)!
                    c.queryItems = [URLQueryItem(name: "code", value: code)]
                    self.webView.load(URLRequest(url: c.url!))
                } else if let e = error as? ASWebAuthenticationSessionError, e.code == .canceledLogin {
                    self.problem = "Sign in to \(self.machine.name) to continue."
                } else {
                    self.problem = "Couldn't sign in to \(self.machine.name)."
                }
            }
        }
        // Not ephemeral: Safari keeps the passkey session (24h), so the next
        // sign-in — another machine-day, or after reinstalling — is one tap.
        session.prefersEphemeralWebBrowserSession = false
        session.presentationContextProvider = self
        authSession = session
        if !session.start() {
            authSession = nil
            signingIn = false
            problem = "Couldn't open the sign-in sheet."
        }
    }
}

extension MachineWeb: WKNavigationDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { return decisionHandler(.cancel) }
        let scheme = url.scheme?.lowercased() ?? ""
        if ["about", "blob", "data"].contains(scheme) { return decisionHandler(.allow) }
        let sameSite = url.host?.lowercased() == machine.base.host?.lowercased() && url.port == machine.base.port
        if sameSite {
            if url.path.hasPrefix("/gate/login") && action.targetFrame?.isMainFrame != false {
                decisionHandler(.cancel)
                startSignIn()
                return
            }
            return decisionHandler(.allow)
        }
        // Anything else (a link in an agent's reply) belongs in a real browser.
        if action.targetFrame?.isMainFrame != false, scheme == "http" || scheme == "https" || scheme == "mailto" || scheme == "tel" {
            UIApplication.shared.open(url)
            return decisionHandler(.cancel)
        }
        decisionHandler(.allow) // subframes, e.g. embedded media
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // Only FleetView itself counts — the gate's own pages are not "ready".
        if let path = webView.url?.path, !path.hasPrefix("/gate") { problem = nil }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        fail(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        fail(error)
    }

    private func fail(_ error: Error) {
        let e = error as NSError
        if e.code == NSURLErrorCancelled || e.code == 102 /* frame load interrupted (our own cancel) */ { return }
        ready = false
        problem = "Can't reach \(machine.name). Is Tailscale connected on this phone?"
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        // iOS reclaimed the page's memory while in the background — bring it back.
        load()
    }
}

extension MachineWeb: WKUIDelegate {
    /// target=_blank / window.open: a new window means "elsewhere" — Safari.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { UIApplication.shared.open(url) }
        return nil
    }

    // alert()/confirm()/prompt() — FleetView uses confirm() for destructive actions.
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        present(message, actions: [("OK", .default, { completionHandler() })], onCancel: completionHandler)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        present(message, actions: [("Cancel", .cancel, { completionHandler(false) }), ("OK", .default, { completionHandler(true) })],
                onCancel: { completionHandler(false) })
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let a = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
        a.addTextField { $0.text = defaultText }
        a.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(nil) })
        a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(a.textFields?.first?.text) })
        guard let top = Self.topController() else { return completionHandler(nil) }
        top.present(a, animated: true)
    }

    private func present(_ message: String, actions: [(String, UIAlertAction.Style, () -> Void)], onCancel: @escaping () -> Void) {
        let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        for (title, style, run) in actions { a.addAction(UIAlertAction(title: title, style: style) { _ in run() }) }
        guard let top = Self.topController() else { return onCancel() }
        top.present(a, animated: true)
    }

    static func topController() -> UIViewController? {
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first { $0.activationState == .foregroundActive }
            ?? UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        var top = scene?.windows.first(where: \.isKeyWindow)?.rootViewController
        while let p = top?.presentedViewController { top = p }
        return top
    }
}

extension MachineWeb: WKScriptMessageHandler {
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let t = body["t"] as? String else { return }
        switch t {
        case "ready": // app-bridge.ts: FleetView itself is up and signed in
            ready = true
            problem = nil
            // A working page outranks any failed reachability check.
            if offline { offline = false; offlineReason = nil }
            onReach?(true)
            if let token = PushCenter.shared.token { registerPush(token: token) }
            sendMachines()
            // Tell the page what this build can do (older builds never say, and
            // the page falls back to window.open → Safari).
            webView.evaluateJavaScript("window.fleetAppCaps = { browser: true, reload: true }", completionHandler: nil)
        case "waiting":
            waiting = max(0, (body["n"] as? Int) ?? 0)
            PushCenter.shared.refreshBadge()
        case "machines":
            onRequestSwitcher?()
        case "switch":
            if let s = body["id"] as? String, let id = UUID(uuidString: s) { onSwitch?(id) }
        case "reload": // main.ts: the page didn't come back after a pause
            let pane = (body["pane"] as? String ?? "").filter { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }
            load(fragment: pane.isEmpty ? nil : "pane=\(pane)")
        case "open": // Live preview (client/src/previews.ts): an in-app browser sheet
            if let s = body["url"] as? String, let url = URL(string: s),
               url.scheme == "https" || url.scheme == "http", let top = Self.topController() {
                let vc = SFSafariViewController(url: url)
                vc.preferredControlTintColor = .white
                vc.preferredBarTintColor = UIColor(red: 0x0d / 255, green: 0x11 / 255, blue: 0x17 / 255, alpha: 1)
                vc.dismissButtonStyle = .close
                top.present(vc, animated: true)
            }
        default:
            break
        }
    }
}

extension MachineWeb: ASWebAuthenticationPresentationContextProviding {
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        Self.topController()?.view.window ?? ASPresentationAnchor()
    }
}

/// WKUserContentController retains its handlers; this breaks the cycle.
private final class WeakHandler: NSObject, WKScriptMessageHandler {
    weak var target: MachineWeb?
    init(_ t: MachineWeb) { target = t }
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        MainActor.assumeIsolated { target?.userContentController(c, didReceive: m) }
    }
}

/// The SwiftUI wrapper for one machine's web view.
struct MachineWebView: UIViewRepresentable {
    let web: MachineWeb
    func makeUIView(context: Context) -> WKWebView { web.webView }
    func updateUIView(_ view: WKWebView, context: Context) {}
}

/// Machine icons as data: URLs, fetched once per run by the app (the icons are
/// public — no sign-in needed) and handed to every page's quick switch.
@MainActor
final class IconCache {
    static let shared = IconCache()
    private var cache: [URL: String] = [:]
    private var inFlight: Set<URL> = []

    func dataURL(for url: URL?) -> String? { url.flatMap { cache[$0] } }

    func fetch(_ url: URL?, then done: @escaping () -> Void) {
        guard let url, cache[url] == nil, !inFlight.contains(url) else { return }
        inFlight.insert(url)
        Task {
            defer { inFlight.remove(url) }
            guard let (data, resp) = await Reach.get(url),
                  (resp as? HTTPURLResponse)?.statusCode == 200,
                  data.count < 512 * 1024, data.starts(with: [0x89, 0x50, 0x4E, 0x47]) else { return } // PNG only
            cache[url] = "data:image/png;base64," + data.base64EncodedString()
            done()
        }
    }
}

