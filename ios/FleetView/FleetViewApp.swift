import SwiftUI

@main
struct FleetViewApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var store = MachineStore()
    @StateObject private var pool = WebPool()
    @StateObject private var push = PushCenter.shared

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(store)
                .environmentObject(pool)
                .environmentObject(push)
                .preferredColorScheme(.dark)
        }
    }
}

/// One live MachineWeb per machine you've opened this run. Machines you never
/// open cost nothing; ones you have stay connected while you look at another.
@MainActor
final class WebPool: ObservableObject {
    private var webs: [UUID: MachineWeb] = [:]
    /// Machines this phone can't reach right now (Reach.probe). A travelling
    /// laptop is the normal case: it must cost nothing and never trap you.
    @Published private(set) var offline: Set<UUID> = []
    private var misses: [UUID: Int] = [:]
    private var monitor: Task<Void, Never>?

    /// Wired once by RootView: the machine list and how to switch.
    var machines: () -> [Machine] = { [] }
    var switchTo: (UUID) -> Void = { _ in }
    var currentID: () -> UUID? = { nil }

    func web(for m: Machine, onSwitcher: @escaping () -> Void) -> MachineWeb {
        if let w = webs[m.id], w.machine.base == m.base { return w }
        let w = MachineWeb(machine: m)
        w.onRequestSwitcher = onSwitcher
        w.machineList = { [weak self] in self?.machines() ?? [] }
        w.onSwitch = { [weak self] id in self?.switchTo(id) }
        w.onReach = { [weak self] up in self?.setReach(m.id, up) }
        w.isOffline = { [weak self] id in self?.offline.contains(id) ?? false }
        webs[m.id] = w
        return w
    }

    private func setReach(_ id: UUID, _ up: Bool) {
        let changed = up ? offline.remove(id) != nil : offline.insert(id).inserted
        guard changed else { return }
        for w in webs.values { w.sendMachines() } // re-draw every page's quick switch
    }

    /// Probe every machine at once (5s each, in parallel) and react: an
    /// offline machine in the background is parked (its page stops retrying);
    /// one that's back is reloaded — the one on screen included, so its
    /// offline screen turns into FleetView by itself.
    @discardableResult
    func checkAll() async -> [UUID: Bool] {
        let list = machines()
        let results = await withTaskGroup(of: (UUID, Bool).self) { group -> [(UUID, Bool)] in
            for m in list { group.addTask { (m.id, await Reach.probe(m.base)) } }
            var out: [(UUID, Bool)] = []
            for await r in group { out.append(r) }
            return out
        }
        // EVERY machine failing at once says more about this phone's
        // connection (Tailscale waking up, no signal) than about the
        // machines: don't mark anything offline on that.
        if results.count > 1 && results.allSatisfy({ !$0.1 }) { return Dictionary(uniqueKeysWithValues: results) }
        // A failure next to a machine that DID answer is credible at once; with
        // nothing to compare against (one machine), it takes two in a row.
        let someoneAnswered = results.contains { $0.1 }
        for (id, up) in results {
            misses[id] = up ? 0 : (misses[id] ?? 0) + 1
            if up { setReach(id, true) } else if someoneAnswered || (misses[id] ?? 0) >= 2 { setReach(id, false) } else { continue }
            guard let w = webs[id] else { continue }
            if up { w.cameBack() } else if id != currentID() { w.suspend() }
        }
        return Dictionary(uniqueKeysWithValues: results)
    }

    /// Every 20s while the app is in front; nothing at all in the background.
    func startMonitor() {
        monitor?.cancel()
        monitor = Task { [weak self] in
            while !Task.isCancelled {
                await self?.checkAll()
                try? await Task.sleep(for: .seconds(20))
            }
        }
    }

    func stopMonitor() {
        monitor?.cancel()
        monitor = nil
    }

    /// Set only on a REAL trip to the background — not Control Centre, a
    /// notification pull-down or a Face ID sheet, which pass through
    /// .inactive and leave the sockets alive.
    private var backgroundedAt: Date?
    func didEnterBackground() { backgroundedAt = Date() }

    /// Back in front after being in the background: every loaded page
    /// rebuilds its connections (or reloads — see MachineWeb.resume).
    func resumeAll() {
        guard let since = backgroundedAt else { return }
        backgroundedAt = nil
        let away = Date().timeIntervalSince(since)
        for w in webs.values { w.resume(after: away) }
    }

    func existing(_ id: UUID) -> MachineWeb? { webs[id] }
    var all: [MachineWeb] { Array(webs.values) }
    func drop(_ id: UUID) { webs[id] = nil }
}

