# ▦ FleetView

A single browser window holding a **grid of real terminals**. Click one and it
flies to the center of the screen; click the dimmed background (or press `Esc`)
and it flies home. Run a `claude` in each box — when one **needs your approval or
asks a question**, its box glows and dings, and a chip appears in the top bar so
you can jump straight to it.

It's a local tool: the server spawns real shells on your machine (macOS or Linux,
via `node-pty`) and binds to `localhost` only — it's not meant for the cloud or a
shared network. See [Security](#security) before changing that.

## Quick start

```bash
npm install      # builds node-pty (native) and pulls xterm/vite
npm run go       # build the client, then start the server
```

Open **http://localhost:4280**. Click **+ Terminal**, pick a folder, and a shell
opens there running `claude` (untick "run claude" for a plain shell).

To run on a different port: `FLEET_PORT=5000 npm run go`.

## Security

FleetView spawns **real shells with no authentication**: anything that can reach
its port can run arbitrary commands on the host. To contain that, the server
**binds to `127.0.0.1` (loopback) by default**, so only programs on this machine
can connect.

Do not expose it to a network. If you knowingly need LAN access (trusted,
firewalled network only), opt in explicitly:

```bash
FLEET_HOST=0.0.0.0 npm run go   # reachable from the network — you accept the risk
```

It prints a warning when bound to anything other than loopback. There is still no
auth, so put it behind a VPN/SSH tunnel/reverse proxy if you go this route.

## Interactions

- **Open a terminal** — `+ Terminal` opens an in-browser folder browser: drill in
  with breadcrumbs, **search** the current folder, **sort** by name / last edited /
  last created, **create a folder** (`+ Folder`), one-click **recent folders**, and
  **★ Start** to pin the folder the picker opens to by default. Then it spawns the
  shell. Sort choice and default folder persist in `layouts.json`.
- **Zoom** — click a box to fly it to center over a dimmed scrim; click the scrim
  or press `Esc` to send it home.
- **Minimize** — the `–` control shrinks a box to a chip in the bottom tray (its
  Claude keeps running); click the chip to restore. The grid reflows to fill.
- **Close** — the `✕` control kills that shell.
- **Drag to rearrange** — grab a box by its title bar and drop it onto another
  slot to reorder the grid.
- **Appearance** — `☀/☾` toggles light/dark, `A⁺/A−` toggles large text. Both
  persist (localStorage) and apply to the terminals and UI live.
- **Layouts** — `Save layout` records this window's terminals (folders + order);
  `Open` respawns a layout and asks whether to **add** it to the current window or
  **replace** what's open. Stored in `layouts.json`. When a layout is the window's
  current one (shown as `▣ name` in the bar), **dragging to reorder auto-saves**
  the new order back to it.

## Windows & sessions

Each browser window is an independent workspace (a "session", kept in
`sessionStorage`). A **refresh reconnects** to that window's terminals; a **new
window starts empty** so you can run a different layout in each window. Terminals,
dings, and the attention queue are scoped per window; layouts are shared across
all windows (saving one updates every window's dropdown live).

## How the alerting works (no output scraping)

Each terminal is spawned with a unique `FLEET_PANE_ID` in its environment. On
first run, FleetView merges two **Claude Code hooks** into `~/.claude/settings.json`:

- **Notification** → POSTs `{pane, kind:"question"}` to the server (Claude needs you)
- **Stop** → POSTs `{pane, kind:"done"}` (Claude finished its turn)

So Claude tells FleetView *exactly* which box needs attention — nothing is parsed
from the terminal text. The hook commands are guarded with
`[ -n "$FLEET_PANE_ID" ]`, meaning they're a **no-op in any shell that isn't a
FleetView terminal**.

### Removing the hooks

Open `~/.claude/settings.json` and delete the two hook entries whose `command`
contains `FLEET_PANE_ID` (under `hooks.Notification` and `hooks.Stop`).

## What persists

- **Browser refresh / reopen** while the server is up → reconnects to the *same*
  live shells (your Claude sessions keep running, screen repainted from scrollback).
- **Server restart / crash / reboot** → if **tmux** is installed, each shell runs
  inside a `fleet_<id>` tmux session that outlives the server, and FleetView
  **reattaches** on the next start (pane metadata is kept in `sessions.json`). The
  inner tmux is made transparent — no status bar, no prefix key, low escape-time —
  so Claude's TUI behaves normally. Without tmux, shells are tied to the server
  process and a restart loses them.
- **Layouts** are stored in `layouts.json`; window order in `sessions.json`.

> Install tmux for durable terminals: `brew install tmux`. The startup log says
> whether terminals are tmux-backed.

## Architecture

```
Browser (one tab)                    Node server (localhost:4280)
  grid of xterm.js boxes  ──WS /term──►  PtyManager  → one node-pty shell per box
  FLIP zoom-to-center                    LayoutStore → layouts.json
  attention queue/glow/sounds ◄─WS /control─ grid events (created/closed/attention)
                                       POST /hook  ◄── Claude Code hooks
```

| File | Responsibility |
|------|----------------|
| `server/pty-manager.js` | spawn/kill shells, pipe bytes, scrollback, attention state |
| `server/layout-store.js` | read/write named layouts + recent folders |
| `server/fs-browse.js` | list sub-directories for the folder picker |
| `server/setup-hooks.js` | idempotently install the guarded Claude Code hooks |
| `server/index.js` | HTTP + WebSocket wiring, REST + hook endpoint, static client |
| `client/src/terminal.ts` | one xterm box bound to one PTY socket |
| `client/src/main.ts` | grid, zoom, minimize/tray, drag-reorder, folder picker, queue |
| `client/src/sound.ts` | generated alert tones (WebAudio) |
