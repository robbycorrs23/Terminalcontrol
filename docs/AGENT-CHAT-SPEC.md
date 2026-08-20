# Chat View — fork handoff spec

**What this is.** A description of the "chat view" (internally `agent-chat`) that this
fork adds to FleetView, written for the upstream owner deciding whether and how to take
it. It covers the model, the wire protocol, every integration point with existing
FleetView code, and the known gaps.

**Scope.** 6 commits, `c0f3009..f26b46c` (2026-08-12 → 2026-08-19):
`26 files changed, 4941 insertions(+), 231 deletions(-)` (≈1000 of the insertions are
`package-lock.json`). One new runtime dependency.

| Commit | Subject |
|---|---|
| `6bb3bfa` | feat(client,server): mobile agent-chat view for claude/codex panes ← landing commit |
| `d36a5b3` | fix(client): mobile top-bar overflow + compact agent-chat tool-call groups |
| `49b4f18` | fix(client): decouple `#bar`'s safe-area padding from its flex row |
| `76db43d` | feat(client): work-account badge for agent-chat panes; serve index.html no-store |
| `9e4acb1` | fix(client): stop agent-chat from double-connecting on reconnect |
| `1ee35ff` | feat(agent-chat): AskUserQuestion answer UI, markdown, richer tool output; fix work-account binding |
| `f26b46c` | feat: pane snapshots, transcript-based agent chat recovery, working indicator |

---

## 1. The idea in one paragraph

A FleetView box normally is a PTY: a tmux-backed shell running `claude`, rendered through
xterm.js. That's excellent on a desktop and miserable on a phone — a TUI in a 390px
viewport, no native scrolling, approval prompts you have to hit with arrow keys. **Chat
view replaces the terminal emulator with a chat UI for agent panes only.** Instead of
spawning a shell that runs the CLI, the server drives the agent programmatically (Claude
via `@anthropic-ai/claude-agent-sdk`, Codex via `codex app-server --stdio`), normalizes
everything it emits into one small event union, and streams that to a DOM-rendered
conversation: message bubbles, collapsible tool cards, tap-to-approve permission buttons,
and a real answer UI for `AskUserQuestion`. Same grid, same zoom, same attention system,
same top bar — only the inside of the box changes.

**Both pane types coexist.** Nothing about the PTY path is removed or rerouted. A user
picks per-pane at creation time.

---

## 2. Pane kinds

`PaneInfo` gains a `kind: "pty" | "agent"` field. It is persisted, returned by every
pane-listing API, and is the single discriminator throughout:

| Layer | Branch point |
|---|---|
| Creation | `POST /api/panes` body gains `kind`; `pane-registry.js:34` → `agents.create` vs `ptys.create` |
| Live socket | `/agent?pane=<id>` vs `/term?pane=<id>` (`server/index.js:496-502`) |
| Client view | `main.ts:107` — `info.kind === "agent" ? new AgentChat(info, host) : new Term(info, host)` |
| Persistence | `agent-sessions.json` vs `sessions.json` |

### Deliberate asymmetries between the two kinds

| | PTY pane | Agent pane |
|---|---|---|
| Process | detached `fleet_<id>` tmux session | in-process SDK driver / `codex app-server` child |
| Survives server restart | **yes** (tmux) | **no** — driver dies; metadata + conversation are recovered instead (§6) |
| Dormant/respawn tier | yes | **none** — `setAside` kills the pane (`pane-registry.js:38-49`) |
| Attention source | `curl` hooks → `POST /hook` | driver `status` events, in-process |
| `setWorking` | shell hook driven | no-op — working state comes from driver status |
| Startup command | `cmd` typed into the shell via `send-keys` | `cmd` **interpreted** server-side (provider + account) |

That last row is the one most likely to surprise: for a PTY pane `cmd` is an opaque string
handed to a shell, so `claude-work` needs a user-supplied alias on `PATH`. For an agent
pane the same string is parsed — `codex`-prefix picks the driver, `-work`-suffix picks the
account config dir.

