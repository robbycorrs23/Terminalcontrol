# FleetView — agent guide

A single browser window holding a **grid of real terminals** (one `node-pty` shell
per box), each typically running `claude` or `codex`. Click a box to zoom it; when
an agent needs approval or finishes, its box glows/dings and the inbox badge in the
top bar counts it. Local-only tool: a Node server on `localhost` spawns the shells.

## Prerequisites (on any machine that runs this)
- **Node.js** (project uses ESM; `node-pty` ships prebuilds for macOS/Linux x64/arm64).
- **tmux** — *strongly recommended*. Terminals run inside `fleet_<id>` tmux sessions
  so they survive server restarts/crashes. Without it, shells die with the server.
  Install: `brew install tmux` / `apt install tmux`.
- **curl** — the Claude Code hooks use it to phone home. Usually preinstalled.
- **`claude`** (Claude Code CLI) and/or **`codex`** (Codex CLI, `npm install -g
  @openai/codex`) — for the per-box agents. The picker's "run on open" select
  chooses **claude (work) / codex (work) / plain shell**, plus an SSH optgroup;
  a "💬 Chat view" checkbox (unchecked by default) decides whether the box becomes a chat pane or a
  terminal pane. **This machine is work-accounts-only** — see the invariant
  below.
- **`~/.local/bin/claude-work` and `~/.local/bin/codex-work`** — one-line
  wrappers that export `CLAUDE_CONFIG_DIR`/`CODEX_HOME` and exec the real CLI.
  TERMINAL panes need these on `PATH` (a PTY pane's `cmd` is just typed into a
  shell, so FleetView sets no env for it); CHAT panes don't, because
  `agent-manager.js` sets the same vars itself.
- macOS or Linux. `$SHELL` should be set (falls back to `/bin/zsh`; see
  `server/pty-manager.js`).

## Run / build / test
- `npm install` — installs deps; a postinstall (`scripts/fix-pty-helper.js`) chmods
  the node-pty spawn helper.
- `npm run snapshot` — capture what every pane is doing to `~/.fleetview/snapshots/`
  (JSON + readable Markdown). Deliberately **external**: it uses the running
  server's REST API plus tmux `capture-pane` and the on-disk SDK transcripts, so
  it works against a server running older code, or with no server at all. Take one
  before anything that could bounce the server.
- `npm run doctor` — preflight: checks tmux/curl/claude, prints the exact per-platform
  install command, and can install tmux (interactive, or `FLEET_AUTO_INSTALL=1`).
  `scripts/preflight.js` also exports `preflight()`, which `server/index.js` calls
  FIRST at startup (warn-only) so missing-dep warnings are the most prominent output.
- `npm run go` — build client + start server (this also **restarts** it). Re-runs
  Vite every time; use `npm start` for a plain restart without rebuilding.
- `npm run service:install` / `service:uninstall` — opt-in auto-start on login
  (launchd on macOS, systemd --user on Linux). `scripts/install-service.js` captures
  a working PATH into the service env (launchd/systemd give a minimal PATH, which
  would silently break tmux/claude/curl). A reboot returns the *server*, not live
  sessions (reboot kills tmux → fresh shells). The server exits readably on
  EADDRINUSE so the service + a manual `npm start` don't fight silently.
- `npm run build` — build the client bundle only (vite → `dist/`). Safe: does NOT
  restart the server; a running server serves the new bundle to the next page load.
- `npm start` — start the server. It rebuilds a stale client bundle itself
  (see "Startup self-check" below), so `git pull` + restart is enough.
- `FLEET_PORT=5000 npm run go` — different port. `FLEET_HOST=0.0.0.0` — bind beyond
  loopback (see Security).
- **Typecheck: `npm run typecheck`** (= `tsc --noEmit`). ⚠️ `vite build` uses
  esbuild and does NOT typecheck — always run `tsc` separately. CI runs typecheck
  + build + `node --check` (`.github/workflows/ci.yml`).
- **No test framework / no committed tests.** Verify changes with throwaway Node
  scripts that exercise modules in isolation (temp state files, unique ports,
  isolated tmux sockets), run ad-hoc with `node`; don't commit them.
  When testing HTTP in-process, use `fetch` (async) — a synchronous `spawnSync`
  curl against an in-process server **deadlocks** the event loop.

## Layout
| Path | Responsibility |
|------|----------------|
| `server/pty-manager.js` | owns panes: spawn/kill shells, tmux sessions, scrollback, attention, **dormant recovery**, persistence |
| `server/layout-store.js` / `task-store.js` | named layouts / the global task tree |
| `server/setup-hooks.js` | idempotently install the guarded Claude Code hooks |
| `server/transcript.js` | rebuild an agent pane's chat log from the SDK's on-disk transcript |
| `server/snapshot.js` | point-in-time dump of every pane (also written on shutdown) |
| `server/index.js` | HTTP + WS wiring, REST, hook endpoints, static client |
| `server/identity.js` | which machine this is: app name, icon colour, in-app label |
| `server/push-vapid.js` / `push-store.js` | VAPID identity / per-device Web Push subscriptions (both `~/.fleetview`, 0600) |
| `server/push-send.js` / `push-notifier.js` | the one `web-push` caller / attention → category filter → fan-out → prune |
| `client/src/terminal.ts` | one xterm box bound to one PTY socket (auto-reconnects) |
| `client/src/main.ts` | grid, zoom, tray, drag, picker, attention queue, control socket |
| `client/src/tasks.ts` | the task-list sidebar (tree, drag, debounced save) |
| `client/src/tab.ts` | browser-tab title + favicon attention indicator |
| `client/src/markdown.ts` | Markdown → safe HTML for chat bubbles (tables, media, task lists) |
| `client/src/rich.ts` | post-render pass: charts, table→chart toggle, copy buttons, clipping |
| `client/src/chat-steps.ts` / `chat-dock.ts` / `chat-commands.ts` / `lightbox.ts` / `highlight.ts` | chat view: step rendering / approval dock / "/" menu / image viewer / code highlighting |
| `client/src/new-session.ts` / `server/auto-title.js` | phone new-session sheet / auto session titles |
| `client/src/changes-panel.ts` / `server/changes.js` | per-session Changes panel (transcript-attributed files × git diff) |
| `client/src/rewind-editor.ts` | edit-and-resend editor (rewind logic lives in agent-manager.js) |
| `server/summary.js` | session summaries: one digest per finished turn (headline / changed / needs you) for pushes + the inbox |
| `client/src/review.ts` | review mode: commentable numbered diffs in the Changes panel → one review message |
| `server/self-check.js` | startup: fix deps vs lockfile, rebuild a stale bundle, version info |
| `client/src/chat-question.ts` / `chat-tasks.ts` / `chat-queue.ts` / `chat-attachments.ts` | chat pane components: AskUserQuestion card / background-task tray / queued messages / composer attachments |
| `client/src/chip-select.ts` / `clipboard-images.ts` / `event-keys.ts` / `chat-usage.ts` | small helpers: invisible-select chips / paste & clipboard images / history anchors / usage rings + the ONE usage ramp |
| `client/src/inbox.ts` / `server/term-prompt.js` | fleet inbox / reading + answering a terminal pane's prompt |
| `server/worktrees.js` / `server/ship.js` | "Own branch" sessions (git worktrees) / commit → push → PR + cross-session overlaps |
| `client/src/git-status.ts` / `ship-panel.ts` | branch + overlap chips on every box / the Ship section of the Changes panel |
| `client/src/phone-nav.ts` / `version-check.ts` | phone swipe + session switcher + header subline / "updated — reload" chip + Settings version row |
| `client/src/styles.css` + `client/src/styles/*.css` | styles, split by area; `styles.css` only `@import`s them in the ORIGINAL cascade order — keep that order |
| `client/src/charts.ts` | dependency-free SVG charts (bar/hbar/line/area/donut/stat) |
| `client/src/push.ts` / `client/public/sw.js` | Web Push subscribe/badge / the service worker that shows notifications |
| `server/apns.js` | native push for the iOS app: APNs sender (HTTP/2 + ES256, no deps) + `~/.fleetview/apns-devices.json` |
| `client/src/app-bridge.ts` | the web side of the iOS app: brand → machine switcher, `fleetOpenPane()`, `body.in-app` |
| `ios/` | FleetView for iOS (SwiftUI + WKWebView). `project.yml` is the source (xcodegen); `scripts/testflight.sh` ships it; `scripts/asc.mjs` is a no-deps App Store Connect client |
| `server/gate.js` | optional passkey-auth reverse proxy (`fleetview-gate` service) that `tailscale serve` fronts instead of the app directly — a SEPARATE process from `server/index.js`, own port (`FLEET_GATE_PORT`, default 4290), own launchd/systemd unit (`com.fleetview.gate`). See Gotchas. |

