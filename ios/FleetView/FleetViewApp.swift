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

    /// Wired once by RootView: the machine list and how to switch.
    var machines: () -> [Machine] = { [] }
    var switchTo: (UUID) -> Void = { _ in }

    func web(for m: Machine, onSwitcher: @escaping () -> Void) -> MachineWeb {
        if let w = webs[m.id], w.machine.base == m.base { return w }
        let w = MachineWeb(machine: m)
        w.onRequestSwitcher = onSwitcher
        w.machineList = { [weak self] in self?.machines() ?? [] }
        w.onSwitch = { [weak self] id in self?.switchTo(id) }
        webs[m.id] = w
        return w
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
                    MachinePage(web: web) { showSwitcher = true }
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
        }
        .onChange(of: push.token) { _, token in
            guard let token else { return }
            for w in pool.all { w.registerPush(token: token) }
        }
        .onChange(of: push.pendingOpen?.origin) { _, _ in openPendingNotification() }
        .onChange(of: phase) { _, p in
            if p == .active {
                push.clearBadge()
                push.visibleOrigin = store.current?.origin
                openPendingNotification()
            } else {
                push.visibleOrigin = nil
            }
        }
        .onAppear {
            push.visibleOrigin = store.current?.origin
            pool.machines = { [weak store] in store?.machines ?? [] }
            pool.switchTo = { [weak store] id in store?.currentID = id }
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
    let openSwitcher: () -> Void

    var body: some View {
        ZStack {
            MachineWebView(web: web).ignoresSafeArea()
            if let problem = web.problem {
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