---

## 3. New modules

### Server
| Path | Lines | Responsibility |
|---|---|---|
| `server/agent-manager.js` | 477 | Owns agent panes. Mirrors `PtyManager`'s method surface (`create/kill/attach/list/info/reorder/setAttention/setColor/setName/setLastInput/…`) so `index.js` routes don't branch. Adds `sendMessage`, `approve`, `answer`, `setMode`. |
| `server/agents/claude-driver.js` | 262 | `startClaudeSession()` — wraps the Agent SDK's `query()`; maps SDK messages → `AgentEvent`s. |
| `server/agents/codex-driver.js` | 283 | `startCodexSession()` — spawns `codex app-server --stdio`, hand-rolled newline-JSON RPC; maps notifications → the same `AgentEvent`s. |
| `server/agents/event-schema.js` | 35 | JSDoc typedef of the event union. No runtime exports — documentation that typechecks. |
| `server/pane-registry.js` | 65 | Façade over `(ptys, agents)`. `ownerOf(id)` dispatches by which manager's `info()` answers. |
| `server/transcript.js` | 124 | Rebuilds a Claude pane's chat log from the SDK's on-disk `<configDir>/projects/*/<sdkSessionId>.jsonl`. |
| `server/snapshot.js` | 138 | Point-in-time dump of every pane (also written on SIGTERM/SIGINT/SIGHUP). |

### Client
| Path | Lines | Responsibility |
|---|---|---|
| `client/src/agent-chat.ts` | 840 | `class AgentChat implements PaneView` — the whole chat UI. |
| `client/src/agent-events.ts` | 34 | TS mirror of `event-schema.js`. Types only. |
| `client/src/markdown.ts` | 152 | Dependency-free Markdown → sanitized HTML. |
| `client/src/attach.ts` | 118 | File drop/picker plumbing, extracted from `terminal.ts` so both views share it. |

### Dependency
Exactly one: `@anthropic-ai/claude-agent-sdk` `^0.3.229`. **Codex adds no dependency** —
it talks to the `codex` binary already required for Codex panes.

---

## 4. The event schema

One normalized union, discriminated on `t`, defined twice (`server/agents/event-schema.js`
and `client/src/agent-events.ts` — hand-mirrored, no codegen, the same convention `PaneInfo`
already uses). **The client never learns which provider backs a pane.**

| `t` | Fields | Notes |
|---|---|---|
| `user` | `id`, `text` | Emitted by the driver's own `send()`, so the bubble is server-authoritative (no local echo). |
| `assistant_delta` | `id`, `delta` | Codex only. |
| `assistant_done` | `id`, `text` | One per text block; a reply can be several. |
| `tool_call` | `id`, `name`, `input` | |
| `tool_result` | `id`, `output`, `isError`, `diff?` | `diff` is Codex-only today. |
| `permission_request` | `requestId`, `tool`, `input`, `title?`, `description?` | Gates whether a tool may run. |
| `permission_resolved` | `requestId`, `decision: allow\|deny\|always` | |
| `question` | `requestId`, `questions: AgentQuestion[]` | Claude only — `AskUserQuestion`. Needs a human *choice*, not just consent. |
| `question_resolved` | `requestId`, `answers: Record<string,string>` | |
| `status` | `state: idle\|working\|waiting_permission\|error`, `detail?` | |
| `mode` | `mode: default\|acceptEdits\|auto\|plan\|bypassPermissions` | Claude only. |

`AgentQuestion = { question, header, multiSelect, options: {label, description?}[] }`.

The union is deliberately narrow: driver `default:` branches drop everything else. Adding a
provider means writing one `start*Session()` that emits these eleven shapes — no client change.

---

## 5. Wire protocol — `/agent?pane=<id>`

**Server → client.** Two envelopes only:
- `{ t: "replay", events: AgentEvent[] }` — once on attach, the whole ring buffer.
- `{ t: "ev", ev: AgentEvent }` — every event thereafter.