## Key invariants / model (don't break these)
- **tmux globals are set against a THROWAWAY session, not `start-server`.**
  `_initTmuxGlobals()` looks roundabout and isn't: tmux's `exit-empty` defaults
  to ON, so a server with no sessions dies the instant `start-server` returns and
  every following `set-option -g` fails into `stdio:"ignore"` (which is exactly
  what the old `escape-time` line did — silently nothing, for as long as it had
  been there). Hence ONE chained invocation that creates a session, sets
  `exit-empty off` FIRST, then the rest, then kills it. `history-limit`
  additionally has to be in place before any `fleet_*` session exists, because
  tmux fixes a pane's history when the PANE is created. `mouse on` is
  load-bearing for scrolling, not polish: tmux keeps the outer terminal in the
  alternate screen, so xterm.js's own scrollback stays empty, and with mouse off
  xterm falls back to "alternate scroll mode" — wheel-up becomes cursor-up,
  which Claude Code reads as "cycle back through previous inputs", so scrolling
  replays your own prompts instead of the output. Cost: tmux owns click-drag, so
  native text selection needs Shift-drag.
- **tmux durability:** each pane is a detached `fleet_<id>` tmux session on a STABLE
  socket `~/.fleetview/tmux-<port>.sock` (NOT tmux's default `/tmp` socket, which the
  OS sweeps). Sessions outlive the server; on boot `PtyManager._restore` reattaches.
  The liveness check retries (a transient miss right after restart must NOT demote a
  live pane). Per-pane `sock` is tracked so old default-socket sessions still reattach.
- **Dormant recovery:** when a pane's tmux session dies (sleep/crash) or a layout
  "Replace" sets it aside, the pane goes **dormant** (metadata kept) and shows in the
  recovery bar — never silently dropped. `respawn` reattaches if alive, else spawns fresh.
- **Security:** the server runs shells with **no auth** → reaching the port = RCE.
  It binds `127.0.0.1` by default. `FLEET_HOST` opts into wider binding (warns).
  Never expose it publicly; front remote access with a tunnel/VPN (SSH, Tailscale).
- **Hooks:** `setup-hooks.js` merges three guarded hooks into `~/.claude/settings.json`
  on every server start: **Notification**→needs-you, **Stop**→done, **UserPromptSubmit**
  →pins the prompt. All no-op unless `$FLEET_PANE_ID` is set (i.e., inside a FleetView
  shell). Stripped-and-re-added idempotently (marker = `FLEET_PANE_ID`).
  The Notification/Stop hooks now POST pane+kind in the QUERY STRING and forward
  Claude's own hook JSON as the body, because that body carries `session_id` —
  the only channel by which a tmux-hosted `claude` ever tells us which
  conversation it is running, and therefore a hard prerequisite for flipping a
  terminal pane into a chat pane. `/hook` still accepts the older body-only
  `{pane, kind}` form so a `claude` already running with the previous hook keeps
  working. `setup-codex-hooks.js` does the same into `~/.codex/hooks.json`, mapping Codex's
  **PermissionRequest**→needs-you, **Stop**→done, **UserPromptSubmit**→pins the
  prompt (same `.prompt` field name Claude Code uses, so `/hook/prompt` needs no
  agent-specific branching). Unlike Claude Code, Codex requires non-managed command
  hooks to be reviewed/trusted once per machine before they fire — run `/hooks`
  inside a `codex` session, or launch Codex panes with
  `codex --dangerously-bypass-hook-trust` (bypasses trust review for ALL enabled
  hooks that session, not just FleetView's — a real tradeoff, not a default we set
  for you).
- **Working indicator:** a pane is "working" when EITHER its agent hooks say so
  (UserPromptSubmit → yes, Stop/Notification → no; sticky through silent tool
  calls) OR it produced PTY output in the last `WORK_IDLE_MS`. One sweep timer
  demotes quiet panes, and `PtyManager` emits `"work"` only on the EDGE, so a
  pane streaming megabytes costs one broadcast, not one per chunk. The client
  renders it as `.busy`/`.idle` on the box (border scan + Matrix rain over the
  content + idle boxes dimmed); `.waiting` always wins — needs-you outranks busy.
  The rain is CSS-only — one `transform` per column, no canvas and no rAF — and
  it PAUSES (not just hides) when a pane goes idle, so a quiet grid costs
  nothing. `◍` in the top bar cycles `body.fx-full` → `.fx-edge` → `.fx-off`.