let fleetBackground = Color(red: 0x0d / 255, green: 0x11 / 255, blue: 0x17 / 255)

struct RootView: View {
    @EnvironmentObject var store: MachineStore
    @EnvironmentObject var pool: WebPool
    @EnvironmentObject var push: PushCenter
    @Environment(\.scenePhase) private var phase
    @State private var showSwitcher = false
    @State private var opened: Set<UUID> = []

    var body: some View {
        ZStack {
            fleetBackground.ignoresSafeArea()
            if store.machines.isEmpty {
                AddMachineView(first: true)
            } else {
                // Every machine opened this run stays mounted (live sockets);
                // only the current one is visible and touchable.
                ForEach(store.machines.filter { opened.contains($0.id) || $0.id == store.currentID }) { m in
                    let web = pool.web(for: m) { showSwitcher = true }
                    MachinePage(web: web, others: store.machines.filter { $0.id != m.id }, offlineIDs: pool.offline,
                                switchTo: { store.currentID = $0 }) { showSwitcher = true }
                        .opacity(m.id == store.currentID ? 1 : 0)
                        .allowsHitTesting(m.id == store.currentID)
                        // Hidden machines stay loaded but must not be reachable by VoiceOver.
                        .accessibilityHidden(m.id != store.currentID)
                        .onAppear { opened.insert(m.id) }
                }
            }
        }
        .sheet(isPresented: $showSwitcher) {
            SwitcherView(close: { showSwitcher = false })
                .environmentObject(store)
                .environmentObject(pool)
                .environmentObject(push)
        }
        .onChange(of: store.currentID) { _, id in
            push.visibleOrigin = store.machines.first { $0.id == id }?.origin
            // Switching to a machine that was parked offline: check again now
            // (its offline screen shows meanwhile — never a hanging blank page).
            if let id, let w = pool.existing(id) { w.cameBack() }
        }
        .onChange(of: push.token) { _, token in
            guard let token else { return }
            for w in pool.all { w.registerPush(token: token) }
        }
        .onChange(of: push.pendingOpen?.origin) { _, _ in openPendingNotification() }
        .onChange(of: phase) { _, p in
            if p == .active {
                pool.resumeAll()
                pool.startMonitor()
                push.refreshBadge()
                push.visibleOrigin = store.current?.origin
                openPendingNotification()
            } else {
                if p == .background { pool.didEnterBackground() }
                pool.stopMonitor()
                push.visibleOrigin = nil
                push.refreshBadge() // leave the icon showing the true total
            }
        }
        .onAppear {
            push.visibleOrigin = store.current?.origin
            pool.machines = { [weak store] in store?.machines ?? [] }
            push.badgeSources = { [weak pool] in pool?.all.reduce(0) { $0 + $1.waiting } ?? 0 }
            pool.switchTo = { [weak store] id in store?.currentID = id }
            pool.currentID = { [weak store] in store?.currentID }
        }
        // Opening the app on a machine that's away (the work laptop while
        // you travel): start on one that answers instead. Only at launch —
        // later you're on whatever you chose, and see its offline screen.
        .task {
            // Only when the saved machine fails AND another answers in the
            // same check — that's a machine away, not this phone's network.
            let reach = await pool.checkAll()
            if let cur = store.currentID, reach[cur] == false,
               let alt = store.machines.first(where: { reach[$0.id] == true }) {
                store.currentID = alt.id
            }
            pool.startMonitor()
        }
        // Names/icons/order changed (or a machine was added/removed): every
        // open page redraws its quick-switch buttons.
        .onChange(of: store.machines) { _, _ in
            for w in pool.all { w.sendMachines() }
        }
        #if DEBUG
        // Simulator testing: launch with `-FLEET_ADD_MACHINE <address>` to add one.
        .task {
            if UserDefaults.standard.bool(forKey: "FLEET_RESET") {
                for m in store.machines { pool.drop(m.id); store.remove(m.id) }
            }
            // Comma-separated adds several; the first one ends up current.
            let list = (UserDefaults.standard.string(forKey: "FLEET_ADD_MACHINE") ?? "").split(separator: ",").map(String.init)
            for a in list where store.machine(forOrigin: MachineStore.normalise(a)?.absoluteString ?? "") == nil {
                try? await store.add(a)
            }
            if let first = list.first, let m = store.machine(forOrigin: MachineStore.normalise(first)?.absoluteString ?? "") {
                store.currentID = m.id
            }
        }
        #endif
    }

    private func openPendingNotification() {
        guard let p = push.pendingOpen else { return }
        push.pendingOpen = nil
        guard let m = store.machine(forOrigin: p.origin) else { return }
        showSwitcher = false
        store.currentID = m.id
        opened.insert(m.id)
        let web = pool.web(for: m) { showSwitcher = true }
        if !p.pane.isEmpty { web.openPane(p.pane) }
    }
}

