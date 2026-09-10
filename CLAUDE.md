# FleetView — agent guide

A single browser window holding a **grid of real terminals** (one `node-pty` shell
per box), each typically running `claude` or `codex`. Click a box to zoom it; when
an agent needs approval or finishes, its box glows/dings and a chip appears in the
top bar. Local-only tool: a Node server on `localhost` spawns the shells.

## Prerequisites (on any machine that runs this)
- **Node.js** (project uses ESM; `node-pty` ships prebuilds for macOS/Linux x64/arm64).
- **tmux** — *strongly recommended*. Terminals run inside `fleet_<id>` tmux sessions
  so they survive server restarts/crashes. Without it, shells die with the server.
  Install: `brew install tmux` / `apt install tmux`.
- **curl** — the Claude Code hooks use it to phone home. Usually preinstalled.
- **`claude`** (Claude Code CLI) and/or **`codex`** (Codex CLI, `npm install -g
  @openai/codex`) — for the per-box agents. The picker's "run on open" select
  chooses **claude (work) / codex (work) / plain shell**, plus an SSH optgroup;
  a "💬 Chat view" checkbox decides whether the box becomes a chat pane or a
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
- `npm start` — start the server without rebuilding.
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
| `client/src/charts.ts` | dependency-free SVG charts (bar/hbar/line/area/donut/stat) |
| `client/src/push.ts` / `client/public/sw.js` | Web Push subscribe/badge / the service worker that shows notifications |
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
- **Work accounts only on this install.** The personal `claude`/`codex` logins
  live on another machine, so the two personal picker options are gone and
  `isAgentProfile()` (`client/src/main.ts`), `knownAccounts()` (`server/usage.js`)
  and `AGENT_PROFILES` (`server/pane-registry.js`) each list ONLY
  `claude-work`/`codex-work`. Defaults follow (`pty-manager.js`'s startup
  fallback, `index.js`'s layout-restore fallback, the picker's `selected`
  option). The server still keys the account purely off the `-work` SUFFIX
  (`accountConfigDirFor`), so re-adding a personal account means re-adding
  those list entries, not rewriting the mechanism. `~/.claude`/`~/.codex` are
  untouched — nothing here deletes a login, it just stops offering it.
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
  Notification text is pane name + kind only: no cwd path, command, or prompt
  text reaches a lock screen. Payloads are RFC 8291 encrypted, so the push
  service relays ciphertext it can't read.
- **Per-machine identity** (`server/identity.js`): `FLEET_LABEL` +
  `FLEET_ICON_COLOR` name and colour this machine, because one-workspace-per-
  machine means several installs coexist and identical tiles full of real shells
  are a hazard. The manifest is **generated**, not a static file, and
  `/icon-*.png` + `/apple-touch-icon.png` are ROUTES registered *before*
  `express.static` — so the colour is a server-side choice and the URLs stay
  constant (nothing in `index.html`, `sw.js` or `gate.js`'s allowlist knows
  about palettes). Icon PNGs are committed artifacts under
  `client/public/icons/<colour>/`, regenerated by `scripts/make-icons.sh`, never
  at build time. iOS caches name+icon at install, so changes need a re-add.

## Rich chat view (agent panes)

- **The tools row** (`.chat-tools`, between `.chat-log` and `.chat-input`) is the
  one home for pane-level controls: attach / view-flip / secret / permission
  mode on the left, model badge + jump-to-latest + stop + usage rings on the
  right. Four of those MOVED here from the title bar or the input bar, so:
  `.mode-sel`'s CSS had to be re-scoped off `.term .title`; the work/remote
  badges re-anchored to `.badge-slot` (they used to hang off `.mode-sel`);
  `main.ts`'s `flipView()` looks up `.view` on `t.el`, not `t.titleBar`
  (terminal panes still keep theirs in the title bar); the secret popover gets
  `.spop.up` because its anchor is now at the BOTTOM of the box, with a
  `max-height` guard since `.term` is `overflow:hidden` and would otherwise clip
  it in an unzoomed grid box; and `.chat-tools` had to join the click-to-zoom
  exclusion list alongside `.ctl`/`.chat-input`.
- **On mobile the row collapses behind `☰`** in the composer (`.chat-menu`,
  phone-only), opening as a WRAPPED row above the input rather than a floating
  popover — `.term` is `overflow:hidden` and would clip one. One exception:
  while the pane is busy the ■ stays visible outside the menu
  (`.term.busy:not(.tools-open)`), because a control you need urgently must not
  be two taps away. ⚠️ The `.term .ctl { width:44px; height:40px }` mobile
  touch-target rule at ~line 950 is DEAD — it precedes the base `.term .ctl`
  rule (~1252) at equal specificity, and a media query adds none, so source
  order overrides it and icon buttons render 20×18 on phones. Only
  `.ctl.attach` escapes, via the extra class. The tools row re-states the
  sizing at a winning specificity; the general case is still broken.
- **Stop (■)** sends `{t:"interrupt"}`, which the server and both drivers always
  understood — nothing had ever sent it, so a chat pane could not cancel a
  running turn at all. Visible only while the pane is working (`setBusy`).
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
  ramp (`usageLevel()` in both `main.ts` and `agent-chat.ts`: crit ≥90, warn
  ≥75) and the colours are `--use-ok/warn/crit`, fixed rather than themed, and
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
  (see the note in `styles.css`): capping prose while tables/charts stayed
  full-width made wide panes look misaligned.

⚠️ `markdown.ts`'s invariant is that raw model output NEVER reaches innerHTML
unescaped, and `charts.ts` builds every node with `createElementNS`. Keep both
that way. The categorical palette in `styles.css` (`--viz-1..8`) is validated as
an ordered set for colour-vision deficiency against each mode's chart surface —
re-run the check before changing a value or the order.

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