- **WebSockets:** `/term?pane=` (per box, reconnects after sleep) and `/control?session=`
  (per browser window; grid events + initial panes/dormant/tasks snapshot).
- **One workspace per machine.** Panes are NOT scoped to a browser window any
  more: `registry.list()`/`dormantList()`/`idsOf()` ignore the `session`
  argument and `broadcast()` goes to every control socket, so a laptop window
  and the phone app see one identical fleet. Separate workspaces = separate
  machines. This exists because an installed PWA cold-launches with no session
  and a manifest `start_url` that can't carry one, so per-window workspaces
  meant the phone always opened an empty grid. A session id is still minted per
  window and still rides on the URL — it keys **ephemeral-secret release** (the
  window that authorised a secret is the one whose disconnect releases it, see
  `SESSION_GRACE_MS`) and nothing else. Don't reintroduce session filtering in
  a list/broadcast path. That includes secret INJECTION itself: it used to
  additionally require `session === registry.sessionOf(id)` (the pane's
  original CREATOR session) before accepting a secret, which was a pre-"one
  workspace" holdover — every window can already read/type into every pane, so
  it added no real access control, it just broke injection from any window
  other than whichever one happened to create the pane (fatal for a PWA-only
  setup, since a cold launch mints a fresh session every time). Removed; a
  `session` is still required on the request, just not compared to anything —
  it only identifies which window to attribute the eventual disconnect-release
  to.
- **Agent panes survive restarts in two halves, and BOTH are needed.** The
  *conversation* is durable via `sdkSessionId` → `_ensureDriver` resumes it. The
  *visible log* is not: `pane.events` is an in-memory ring (`RING_BUFFER_SIZE`,
  never persisted), so a restarted pane used to come back blank even though the
  model still remembered everything. `_hydrateFromTranscript` refills it from the
  SDK's `<configDir>/projects/*/<sdkSessionId>.jsonl` on first attach — once per
  process, only when the ring is empty, so it can never race live events.
  `transcript.js`'s mapping MIRRORS `claude-driver.js`'s `handleMessage` exactly
  (same event names, same id fields); if you change one, change the other.
- **Snapshot before you bounce the server.** `SIGTERM/SIGINT/SIGHUP` write a
  snapshot before exit, which matters most under the auto-start service, where
  `KeepAlive` turns *any* exit into an instant restart. ⚠️ Restarting also kills
  every agent pane's live driver — including, if you're working from inside a
  FleetView agent pane, your own session. Terminal panes are tmux-backed and
  don't care.