/// One machine's page plus its states: signing in, or unreachable.
struct MachinePage: View {
    @ObservedObject var web: MachineWeb
    let others: [Machine]
    let offlineIDs: Set<UUID>
    let switchTo: (UUID) -> Void
    let openSwitcher: () -> Void

    var body: some View {
        ZStack {
            MachineWebView(web: web).ignoresSafeArea()
            if web.offline {
                OfflineView(web: web, others: others, offlineIDs: offlineIDs, switchTo: switchTo, openSwitcher: openSwitcher)
            } else if let problem = web.problem {
                VStack(spacing: 16) {
                    Image(systemName: "bolt.horizontal.circle")
                        .font(.system(size: 44, weight: .light))
                        .foregroundStyle(.secondary)
                    Text(web.machine.name).font(.title2.bold())
                    Text(problem)
                        .multilineTextAlignment(.center)
                        .foregroundStyle(.secondary)
                    HStack(spacing: 12) {
                        Button("Try again") { web.load() }
                            .buttonStyle(.borderedProminent)
                        Button("Machines", action: openSwitcher)
                            .buttonStyle(.bordered)
                    }
                    OtherMachines(others: others, offlineIDs: offlineIDs, switchTo: switchTo)
                }
                .padding(32)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(fleetBackground)
            } else if web.signingIn {
                ProgressView("Signing in to \(web.machine.name)…")
                    .padding(24)
                    .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14))
            }
        }
    }
}

/// A machine this phone can't reach. Shown at once (Reach.probe, 5s) instead
/// of a blank page; the way out — your other machines — is right here, and
/// WebPool turns it back into FleetView by itself when the machine returns.
struct OfflineView: View {
    @ObservedObject var web: MachineWeb
    let others: [Machine]
    let offlineIDs: Set<UUID>
    let switchTo: (UUID) -> Void
    let openSwitcher: () -> Void
    @State private var checking = false

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "wifi.slash")
                .font(.system(size: 44, weight: .light))
                .foregroundStyle(.secondary)
            Text("\(web.machine.name) is offline").font(.title2.bold())
            Text("This phone can't reach it right now — it may be asleep, switched off, or off Tailscale. It reconnects by itself when it's back.")
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
            if let why = web.offlineReason {
                Text("Last check: \(why)")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .multilineTextAlignment(.center)
            }
            HStack(spacing: 12) {
                Button {
                    checking = true
                    web.load()
                    Task { try? await Task.sleep(for: .seconds(5)); checking = false }
                } label: {
                    HStack(spacing: 8) {
                        if checking { ProgressView().tint(.white) }
                        Text(checking ? "Checking…" : "Try again")
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(checking)
                Button("Machines", action: openSwitcher)
                    .buttonStyle(.bordered)
            }
            OtherMachines(others: others, offlineIDs: offlineIDs, switchTo: switchTo)
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(fleetBackground)
    }
}

/// "Go to another machine" buttons for the offline / can't-reach screens.
struct OtherMachines: View {
    let others: [Machine]
    let offlineIDs: Set<UUID>
    let switchTo: (UUID) -> Void

    var body: some View {
        if !others.isEmpty {
            VStack(spacing: 10) {
                ForEach(others) { m in
                    let away = offlineIDs.contains(m.id)
                    Button { switchTo(m.id) } label: {
                        HStack(spacing: 12) {
                            MachineIcon(url: m.icon).opacity(away ? 0.4 : 1)
                            VStack(alignment: .leading, spacing: 1) {
                                Text("Open \(m.name)").font(.headline)
                                if away { Text("Offline too").font(.caption).foregroundStyle(.secondary) }
                            }
                            Spacer()
                            Image(systemName: "chevron.right").foregroundStyle(.secondary)
                        }
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .background(Color.white.opacity(0.07), in: RoundedRectangle(cornerRadius: 12))
                    }
                    .buttonStyle(.plain)
                }
            }
            .frame(maxWidth: 360)
            .padding(.top, 8)
        }
    }
}

