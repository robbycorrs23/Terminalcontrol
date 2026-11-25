import Foundation

/// One FleetView install the app can show — a machine (your work Mac, your
/// personal one), reached at its tailnet URL. The app is ONE icon for all of
/// them; the web app needed one Home Screen icon per machine.
struct Machine: Codable, Identifiable, Hashable {
    var id: UUID
    /// What the machine calls itself (the manifest's short_name, e.g. "did2200").
    var name: String
    /// scheme://host[:port] — no path. Every page and API is relative to it.
    var base: URL
    /// Its Home Screen icon (public, served without sign-in), for the switcher.
    var icon: URL?

    /// "https://did2200.tail5df669.ts.net" — matches the `origin` the server
    /// puts in a push, which is how a tapped notification finds its machine.
    var origin: String { base.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")) }
    var host: String { base.host ?? base.absoluteString }
}

enum AddMachineError: LocalizedError {
    case badAddress, unreachable(String), notFleetView

    var errorDescription: String? {
        switch self {
        case .badAddress: return "That doesn't look like an address. Try your machine's tailnet name, e.g. did2200.tail5df669.ts.net."
        case .unreachable(let host): return "Couldn't reach \(host). Is Tailscale connected on this phone?"
        case .notFleetView: return "That address answered, but it isn't FleetView."
        }
    }
}

/// The saved machines and which one is on screen. Plain UserDefaults: it's a
/// short list of public URLs — nothing secret lives here (sign-in cookies are
/// in each machine's own WKWebsiteDataStore).
@MainActor
final class MachineStore: ObservableObject {
    @Published private(set) var machines: [Machine] = []
    @Published var currentID: UUID? {
        didSet { UserDefaults.standard.set(currentID?.uuidString, forKey: Self.currentKey) }
    }

    private static let listKey = "machines.v1"
    private static let currentKey = "machines.current"

    init() {
        if let data = UserDefaults.standard.data(forKey: Self.listKey),
           let list = try? JSONDecoder().decode([Machine].self, from: data) {
            machines = list
        }
        let saved = UserDefaults.standard.string(forKey: Self.currentKey).flatMap(UUID.init(uuidString:))
        currentID = machines.first(where: { $0.id == saved })?.id ?? machines.first?.id
    }

    var current: Machine? { machines.first { $0.id == currentID } }

    func machine(forOrigin origin: String) -> Machine? {
        let o = origin.trimmingCharacters(in: CharacterSet(charactersIn: "/")).lowercased()
        return machines.first { $0.origin.lowercased() == o }
    }

    private func save() {
        if let data = try? JSONEncoder().encode(machines) {
            UserDefaults.standard.set(data, forKey: Self.listKey)
        }
    }

    /// "did2200.tail5df669.ts.net", "https://host/", "host:4290" → https://host[:port]
    static func normalise(_ input: String) -> URL? {
        var s = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { return nil }
        if !s.contains("://") { s = "https://" + s }
        guard let u = URLComponents(string: s), let host = u.host, !host.isEmpty,
              u.scheme == "https" || u.scheme == "http" else { return nil }
        var c = URLComponents()
        c.scheme = u.scheme
        c.host = host.lowercased()
        c.port = u.port
        return c.url
    }