- **Per-machine settings live OUTSIDE the repo** (`server/machine-config.js` →
  `~/.fleetview/machine.json`, 0600). Which accounts an install offers, its
  badge image, its name and icon colour are facts about THE MACHINE, not about
  the product — the same checkout runs on several. Hardcoding the account list
  in source is exactly what put a work-only picker and a work badge on a
  personal machine the moment the branch was pulled. Rule of thumb: if two
  machines running this code would want different answers, it belongs in that
  file. (`layouts.json` prefs are the neighbouring idea — those are YOUR
  preferences, incl. theme; these are the machine's facts.) `FLEET_LABEL` /
  `FLEET_ICON_COLOR` still win over the stored values so headless installs keep
  working. The accounts list is EXPLICIT — seeded once from the logins actually
  present, then never inferred again, so pulling a branch can't change it. The
  badge reaches panes as the `--work-logo` CSS custom property, so a machine
  with no image shows none (`body.has-logo`) and changing it updates every pane
  at once.
- **Work accounts only on THIS machine** — set in `~/.fleetview/machine.json`,
  not in code. `isAgentProfile()` (`client/src/main.ts`) reads the server's
  list, `knownAccounts()` (`server/usage.js`) maps it, and `baseProfile()`
  (`server/pane-registry.js`) matches the full catalogue on purpose: a pane
  already running an account stays flippable even after that account is removed
  from the picker — the difference between "don't offer this" and "break what's
  already open". The account is still keyed purely off the `-work` SUFFIX
  (`accountConfigDirFor`). Nothing here ever deletes a login.
- **Per-pane view flip (terminal ⇄ chat).** The `💬`/`▤` button in each box's
  TITLE BAR hits `POST /api/panes/:id/flip`. Deliberately per-pane, not a
  whole-window sweep. This CANNOT be a re-render: a chat pane is an in-process
  SDK driver with no terminal behind it, and a terminal pane is a tmux shell
  with no event stream. So `registry.flip()` destroys the pane and re-creates
  it in the other kind, and the only thing making that a view switch rather
  than a restart is that both halves **resume the same Claude conversation, at
  the same permission mode**:
  - *Session id* — chat panes learn theirs from the SDK driver, terminal panes
    from the hook JSON that `setup-hooks.js` now forwards (`session_id`),
    stored as `pane.sdkSessionId` in BOTH managers.
  - *Permission mode* — new chat panes start in **auto** (`AgentManager.create`),
    not the CLI's ask-for-everything default; an explicit mode always wins, so a
    flip still carries whatever the pane was actually running. Carried BOTH ways or a chat→terminal→chat round trip
    silently resets an Auto pane to Ask. Chat panes own `mode`; terminal panes
    stash it in `pane.agentMode` and start `claude` at it via
    `--permission-mode`. The chat "default" (Ask) has NO flag spelling (it is
    the CLI's default), and any mode outside `CLI_PERMISSION_MODES` is dropped
    rather than passed through — an invalid value makes `claude` exit at
    startup and the box just sits there empty.

  **Chat panes never trigger Claude Code's workspace-trust dialog** (the SDK
  doesn't ask), so a folder used only through chat is unknown to the
  interactive CLI and a flip to terminal lands on "do you trust the files in
  this folder?" — which reads as the switch malfunctioning. `claude-trust.js`
  records that trust on flip, in `<configDir>/.claude.json`'s `projects` map
  (untrusted folders are ABSENT from it, not `false`). It deliberately does NOT
  touch `enabledMcpjsonServers`: a project `.mcp.json` gets its own prompt, and
  auto-approving someone else's MCP server is the user's call, not a view
  toggle's. Claude Code owns that file and rewrites it constantly, so the write
  only happens when the flag is actually missing, and goes through a temp file
  + rename.

  Consequences worth keeping: a terminal pane whose agent hasn't fired a hook
  yet has no id and is REFUSED rather than flipped into a blank conversation; a
  mid-turn pane is refused rather than interrupted; plain shells, raw ssh boxes
  and remote chat panes are refused; codex flips but starts fresh
  (`resumed:false`) because its resume path here is unverified. Every refusal
  is reported back and surfaced in `#viewNote` — silently doing half the job is
  the failure mode to avoid.

  **Keeping a flipped box in its grid slot needs three separate things**, and it
  visibly teleports if any one is missing: (1) `registry.list()` sorts across
  BOTH managers — it used to concatenate, so every pty pane sorted before every
  agent pane whatever their `order`, which needs `order` on `info()` to work at
  all; (2) `registry.reorder()` numbers ONE shared sequence via `applyOrder()`,
  because each manager's own `reorder` numbers only its own ids 0..n and mixed
  grids therefore collided (the "known limitation" in that file's header, which
  flipping triggers constantly); (3) the route captures grid order BEFORE the
  flip — afterwards the old pane's position is unrecoverable — and broadcasts
  `created` with `replaces: <oldId>` so the client reclaims the old slot instead
  of appending.
- **Tasks** are one global tree in `tasks.json`, broadcast to ALL windows on change.
- **Web Push / PWA** (phone notifications — the only alert that works with the app
  closed). Four things here are load-bearing and easy to undo by accident:
  1. **The push trigger lives in `broadcast()`**, not in `ptys.on("attention")`.
     PTY panes reach the client via the emitter, but agent/chat panes call
     `broadcast()` *directly* from `agent-manager.js` — hook the emitter and every
     chat pane silently stops notifying. Fire-and-forget; never `await` it, that
     function is hot for `work` events.
  2. **`sw.js` must show a notification on EVERY push**, including the
     malformed-payload path. WebKit revokes the subscription of a worker that
     receives a push and displays nothing, and recovery needs the user to delete
     and re-add the home-screen app. This is why foreground suppression is a
     positive Chrome/Firefox UA allowlist rather than a default — on iOS we show
     a redundant banner on purpose.
  3. **`sw.js` has NO `fetch` handler, deliberately.** Caching the app shell
     reintroduces the stale-bundle bug that `index.html`'s `no-store` exists to
     prevent (see the comment above `noStoreIndexHtml`), and a SW cache survives
     a hard reload. Offline support is meaningless for a live view of PTYs.
  4. **iOS gives the Push API only to home-screen web apps**, over HTTPS. So the
     manifest is a prerequisite for push, `tailscale serve` is a prerequisite for
     testing it, and the manifest must stay in `gate.js`'s `PUBLIC_PWA` allowlist
     *and* carry `crossorigin="use-credentials"` — browsers fetch a manifest with
     credentials omitted, so a gated manifest makes the app un-installable.
  Notification text is pane name + kind, plus — for "finished" pushes only, and
  only while the `pushSummary` pref is on (default on; Settings → Notifications
  "Say what it did") — the one-line session summary below. No cwd path,
  command, or prompt text otherwise. Web Push payloads are RFC 8291 encrypted,
  so the push service relays ciphertext it can't read; APNs payloads (the iOS
  app) are NOT end-to-end encrypted — Apple can read them — which is why the
  summary has an off switch.
- **Per-machine identity** (`server/identity.js`): name + Home Screen icon,
  because one-workspace-per-machine means several installs coexist and
  identical tiles full of real shells are a hazard. The icon is a SYMBOL
  (`ICON_MARKS`: fleet / terminal / briefcase / house / code) AND a COLOUR
  (`ICON_COLORS`), drawn as a coloured mark on a dark tile. Colour-only tiles
  failed in practice: iOS's dark Home Screen replaces a light/coloured tile
  background with its own dark one (two installs became identical grey
  squares), and tinted mode recolours everything — the SHAPE is the only thing
  that survives that. Precedence: `FLEET_LABEL` / `FLEET_ICON_COLOR` /
  `FLEET_ICON_MARK` env > `machine.json` (Settings → This machine's picker,
  which disables whatever env pins) > defaults (fleet; colour hashed from the
  label). Read LIVE per request (`identity.current()`), so a change applies to
  the next Add to Home Screen without a restart; index.html's cache is keyed
  on the icon href for the same reason. The manifest is **generated**, and
  every icon URL is SET-SCOPED (`/icons/<mark>-<colour>/…`) because iOS caches
  per URL — a stable URL kept showing the old icon. Directory names are FLAT
  on purpose: gate.js lets `/icons/<one-segment>/*.png` through
  unauthenticated and nothing deeper. Icon PNGs are committed artifacts,
  regenerated by `node scripts/make-icons.mjs` (sips / rsvg-convert), never at
  build time; it also writes `favicon.svg` and the white `badge-96.png`. The
  tile is flat on purpose (a gradient doubled the bytes across 30 sets). iOS
  caches name+icon at install, so changes need a delete + re-add.

- **The iOS app** (`ios/`, bundle `com.robertcorrado.fleetview`, team
  Z778754952, TestFlight). ONE app for every machine — a switcher (tap the
  machine name in the top bar → `app-bridge.ts` → `{t:"machines"}`) replaces
  one Home Screen icon per machine. It hosts the SAME pages in a WKWebView, so
  there is one UI, not two; each machine gets its own
  `WKWebsiteDataStore(forIdentifier:)` so sessions never mix (why iOS 17+).
  Three things are load-bearing:
  1. **Sign-in can't happen in the WKWebView.** WebAuthn there needs an
     associated domain, which Apple verifies over the PUBLIC internet — a
     tailnet host never passes, and TestFlight can't use the developer-mode
     bypass. So a page landing on `/gate/login` is intercepted and
     `ASWebAuthenticationSession` opens `/gate/app-login` (Safari sheet,
     passkeys work); the gate redirects to `fleetview://auth?code=…` — a
     single-use, 2-minute code only minted for an already-valid session — and
     the app loads `/gate/app-token?code=…`, which sets ITS cookie. The login
     page's `?next=` accepts only `/gate/app-login`.
  2. **Push is APNs, not Web Push** (no service-worker push in a WKWebView).
     The app POSTs its token to `/api/push/apns` FROM INSIDE each machine's
     page (rides the gate cookie, passes the same-origin guard) on every
     `ready`; `push-notifier.js` fans out to Web Push AND `server/apns.js`
     with the same text/rules/categories, `origin`+`pane` in the payload so a
     tap opens the right machine and session. Inert until
     `~/.fleetview/apns.json` (`keyPath`, `keyId`, `teamId`) exists — the
     .p8 is a team-wide APNs key; TestFlight = `production`.
  3. **The web side detects the app by CAPABILITY**
     (`window.webkit.messageHandlers.fleetApp`), not the UA, and hides the
     browser-only notification rows via `body.in-app`.
  Releasing: `ios/scripts/testflight.sh` (tests need this Mac's server on
  :4280; `SKIP_TESTS=1` to skip; `--no-upload` to only export). Export signs
  manually with the "FleetView App Store" profile + local Apple Distribution
  cert — the API key can't use cloud signing.

## Rich chat view (agent panes)

- **The chat view mirrors the Claude app's remote-control view** (see
  `chat-steps.ts`, `chat-dock.ts`, `chat-commands.ts`). Tool calls are one-line
  steps ("● Edit greet.js +2 −2") on a timeline, folding all but the last 3 of
  a run; edits show a diff built from the call's INPUT (the driver sends none);
  TodoWrite is a checklist; ExitPlanMode is a plan card; subagent steps nest
  under their Agent step via `parent`. Thinking is a collapsible step.