**Client → server.** Five shapes, all validated:
- `{ t: "send", text }`
- `{ t: "approve", requestId, decision }`
- `{ t: "answer", requestId, answers }`
- `{ t: "interrupt" }`
- `{ t: "setMode", mode }`

There are **no HTTP routes** for chat traffic. Everything conversational is WS-only; the
REST surface only creates/kills/renames/reorders panes and is kind-agnostic via the registry.

Attach order (`agent-manager.js:260-302`) matters: hydrate from transcript → ensure driver →
add socket to `pane.clients` → send `replay` → wire handlers. Hydration must precede driver
start so the driver's opening `mode` event lands *after* restored history rather than being
swallowed by the "ring is empty" guard.

---

## 6. Durability model

This is the part most worth reading before adopting, because it differs from tmux panes
in kind, not degree.

An agent pane's state has three layers:

1. **Conversation (durable).** `sdkSessionId` is persisted in `agent-sessions.json`.
   `_ensureDriver` passes it as `resume`, so the model remembers everything.
2. **Visible log (memory-only).** `pane.events` is a 300-entry ring, never persisted. After a
   restart the box would come back blank even though the model remembers.
3. **Recovery.** `_hydrateFromTranscript` refills the ring from the SDK's on-disk JSONL on
   first attach — once per process, only when the ring is empty, so it can never race live
   events. **Claude only**; a restarted Codex pane comes back with an empty log (its
   `~/.codex/sessions` layout wasn't worth guessing at).

> **Mirroring contract.** `transcript.js`'s mapping mirrors `claude-driver.js`'s
> `handleMessage` exactly — same event names, same id fields (`d.uuid` for assistant text,
> `b.id` for `tool_use`, `b.tool_use_id` for `tool_result`). Change one, change the other, or
> replayed history diverges from live history. `stringifyBlockContent` is duplicated in both
> files for the same reason.

Drivers start **lazily** — never at boot. On restart panes are metadata with
`status: "disconnected"`; the driver spins up on first attach or first message. This keeps a
server restart from resurrecting twenty agents at once.

Restarting the server kills every agent pane's live driver — including, if you're working
from inside one, your own session. `SIGTERM/SIGINT/SIGHUP` write a snapshot first, and
`npm run snapshot` captures state externally (REST + tmux + on-disk transcripts) so it works
against an old server or none at all.

---

## 7. Client rendering model

`AgentChat` builds the same outer DOM as `Term` — `.cell > .term > .title + .cwdline +
.pinned + <body>` — so `main.ts`'s grid, zoom, tray, drag, chip, and attention code needed
**no changes**. Only the body differs: `.chat > .chat-log + .status-line + .chat-input`
instead of `.xt`.

- **Bubbles.** `.msg.user` is a right-aligned accent bubble rendered with `textContent`.
  `.msg.assistant` is deliberately *not* a bubble (stretched, no chrome) because one reply
  arrives as several `assistant_done` events and stacked bubbles looked broken. Only
  assistant text goes through `renderMarkdown`.
- **Tool cards.** Each `tool_call` is a collapsed `<details>` summarized as `🔧 Bash · npm run
  build` — the detail line picks the first non-empty of `command/file_path/path/pattern/url/
  query/prompt`, so it's provider-agnostic. Consecutive calls collapse into one
  `.tool-group` (`🔧 4 tool calls: Read, Edit, Bash, …`), broken by any bubble, permission,
  or question. An error propagates its class up to the group so failures aren't hidden
  behind a collapsed summary.
- **Permission cards.** Deny / Allow / Always Allow, `min-height: 40px` touch targets.
  `always` maps to the SDK's own `updatedPermissions` suggestions (session-scoped) rather
  than an invented allow-list.
- **Question cards.** Single-select auto-submits on tap; multi-select waits for Submit; an
  `✎ Other…` write-in is always offered. Answers are keyed by **question text** and
  comma-join labels for multi-select — the exact shape the tool echoes back.
- **Markdown.** Hand-rolled, ~150 lines, no `marked`/`DOMPurify`. Invariant: raw source never
  reaches `innerHTML` un-escaped. Inline code is extracted behind `\x00N\x00` markers first,
  `esc()` runs before any tag is layered on, and link hrefs are scheme-checked against
  `^(https?:|mailto:)`. Supports fences, headings, rules, quotes, flat lists, and inline
  code/link/bold/italic/strike. Justified by the dependency-light policy and a CSP that
  forbids external anything.
- **Reconnect.** `ws.onclose` checks `this.ws === ws` before scheduling a retry — without it
  a manual `reconnectNow()` leaves the old socket's async `onclose` scheduling a *second*
  connection, and every message renders twice. Same fix `Term.connect()` already carries.

---

## 8. Integration points with existing FleetView code

Things upstream would be touching, not just adding:

1. **`PaneInfo.kind`** — new field, threaded through create/list/info and layout slots
   (`slot.kind ?? "pty"`).
2. **`server/index.js`** — construct `AgentManager` + `createRegistry`; every pane route
   switched from `ptys.*` to `registry.*`; `/agent` branch in `handleUpgrade`. `attach` and
   the tmux surface stay direct on `ptys` on purpose.
3. **`registry.setWorking(id, on)`** is an optional-call (`?.`) because agent panes don't
   have one — the `/hook/prompt` route hits this.
4. **`client/src/main.ts`** — the `AgentChat` vs `Term` branch, plus the picker's Chat view
   checkbox and `chatViewAvailable()`.
5. **`client/src/terminal.ts`** — `PaneView` became a real shared interface; `workingOverlay()`
   / `setBusyClass()` were extracted so both views share them; attach plumbing moved to
   `attach.ts`.
6. **`#bar` restructure** (`49b4f18`) — safe-area padding was split onto `#bar` with the flex
   row moved into `#barRow`, because sharing an element made the top edge drift on
   notch/Dynamic-Island phones. `--bar-h` is measured at runtime, not assumed to be 40px.
   This is a general mobile fix, independent of chat.
7. **CSS** — +759 lines, all namespaced under new classes except the `#bar`/mobile-grid
   changes above. The rule that makes collapsed mobile cards work is
   `.term:not(.zoomed) .xt, .term:not(.zoomed) .chat { display: none }`.
8. **`.gitignore`** — add `agent-sessions.json`.

Chat panes hold **two** sockets: their own `/agent` for conversation and a share of the
window's `/control` for pane metadata. `recoverConnections()` re-establishes both after
sleep/bfcache/offline.

---

## 9. The "work account" concept (separable)

Orthogonal to chat view, but entangled with it in these commits, so flagging it explicitly:
this fork runs two CLI accounts (personal + work) side by side, selected by a `-work` suffix
on `cmd` and isolated by config dir.

- `accountConfigDirFor(cmd, provider)` → `~/.claude-work` / `~/.codex-work`, or `null`.
- `_buildEnv` starts from `process.env`, **deletes** inherited `CLAUDE_CONFIG_DIR`,
  `CODEX_HOME`, and `ANTHROPIC_API_KEY` (a stray key silently flips subscription billing to
  pay-per-token), then sets the one var the pane asked for.
- The dir is **derived, never persisted** — storing it meant restored work panes silently ran
  on the personal account after a restart, with resume failing because the transcript lived
  in the other account's `projects/`.
- Resume ids are validated against the owning account's `projects/` and dropped if absent — a
  resume id only means something to the account that wrote it.

**If upstream doesn't want two accounts**, drop the two `(work)` picker options, the
`.work-badge`, and `accountConfigDirFor`, and hardcode `accountConfigDir = null`. Nothing
else in the chat path depends on it. The `_buildEnv` deletions are worth keeping regardless.

Also present in this fork but strictly separate: a WebAuthn/passkey gate (`server/gate*.js`,
`9b03d52`, pre-dates chat). It matters to chat only in that `proxy.ws` must be enabled and
unauthenticated upgrades are socket-destroyed. There is one uncommitted change in
`gate-session.js` shortening the session cookie from 30 days to 24h (`FLEET_GATE_SESSION_HOURS`)
— gate-only, unrelated to chat.

---

## 10. Known gaps and rough edges

Honest list. None are blocking, all are cheap.

**Functional**
1. **No interrupt UI.** The server handles `{t:"interrupt"}` and both drivers implement it,
   but nothing in the client ever sends it. A chat pane has no softkeys and no PTY, so a
   running turn **cannot be cancelled from the UI at all.** One button in `.status-line`
   closes this — top of the list.
2. **`waiting_permission` doesn't glow the box.** The self-driven `status` path and the
   server-driven `attention` path aren't unified, so a pending permission shows the status
   line but doesn't set `.waiting` or enter the attention queue unless the server separately
   emits an `attention` frame.
3. **`assistant_delta` + `assistant_done` would double-render.** `assistant_done` appends a
   fresh bubble instead of finalizing the streaming one. Latent — no driver emits both today.
4. **`refit()` scrolls unconditionally to the bottom**, and `main.ts` calls `refit()` on every
   pane on every reflow, so unrelated grid activity yanks you out of scrollback.

**Provider parity (Codex)**
5. No permission-mode equivalent (selector hidden), no `AskUserQuestion` equivalent, no
   transcript hydration, no resume-id validation. Tool vocabulary is synthetic — only `Bash`
   and `Edit`, mapped from `commandExecution`/`fileChange`.
6. Claude never emits `tool_result.diff` — explicitly deferred past the MVP bar. Codex does.

**Cosmetic / hygiene**
7. `reorder` numbers `order` per-manager, so two panes of different kinds can tie after a
   mixed drag-reorder (documented at `pane-registry.js:14-23`).
8. `.mode-sel` isn't hidden on collapsed mobile cards, unlike the other decluttered controls.
9. `body.big` (large text) has no chat rules — it doesn't scale bubbles or tool cards.
10. `.term.agent` class is set but no selector uses it. Stale `.work-badge` CSS comment.
11. `_hydrated` is set before the read succeeds, so a momentarily unreadable transcript is
    never retried for the process lifetime.
12. The attach-time driver-error status bypasses the ring buffer — it reaches only the
    attaching socket and vanishes on reconnect.

**Docs.** `README.md` and `CLAUDE.md` were only partially updated. Missing from the layout
table: `agent-manager.js`, `agents/*`, `pane-registry.js`, `agent-chat.ts`, `agent-events.ts`,
`markdown.ts`. Missing from the invariants: the `/agent` socket and `agent-sessions.json`.
Stale: CLAUDE.md still says the picker chooses "claude / codex / plain shell" (omits both
`(work)` options and the Chat view checkbox); README still describes an "untick run claude"
checkbox that no longer exists.

---

## 11. Suggested adoption path

The change is additive and layered, so it can land in stages:

1. **`pane-registry.js` + `PaneInfo.kind`** alone. Pure refactor, no behavior change — every
   route goes through the façade with `agents` stubbed empty.
2. **`agent-manager.js` + `claude-driver.js` + the event schema + `/agent` socket.** Server
   can drive a Claude session; nothing renders it yet. Testable with a throwaway WS client.
3. **`agent-chat.ts` + `agent-events.ts` + `markdown.ts` + CSS + the picker checkbox.**
   Feature is usable.
4. **`transcript.js` + snapshot** — the durability half. Worth doing before real use; without
   it every restart leaves a wall of empty boxes.
5. **`codex-driver.js`** — optional, self-contained.
6. **Work accounts** — optional, drop if not wanted (§9).

**Verification.** There's no test framework here, and `vite build` doesn't typecheck — run
`npm run typecheck` separately. Exercise modules with throwaway Node scripts against temp
state files and unique ports; never boot a real server for a test, since `index.js` hardcodes
the state files under the repo root and will reattach live tmux sessions. Take
`npm run snapshot` before anything that bounces the server.