    /// Check the address really is FleetView (its manifest is public, even
    /// behind the passkey gate), learn its name + icon, and save it.
    @discardableResult
    func add(_ input: String) async throws -> Machine {
        guard let base = Self.normalise(input) else { throw AddMachineError.badAddress }
        if let existing = machines.first(where: { $0.base == base }) {
            currentID = existing.id
            return existing
        }
        struct Manifest: Decodable {
            struct Icon: Decodable { let src: String }
            let name: String?
            let short_name: String?
            let icons: [Icon]?
        }
        let url = base.appendingPathComponent("manifest.webmanifest")
        let data: Data
        do {
            var req = URLRequest(url: url, timeoutInterval: 12)
            req.cachePolicy = .reloadIgnoringLocalCacheData
            let (d, resp) = try await URLSession.shared.data(for: req)
            guard (resp as? HTTPURLResponse)?.statusCode == 200 else { throw AddMachineError.notFleetView }
            data = d
        } catch let e as AddMachineError {
            throw e
        } catch {
            throw AddMachineError.unreachable(base.host ?? input)
        }
        guard let m = try? JSONDecoder().decode(Manifest.self, from: data),
              (m.name ?? "").hasPrefix("FleetView") || m.short_name != nil else { throw AddMachineError.notFleetView }
        let name = m.short_name ?? base.host?.components(separatedBy: ".").first ?? "FleetView"
        // Prefer the 192px icon; manifest paths are site-relative.
        let iconPath = m.icons?.first(where: { $0.src.contains("192") })?.src ?? m.icons?.first?.src
        let icon = iconPath.flatMap { URL(string: $0, relativeTo: base)?.absoluteURL }
        let machine = Machine(id: UUID(), name: name, base: base, icon: icon)
        machines.append(machine)
        save()
        currentID = machine.id
        return machine
    }

    /// Refresh name/icon from the manifest (they can be changed in Settings).
    func refresh(_ id: UUID) async {
        guard let i = machines.firstIndex(where: { $0.id == id }) else { return }
        let base = machines[i].base
        struct Manifest: Decodable { struct Icon: Decodable { let src: String }; let short_name: String?; let icons: [Icon]? }
        guard let (data, resp) = await Reach.get(base.appendingPathComponent("manifest.webmanifest")),
              (resp as? HTTPURLResponse)?.statusCode == 200,
              let m = try? JSONDecoder().decode(Manifest.self, from: data),
              let j = machines.firstIndex(where: { $0.id == id }) else { return }
        if let n = m.short_name { machines[j].name = n }
        if let src = m.icons?.first(where: { $0.src.contains("192") })?.src ?? m.icons?.first?.src {
            machines[j].icon = URL(string: src, relativeTo: base)?.absoluteURL
        }
        save()
    }

    func remove(_ id: UUID) {
        machines.removeAll { $0.id == id }
        save()
        if currentID == id { currentID = machines.first?.id }
    }

    func move(from: IndexSet, to: Int) {
        machines.move(fromOffsets: from, toOffset: to)
        save()
    }
}

/// Can this phone reach a machine right now? One small public request (the
/// manifest is served without sign-in) with a SHORT timeout. Needed because an
/// offline tailnet peer doesn't refuse a connection — packets just vanish —
/// so a plain page load sits on a blank screen for a minute or more.
enum Reach {
    private static let session: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        // Generous: a phone's Tailscale tunnel can take several seconds to wake
        // after the app returns to the front, and 5s called live machines
        // "offline". A failed check is no longer final anyway (MachineWeb
        // keeps loading the page behind the offline screen).
        c.timeoutIntervalForRequest = 9
        c.timeoutIntervalForResource = 10
        c.waitsForConnectivity = false
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: c)
    }()

    static func probe(_ base: URL) async -> Bool { await check(base) == nil }

    /// nil = reachable; otherwise a short reason, shown on the offline screen.
    static func check(_ base: URL) async -> String? {
        do {
            let (_, resp) = try await session.data(from: base.appendingPathComponent("manifest.webmanifest"))
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            return code > 0 && code < 500 ? nil : "it answered HTTP \(code)"
        } catch let e as URLError {
            switch e.code {
            case .timedOut: return "no answer within 10 seconds"
            case .cannotFindHost, .dnsLookupFailed: return "its name didn't resolve (is Tailscale on?)"
            case .notConnectedToInternet: return "this phone is offline"
            case .cannotConnectToHost: return "it refused the connection"
            case .secureConnectionFailed, .serverCertificateUntrusted: return "its HTTPS certificate wasn't accepted"
            default: return e.localizedDescription
            }
        } catch {
            return error.localizedDescription
        }
    }

    /// Short-timeout GET for small public things (icons, manifests).
    static func get(_ url: URL) async -> (Data, URLResponse)? {
        try? await session.data(from: url)
    }
}