- **The composer is one box**: text, then `+` (files / secret / terminal
  view — `.view` still lives here for `flipView()`), mode, usage rings, model
  picker, and one button that is Send with text and Stop (■, or Esc) while a
  turn runs. Typing mid-turn queues. "/" opens the SDK's slash commands; Tab
  takes the prompt suggestion. The old `.chat-tools` row and the mobile ☰ are
  gone.
- **Approvals dock where the composer is** (`chat-dock.ts`), CLI-style:
  Yes / Yes-don't-ask-again (only when the SDK offers a rule: `canAlways`) /
  No-and-tell-Claude (the typed reason goes back as the deny `message`). Keys
  1-3. The gated step is marked in place; no separate permission card.
- **Driver plumbing behind it** (`claude-driver.js`): `includePartialMessages`
  for live text/thinking (stream ids paired FIFO with the finished blocks, so
  `assistant_done` reuses the streamed id), `thinking.display: "summarized"`,
  `promptSuggestions`, `commands`/`models` from init + `supportedCommands()`/
  `supportedModels()`, `setModel`, `tool_progress`, and `durationMs` on the
  final status. Deltas, progress, commands, models and suggestions are
  LIVE_ONLY in `agent-manager.js` (never ringed; the session-level ones are
  re-sent after the replay on attach). Every event gets a `ts`.
- **Usage rings** now sit in the composer row (labels hidden on phones).
- **Inline images.** Attachments wait in the composer as thumbnails (also
  paste), and on send their paths are appended to the message text, one per
  line: the driver protocol is unchanged and Claude Reads them. The user
  bubble renders any absolute image path in its text as the image (and drops
  the path); an image Read step shows the picture; every image opens in
  `lightbox.ts`. All via `/api/file` (`mediaSrc()`), now also serving HEIC.
  Paste reads `clipboardData.items` as well as `.files` (Safari often fills
  only `items`); "+ → Paste image" uses `navigator.clipboard.read()` because
  iOS offers no Paste in a text box for an image-only clipboard. The
  lightbox's Copy writes PNG via a ClipboardItem holding a PROMISE built
  inside the click — Safari drops the gesture after an await.
- **Phone navigation** (`phone-nav.ts`; main.ts owns the state and passes it
  in via `initPhoneNav()` — `zoomed` is read through a getter, never copied): swipe left/right
  on an open pane = next/previous in GRID order (not the list's attention
  order, which re-sorts as you open things); the "3/12 ⌄" `.pane-switch`
  button added to every title bar opens a sessions sheet (needs-you first);
  `zoom()` on a phone while a pane is open becomes `switchTo()`. The phone
  home list is restyled as an inbox (CSS only). The open pane's top edge is
  `max(visual-viewport top, #bar bottom)` — NOT `vy + barH`, which left a gap
  when the iOS keyboard scrolled #bar away.
- **Earlier history pages in from the transcript.** The replay ring only holds
  ~300 events; scrolling near the top sends `{t:"history", anchors}` (keys of
  the oldest events shown — `eventKey()`, MIRRORED in `transcript.js` and
  `agent-chat.ts`) and `olderEvents()` returns the 150 before that point. A
  unique tool id locates the spot; text keys are only a fallback. A page never
  opens on a tool result (it widens back to the call — dropping it lost the
  result for good). The parsed transcript is cached until the file changes.
  The client renders a page off-screen with `prepending` set (no live side
  effects) and keeps your scroll position. Codex/remote panes get none.
- **Messages typed mid-turn are queued CLIENT-side**, visibly, with edit /
  Send now / ✕, and go out as one message on the next LIVE `idle` (never a
  replayed one); an interrupted turn puts them back in the composer.
- **Status the SDK reports, now shown**: `api_retry` → "Retrying in 8s ·
  attempt 2/10 (API 529)" in the status line (back to Working… when output
  resumes); `compact_boundary` → a "Conversation compacted · 162k → 21k"
  divider (also mirrored from transcripts, camelCased on disk);
  `getContextUsage({detail:"summary"})` after each turn/compaction → the
  context meter in the composer row (same warn/crit ramp as usage rings);
  `task_*` → the background-task tray, each with its own ■ (`stopTask`).
  `perTaskStopAffordance: true` is what makes the turn's Stop spare
  background tasks — only valid BECAUSE the tray exists. retry/context/task
  are LIVE_ONLY; context and running tasks are re-sent on attach.
- **"Reconnecting…"** shows 1.5s after the agent socket drops. The timer must
  NOT restart on each failed retry (one per second) or it never shows.
- **Code blocks are syntax-highlighted** by `highlight.ts` (dependency-free,
  approximate). It escapes every fragment itself and emits only
  `<span class="tk-…">`, so markdown.ts's never-unescaped invariant holds.
- **On a phone an open pane hides `#bar`** (`body.pane-open`); its title bar
  takes over the safe-area inset. `setPaneOpen()` must run before measuring
  in both `zoom()` and `unzoom()`.
- **Phone headers are a redesign in CSS over the SAME DOM** (≤640px only):
  `#bar` becomes a large title + round ⚙ / + (the "Terminal" label is
  `.add-label`, hidden), chips scroll in one row; an open pane's title becomes
  a neutral nav bar — ‹, name + `.pane-sub` (folder, prefixed "Working · /
  Needs you · / Done ·" by CSS off `.busy`/`.waiting`), switcher, ⚑ — with the
  tint, badges, –, ✕ and (chat panes) `.pinned` hidden. `addTitleSubline()`
  wraps `.path` in `.title-text`; anything that looks for `.path` must not
  assume it's a direct child of `.title`.
- **Composer pickers are `chipSelect()`s**: a styled label with the real
  `<select>` invisibly on top at 16px. iOS zooms the page when a control
  under 16px is focused (the 11.5px mode picker zoomed the whole app). On
  phones every pane input/textarea/select is 16px for the same reason, and the
  usage rings move into the + menu's labelled `.menu-info` (tap the context %
  to open it). Set a picker's value in code → call `syncChip()`.