/// The machine switcher — opened by tapping the machine name in FleetView's top
/// bar (client/src/app-bridge.ts), or from the "can't reach" screen.
struct SwitcherView: View {
    @EnvironmentObject var store: MachineStore
    @EnvironmentObject var pool: WebPool
    @EnvironmentObject var push: PushCenter
    let close: () -> Void
    @State private var adding = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(store.machines) { m in
                        Button {
                            store.currentID = m.id
                            close()
                        } label: {
                            HStack(spacing: 14) {
                                MachineIcon(url: m.icon)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(m.name).font(.headline).foregroundStyle(.primary)
                                    Text(m.host).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                                }
                                Spacer()
                                if m.id == store.currentID {
                                    Image(systemName: "checkmark").foregroundStyle(Color.accentColor)
                                }
                            }
                        }
                        .buttonStyle(.plain) // names in normal ink, not link blue
                        .contentShape(Rectangle())
                        .swipeActions {
                            Button(role: .destructive) {
                                pool.drop(m.id)
                                store.remove(m.id)
                            } label: { Label("Remove", systemImage: "trash") }
                        }
                        .task { await store.refresh(m.id) }
                    }
                    .onMove { store.move(from: $0, to: $1) }
                } footer: {
                    Text("Tap a machine to switch. Swipe left to remove one.")
                }
                Section {
                    Button { adding = true } label: { Label("Add a machine", systemImage: "plus") }
                    if let id = store.currentID, let web = pool.existing(id) {
                        Button { web.reload(); close() } label: { Label("Reload \(web.machine.name)", systemImage: "arrow.clockwise") }
                    }
                }
                Section {
                    LabeledContent("Notifications", value: push.authorized == false ? "Off — turn on in Settings" : push.token == nil ? "Starting…" : "On")
                    if push.authorized == false, let url = URL(string: UIApplication.openSettingsURLString) {
                        Button("Open Settings") { UIApplication.shared.open(url) }
                    }
                } footer: {
                    Text("Each machine sends its own alerts. Which kinds (needs you / finished) is set in that machine's FleetView Settings.")
                }
            }
            .navigationTitle("Machines")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { EditButton() }
                ToolbarItem(placement: .topBarTrailing) { Button("Done", action: close) }
            }
            .sheet(isPresented: $adding) {
                NavigationStack { AddMachineView(first: false, done: { adding = false; close() }) }
                    .environmentObject(store)
            }
        }
    }
}

struct MachineIcon: View {
    let url: URL?
    var body: some View {
        AsyncImage(url: url) { img in
            img.resizable().scaledToFill()
        } placeholder: {
            RoundedRectangle(cornerRadius: 9).fill(Color.white.opacity(0.08))
                .overlay(Image(systemName: "square.grid.2x2").foregroundStyle(.secondary))
        }
        .frame(width: 40, height: 40)
        .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
    }
}

struct AddMachineView: View {
    @EnvironmentObject var store: MachineStore
    let first: Bool
    var done: (() -> Void)? = nil
    @State private var address = ""
    @State private var busy = false
    @State private var error: String?
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            if first {
                Spacer()
                Image(systemName: "square.grid.2x2.fill")
                    .font(.system(size: 48))
                    .foregroundStyle(Color.accentColor)
                Text("FleetView").font(.largeTitle.bold())
                Text("Add a machine that runs FleetView. You can add more later — your work and personal machines live side by side in this one app.")
                    .foregroundStyle(.secondary)
            }
            VStack(alignment: .leading, spacing: 8) {
                Text("Machine address").font(.subheadline.weight(.semibold))
                TextField("did2200.tail5df669.ts.net", text: $address)
                    .textContentType(.URL)
                    .keyboardType(.URL)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .submitLabel(.go)
                    .focused($focused)
                    .onSubmit(add)
                    .padding(12)
                    .background(Color.white.opacity(0.07), in: RoundedRectangle(cornerRadius: 10))
                Text("Its tailnet name — the address you open FleetView at in Safari. Tailscale must be connected on this phone.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if let error {
                Text(error).font(.callout).foregroundStyle(.red)
            }
            Button(action: add) {
                HStack {
                    if busy { ProgressView().tint(.white) }
                    Text(busy ? "Checking…" : "Add machine").bold()
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 6)
            }
            .buttonStyle(.borderedProminent)
            .disabled(busy || address.trimmingCharacters(in: .whitespaces).isEmpty)
            if first { Spacer(); Spacer() }
        }
        .padding(24)
        .frame(maxWidth: 520)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: first ? .center : .top)
        .background(fleetBackground.ignoresSafeArea())
        .navigationTitle(first ? "" : "Add a machine")
        .toolbar {
            if !first, let done { ToolbarItem(placement: .topBarTrailing) { Button("Cancel", action: done) } }
        }
        .onAppear { focused = !first }
    }

    private func add() {
        guard !busy else { return }
        busy = true
        error = nil
        Task {
            do {
                try await store.add(address)
                busy = false
                done?()
            } catch {
                busy = false
                self.error = error.localizedDescription
            }
        }
    }
}