- **Settings is grouped cards** (index.html `#settings`, `styles/settings.css` "Settings
  — grouped cards"): Usage (one labelled bar per window), Workspace,
  Appearance, Notifications, Safety, This machine. Checkboxes render as
  switches via CSS (`appearance:none` + `order:2`, so JS-built rows such as
  `#mcAccounts` need no markup change). Popover on desktop, full-screen sheet
  with Done on a phone. The redesign appended overrides rather than deleting
  the older `#settings` rules (still in `styles/bar.css`) — when editing, look
  at settings.css first.
  All ids are unchanged and wired in main.ts.
- **Phone "+" opens the new-session sheet** (`new-session.ts`): recent folder,
  agent, Chat/Terminal (remembered in localStorage), optional first message.
  `POST /api/panes` accepts `prompt`, sent straight to a new CHAT pane via
  `agents.sendMessage`; the client then zooms the pane once `created` lands.
  "Browse…" falls back to the desktop picker, which desktop still uses.
- **Auto session titles** (`server/auto-title.js`, `maybeAutoTitle()` in
  index.js): hooked in `broadcast()` on `input` events, so chat panes AND
  terminal panes (via the UserPromptSubmit hook) are covered. Only panes
  created by THIS process (`freshPanes`) qualify — existing folder-named panes
  are never renamed — on their first prompt of ≥3 words, once, never over a
  name you set. One Haiku call: `tools: []`, `settingSources: []`,
  `persistSession: false` (no junk session in Claude Code's history), work
  account via CLAUDE_CONFIG_DIR, FLEET_PANE_ID stripped; falls back to a
  text heuristic. Off switch: the `autoTitle` pref (Settings → Workspace).
- **Changes panel** (`client/src/changes-panel.ts`, `server/changes.js`,
  `GET /api/panes/:id/changes`): files the session edited (Edit / MultiEdit /
  Write / NotebookEdit in its FULL transcript) shown as they are on disk now —
  `git diff HEAD` per file, untracked files as all-added, "no changes now" if
  committed/reverted — plus the repo's other uncommitted changes kept apart.
  Edits made through Bash can't be attributed from a transcript, so they land
  under Other (the panel says so). Paths are compared via realpath (macOS
  `/tmp` → `/private/tmp`, or any symlinked folder, otherwise misclassifies
  every file as outside the repo). Non-git folders fall back to the session's
  own edit inputs, diffed client-side with `inputDiff()`. git runs via
  execFile (argv, no shell, timeout, output cap); read-only. Opened from the
  + menu or the "N files changed" link under a turn (`turnFiles`, saved and
  restored around history pages like the other turn state).
- **Review mode** (`client/src/review.ts`, used by `changes-panel.ts`): every
  Changes diff renders as numbered rows (`parseDiffRows` reads the hunk
  headers; an untracked file's all-`+` diff counts from 1; non-git edit diffs
  get no numbers). Click/tap a row → inline comment; drafts persist per pane in
  localStorage (`fleet-review:<paneId>`) and each stores the line's TEXT, so on
  re-render it re-anchors by line+text, then text alone, else shows at the end
  of the file as "moved" — never silently dropped. "Send review" sends ONE
  message (file:line + the quoted code + comment, optional overall note)
  through `AgentChat.sendExternal()`, i.e. the composer's own path: mid-turn it
  joins the visible queue. It never touches what's half-typed in the composer.
  Client-only: no server changes.
- **Edit & resend (rewind)** (`client/src/rewind-editor.ts`, `rewind*` /
  `undoRewind` in agent-manager.js). Prerequisites, both load-bearing:
  `enableFileCheckpointing: true` on every chat session (without it a session
  can rewind the conversation but never files), and `send()` puts OUR id into
  the SDK message (`uuid`), so the transcript records the user entry under the
  same id the chat shows — that id is what a rewind targets. The conversation
  is restarted as a FORK at the message's `parentUuid` (`resumeAt` → driver
  `resumeSessionAt` + `forkSession`; one-shot, cleared on the next init): new
  session id, original transcript untouched, so Undo just switches back.
  Editing the very first message = a fresh session. The CLI's
  `resumeDropsTurn` guard is deliberately NOT used — its only safe recovery is
  to stop, which would turn an ordinary edit into an error; we count the turns
  being removed and say so up front instead. File restore is opt-in, uses
  `rewindFiles` (dry-run preview first), covers only Claude's file-tool edits
  (not Bash — the UI says so), and copies whatever it would overwrite to
  `~/.fleetview/rewind-backups/` first so Undo can put it back; one level of
  undo, persisted with the pane, old backups dropped when replaced. Refused
  mid-turn, for codex, and for remote panes. Verified against the real SDK:
  rewindFiles works on a resumed session before any new message, and inside a
  fork. The replay after a rewind/undo goes to every attached window.
- **Fleet inbox** (`client/src/inbox.ts`, `GET /api/inbox` + `POST
  /api/inbox/act` in index.js, `server/term-prompt.js`): every pending
  approval/question across ALL panes, answerable in place, then finished /
  cut-off sessions with a quick reply. Chat panes: `agent-manager.inboxOf()`
  (pending map kept from permission/question events, cleared on resolve or
  turn end; `lastReply` from assistant_done), broadcast `{t:"inbox"}` on
  change. Terminal panes: the prompt is READ OFF THE SCREEN (`ptys.screen()` =
  tmux capture-pane) and answered with keys (`ptys.sendKeys()`), verified
  against the real Claude Code CLI: options are NOT always numbered (the
  folder-trust prompt isn't), so an answer = arrow keys to move the ❯ cursor +
  Enter (`keysFor`). Options are found by alignment with the ❯ line's label
  column — prompt text is indented one space and would otherwise read as
  options. "No" cancels and Claude asks what to do instead, so a reason is
  typed as the next message (~0.9s later). The act endpoint RE-PARSES the
  screen and refuses (409) if the question/label changed, so a stale card can
  never press keys on a different prompt. Question cards reuse
  chat-question.ts; their `.term .q-*` rules are extended to `.inbox-card`.
  Badge = the attention queue length (`updateInboxBadge`); a dot when only
  Recover/Flagged items wait. **The inbox replaced the chip row under the
  bar**: dormant panes ("Recover", with Restore/Respawn/Discard/Recover all)
  and flagged follow-ups ("Flagged") render in it from main.ts state via
  `InboxDeps`. `#queue`/`#followups`/`#recovery` are still rendered (other
  code reads them) but hidden by CSS; `#barChips` only shows for the two
  transient notices (`#updateNote`, `#viewNote`). Dormant panes must stay
  visible somewhere — that's what the badge dot is for.
- **Session summaries** (`server/summary.js`). When a turn ends (`done` /
  `aborted` attention, seen in `broadcast()`), its LAST turn — everything after
  the last user message in the session's transcript, so chat AND terminal panes
  — becomes `{headline, changed, needsYou}` via one `oneShot()` Haiku call (JSON
  out, plain-text heuristic fallback). Cached per pane, keyed on the transcript's
  size+mtime: the notifier (`summarize`) and the inbox (`peek`/`ensure`) share
  one call per turn. `ensure()` never re-fires for a turn it already tried — the
  inbox calls it on every listing and a null result must not loop into
  refreshes. The notifier waits ≤8s for it on "finished" pushes only (needs-you
  never waits). `summaries` is created BEFORE the pane managers because they
  can broadcast during construction. Measured 1.5–2.6s on real sessions.
- **Parallel-safe sessions** (`server/worktrees.js`, `server/ship.js`,
  `git-status.ts`, `ship-panel.ts`). "Own branch" (new-session sheet's Branch
  row, the picker's checkbox → `POST /api/panes {worktree:true}`) runs `git
  worktree add -b fleet/<slug>` into `~/.fleetview/worktrees/<repo>/<slug>`
  and simply starts the pane THERE — branch/worktree/base are always DERIVED
  from the folder via git (`gitInfo`), the base lives in git config
  (`branch.<b>.fleetBase`), so the managers, the flip and restarts carry
  nothing new. Root `.env*` files are copied in and added to the repo's
  `info/exclude` — without that a copied .env counts as uncommitted work
  (Finish refuses forever) and is offered as a file to commit. node_modules is
  NOT copied. Terminal trust is inherited from the source repo only if that
  repo is already trusted (`isTrusted` → `trustFolder`), never granted fresh.
  Cleanup is only ever git's safe commands: closing a session keeps its
  branch; "Finish branch" = `worktree remove` (refuses uncommitted work) +
  `branch -d` ONLY when `merge-base --is-ancestor <branch> <base>` — `-d`
  alone also accepts "merged into upstream", i.e. any pushed branch. Ship:
  every git/gh call is execFile+argv; pushing the default branch is refused
  server-side; on the default branch the commit form offers a new branch
  (`check-ref-format`); a shared checkout pre-ticks only the session's own
  files (never "other" changes). Commit/PR text is drafted by `oneShot()`
  (auto-title.js, Haiku, no tools/settings/persistence), always editable.
  Overlaps = sessions grouped by git COMMON dir (so worktrees of one repo
  count together) whose transcripts edited the same repo-relative file; chip
  colour is `--use-warn`, never `--waiting`. Chips live in `.git-slot` (not
  `.badge-slot`) and are 18px so they never grow a title bar.
- **Settings outside-click uses `settingsBtn.contains(target)`** — the button
  holds an SVG, so `target === settingsBtn` closed the panel as it opened.
- **Account badges use `.acct-slot`, not `.badge-slot`.** They sit in the
  right-hand cluster beside ⚑. This is not cosmetic: `setWaiting()` does
  `badgeSlot.innerHTML = ""` on every attention change, so anything persistent
  parked there is destroyed the first time the pane says "needs you" and never
  returns. `.badge-slot` is for the transient attention badge only.
- **No emoji in chrome — control icons are inline SVG** (`client/src/icons.ts`,
  paths adapted from Feather, MIT). Two failed approaches are worth not
  repeating: colour emoji can't match a monochrome set (different weight, ~22px
  advance vs ~12px), and the Unicode replacements that followed (⊕ attach, ⚿
  secret) passed the test they were picked against — monochrome, not tofu — and
  failed the one that mattered: nobody could tell what they were. Unicode has no
  legible padlock or paperclip at 15px. SVG inherits `currentColor`, so hover /
  disabled / theme states need no icon-specific CSS. `‹ – ✕` stay as text:
  standard window controls, universally read. Adding a new icon means adding a
  path, not hunting for a character.
- **Usage rings** are a *meter* (one ratio against a limit), not a pie. The
  percentage is ALWAYS drawn as text in normal ink: status colour is the
  glanceable second cue, never the only one — which matters because the amber
  step is deliberately sub-3:1 on the light surface. Thresholds live in ONE
  ramp (`usageLevel()` in `chat-usage.ts`, used by `main.ts` and
  `agent-chat.ts`: crit ≥90, warn ≥75) and the colours are `--use-ok/warn/crit`, fixed rather than themed, and
  deliberately NOT `--waiting` — that already means "needs you", and one hue
  must not carry two meanings. A pane finds its row by `usageRow.id ===
  pane.cmd`; remote panes show none, since their agent bills another machine's
  account. Each window is its own bordered pill (same 28px box, 6px radius and
  `--line` border as the model badge) with its label BESIDE the ring, so the row
  reads as one set of chips and the two windows stay distinguishable without
  relying on colour.
- **The model badge** needs the only new server plumbing here: the SDK names the
  model *only* in its `init` frame, so `claude-driver.js` forwards it via
  `onModel`, `agent-manager.js` persists it and broadcasts `{t:"model"}`. Codex
  reports none, so the badge stays hidden rather than guessing.


Agent panes render Markdown, not terminal bytes, so a reply can carry real
structure instead of a wall of lines. Three things are worth knowing:

- **Charts.** A fenced ```chart block whose body is JSON renders as an inline SVG:
  `{"type":"bar|hbar|line|area|donut|stat","title":…,"labels":[…],"series":[{"name":…,"data":[…]}]}`.
  Shorthands work too (`"data":{"a":1,"b":2}`, `"data":[{"label":…,"value":…}]`).
  **Separately, every numeric Markdown table gets a "Chart" toggle for free** —
  that path needs no cooperation from the agent, so emitting a plain table is
  usually enough. An unparseable spec degrades to a visible code block.
- **Media.** `![alt](/tmp/plot.png)` — and even a bare `/tmp/plot.png` in prose —
  embeds as an image; `.mp4`/`.webm` become a `<video>`, audio a `<audio>`.
  Local paths are served by `GET /api/file`, which is extension-allowlisted to
  image/video/audio and responds under `default-src 'none'; sandbox`.
- **Readability.** Messages render in full, never clipped behind a "Show more"
  toggle — that was tried and removed. Text is deliberately NOT width-capped
  (see the note in `styles/chat.css`): capping prose while tables/charts stayed
  full-width made wide panes look misaligned.

⚠️ `markdown.ts`'s invariant is that raw model output NEVER reaches innerHTML
unescaped, and `charts.ts` builds every node with `createElementNS`. Keep both
that way. The categorical palette in `styles/base.css` (`--viz-1..8`) is validated as
an ordered set for colour-vision deficiency against each mode's chart surface —
re-run the check before changing a value or the order.

## Startup self-check (`server/self-check.js`)
A `git pull` updates neither `dist/` (gitignored) nor `node_modules`, which is
how "I pulled and restarted, nothing changed" happened on a second machine. So
before binding, `server/index.js` runs:
- `ensureDeps()` — top-level packages vs `package-lock.json`. On mismatch it
  runs `npm install` via npm's own CLI script next to the running node (PATH-
  independent: Homebrew keeps npm in its own lib dir behind a symlink — follow
  it), then **exits 75** so launchd KeepAlive / systemd Restart=on-failure
  restart into the new versions — Node has already loaded every module, the old
  SDK included, before any code runs, so only a fresh process picks them up.
  One attempt per lockfile (`~/.fleetview/deps-install-attempt`), so a failing
  install warns instead of crash-looping. `FLEET_AUTO_DEPS=0` disables it.
- `ensureFreshBuild()` — rebuilds `dist/` (vite run with this node) if it's
  missing or older than `client/`, `vite.config.ts` or the lockfile.
  `dist/.source-stamp` records what a self-check build covered, so source files
  with FUTURE mtimes can't make every start rebuild.
- `/api/version` reports the running server commit (captured at STARTUP, not
  per request — after a pull without a restart HEAD moves but the code doesn't)
  and `dist/build-info.json` (written by vite.config.ts's build-info plugin,
  also baked into the client as `__BUILD_INFO__`). The client's
  `checkVersion()` runs on every control-socket connect: a tab whose bundle
  predates the served one gets "FleetView was updated — tap to reload";
  dependency trouble gets "This machine needs npm install"; Settings → This
  machine shows the version.

### Auto-update (`server/auto-update.js`)
Each machine runs its own checkout, so a change used to reach the second
machine only after a manual pull + restart. Now, under the auto-start service
ONLY (launchd `com.fleetview.server` / a systemd service — exiting a hand-run
`npm start` would just stop it), the server `git fetch`es every
`FLEET_AUTO_UPDATE_MINUTES` (5) and, if a FAST-FORWARD is available on a CLEAN
checkout (no tracked edits, no local commits — a dev machine is never touched),
waits until every pane has been idle (not working, not waiting on an
approval/answer) for 2 minutes, then `merge --ff-only`, writes a snapshot and
exits 75 → the supervisor restarts it → the self-check above handles deps and
the bundle → tabs get the "updated" chip. It never stashes/resets/merges.
`FLEET_AUTO_UPDATE=0` disables; status in `~/.fleetview/auto-update.json`,
`/api/version.autoUpdate`, Settings → This machine. The GATE is a separate
process that read its files once at startup (why the app's sign-in handoff was
missing on a second machine): it now polls its own files' mtimes and exits 75
when they change, IF supervised — otherwise it only logs.

## Gotchas
- `index.js` hardcodes `sessions.json`/`layouts.json`/`tasks.json` under repo ROOT.
  **Do NOT boot a real server for a test** — it reads/writes those live files (and
  reattaches real tmux sessions). Test modules directly with isolated temp files.
- `sessions.json`, `layouts.json`, `tasks.json`, `dist/`, `node_modules/` are
  gitignored local state — they regenerate; a fresh clone starts empty.
- Restarting the server reattaches tmux sessions, but an already-open browser tab
  must be refreshed to load new client code. This bites constantly: the server can
  be serving a brand-new bundle while the tab in front of you still runs the old
  one, so "the change didn't work" is usually "the tab wasn't reloaded". Confirm
  what's actually being served with
  `curl -s localhost:4280/ | grep -oE 'assets/index-[^"]+'`.
- **`npm run service:install` fully REPLACES the baked env every time it runs —
  nothing carries over from the plist it's overwriting.** `scripts/install-service.js`
  only bakes `FLEET_PORT`/`FLEET_HOST`/`FLEET_ALLOWED_HOSTS`/`FLEET_LABEL`/
  `FLEET_ICON_COLOR`/`FLEET_PUSH_CONTACT` from whatever's in *your current shell*
  at the moment you run it. Re-running it from a plain shell (no exports) silently
  drops all of them, even if a previous install had them set. The concrete failure
  mode on a `tailscale serve`-fronted machine: `FLEET_ALLOWED_HOSTS` gets dropped →
  `server/index.js`'s same-origin/CSRF guard (`sameOrigin()`, ~line 253) rejects the
  tailnet `Host` header it now sees from the proxy → every request 403s with
  `"forbidden: cross-origin"`, even though the server is up and healthy. Fix:
  always re-supply every var you need on the same command line, e.g.
  `FLEET_ALLOWED_HOSTS=<tailnet-host> FLEET_LABEL=<name> npm run service:install`.
  Sanity-check what actually landed with
  `grep -A1 FLEET_ALLOWED_HOSTS ~/Library/LaunchAgents/com.fleetview.server.plist`
  (macOS) or the systemd unit's `Environment=` lines (Linux).
- **A `tailscale serve`-fronted install is TWO independent services, not one** —
  `com.fleetview.gate` (`server/gate.js`, default port 4290, what Tailscale actually
  proxies to) and `com.fleetview.server` (`server/index.js`, default port 4280, the
  real app; the gate reverse-proxies to it). Either can be up while the other is
  down, and the symptoms don't obviously point at which: app server down but gate up
  → gate returns its own "FleetView is unreachable through the gate" 502 (or, before
  a fix landed in `c2d79a7`, the gate itself could crash-loop on that condition — a
  failed WebSocket-upgrade proxy hands `proxy.on("error")` a raw `net.Socket` instead
  of an `http.ServerResponse`, and calling `.writeHead()` on it threw uncaught and
  took the whole gate process down on every reconnect attempt). A blank/white tab or
  a gate-branded error means: check `com.fleetview.gate` AND `com.fleetview.server`
  (or the Linux systemd equivalents) SEPARATELY — `launchctl list | grep fleetview` /
  each one's own log (`~/Library/Logs/fleetview*.log` on macOS) — don't assume "the
  server" is one process.

## Conventions
- Small, single-purpose modules; match the surrounding style and comment density.
- Commit only when asked; branch off `main` for non-trivial work.
