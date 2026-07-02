import * as pty from "node-pty";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import os from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";

const SHELL =
  process.env.SHELL ||
  (process.platform === "win32" ? "powershell.exe" : "/bin/zsh");

// How much recent terminal output to retain per pane so a reconnecting browser
// can repaint the screen (scrollback) without the live process noticing.
const SCROLLBACK = 256 * 1024;

// Find a usable tmux. When present, shells run *inside* tmux so they survive the
// FleetView server restarting/crashing — we just reattach. Without tmux we fall
// back to spawning shells directly (they die with the server, as before).
function findTmux() {
  for (const c of ["tmux", "/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"]) {
    try {
      execFileSync(c, ["-V"], { stdio: "ignore" });
      return c;
    } catch {}
  }
  return null;
}

/**
 * Owns the terminals. With tmux, each pane is a detached tmux session named
 * `fleet_<id>`; the pane's pty is a `tmux attach` bridge to it. Pane metadata is
 * persisted so that on restart we reattach to any sessions still alive.
 *
 * A pane is either **active** (live tmux session + bridge pty) or **dormant**
 * (metadata kept, no bridge — recoverable via `respawn`). Panes become dormant
 * when their tmux session vanishes unexpectedly (e.g. the tmux server is torn
 * down across a long system sleep) or when a layout "Replace" sets them aside.
 * This is deliberate: losing a pane's metadata means losing the ability to bring
 * the terminal back, so we never silently drop a pane the user didn't close.
 *
 * Emits:
 *   "attention" (paneId, kind)
 *   "exit"      (paneId, session)            — pane closed for good (user × )
 *   "died"      (paneId, session, info)      — pane became dormant (recoverable)
 */
export class PtyManager extends EventEmitter {
  constructor(port, stateFile) {
    super();
    this.port = port;
    this.panes = new Map();
    this.dormant = new Map();
    this.seq = 0;
    this.stateFile = stateFile;
    this.tmuxBin = findTmux();
    this.tmux = !!this.tmuxBin;

    // Keep the tmux server's socket on a STABLE path under the user's home, not
    // the default one in /tmp. macOS periodically sweeps /tmp and wipes it on
    // some power transitions, which would orphan/kill the tmux server and take
    // every terminal with it — exactly the failure dormant panes recover from.
    this.sock = null;
    if (this.tmux) {
      const dir = join(os.homedir(), ".fleetview");
      try {
        mkdirSync(dir, { recursive: true });
      } catch {}
      this.sock = join(dir, `tmux-${port}.sock`);
      // Make the inner tmux transparent + snappy for TUIs like Claude Code.
      spawnSync(this.tmuxBin, this._tx(["start-server"]), { stdio: "ignore" });
      spawnSync(this.tmuxBin, this._tx(["set-option", "-g", "escape-time", "10"]), { stdio: "ignore" });
      this._restore();
    }
  }

  // Prefix tmux args with a socket so the invocation targets the right server.
  // New panes use the stable socket (`this.sock`); panes restored from a prior
  // run keep whatever socket they were created on (a legacy `null` = tmux's
  // default /tmp socket), so an upgrade reattaches old sessions instead of
  // abandoning them. Without tmux this is never called.
  _tx(args, sock = this.sock) {
    return sock ? ["-S", sock, ...args] : args;
  }

  _hasSession(id, sock = this.sock) {
    if (!this.tmux) return false;
    return (
      spawnSync(this.tmuxBin, this._tx(["has-session", "-t", "fleet_" + id], sock), { stdio: "ignore" })
        .status === 0
    );
  }

  /**
   * Force tmux to re-emit the pane's authoritative current screen to its attached
   * client (our pty bridge). When a browser reconnects to a still-running server it
   * just re-hooks the existing pty buffer — tmux never sees a new attach, so a
   * full-screen TUI (Claude) that paints only via cursor moves would leave the box
   * blank until the next output. The raw `pane.buffer` replay can't reliably rebuild
   * that screen (sliced escape sequences / alternate-screen state), so we ask tmux
   * to repaint. No-op without tmux — a plain shell's buffer replay is enough.
   */
  _forceRedraw(pane) {
    if (!this.tmux || !pane || !pane.pty) return;
    try {
      const r = spawnSync(
        this.tmuxBin,
        this._tx(["list-clients", "-t", "fleet_" + pane.id, "-F", "#{client_tty}"], pane.sock),
        { stdio: ["ignore", "pipe", "ignore"] }
      );
      const tty = String(r.stdout || "")
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean)[0];
      if (!tty) return;
      spawnSync(this.tmuxBin, this._tx(["refresh-client", "-t", tty], pane.sock), { stdio: "ignore" });
    } catch {}
  }

  /**
   * The DECSET mouse-tracking sequences the pane's app currently wants, or "" if
   * none. A fullscreen TUI (Claude) enables mouse mode once, long before a browser
   * connects; that enable scrolls out of the replayed buffer, so a fresh xterm never
   * enters mouse mode and silently drops every click (tmux would route it to the app,
   * but it never leaves the browser). tmux tracks the app's requested modes as pane
   * flags, so we read them and hand the client the exact enables to catch it up. A
   * plain shell has no flags set → "" → we leave xterm's native selection alone.
   */
  _mouseEnables(pane) {
    if (!this.tmux || !pane || !pane.pty) return "";
    try {
      const r = spawnSync(
        this.tmuxBin,
        this._tx(
          ["display-message", "-p", "-t", "fleet_" + pane.id,
            "#{mouse_any_flag}#{mouse_all_flag}#{mouse_button_flag}#{mouse_standard_flag}#{mouse_sgr_flag}#{mouse_utf8_flag}"],
          pane.sock
        ),
        { stdio: ["ignore", "pipe", "ignore"] }
      );
      const [any, all, button, standard, sgr, utf8] = String(r.stdout || "").trim().split("").map((c) => c === "1");
      if (!any) return ""; // no mouse mode active — don't touch xterm's selection
      let seq = "";
      // Only one tracking level is meaningful at a time; send the most specific set.
      if (all) seq += "\x1b[?1003h";
      else if (button) seq += "\x1b[?1002h";
      else if (standard) seq += "\x1b[?1000h";
      if (sgr) seq += "\x1b[?1006h";
      else if (utf8) seq += "\x1b[?1005h";
      return seq;
    } catch {
      return "";
    }
  }

  // Block synchronously without burning CPU (constructor-time only).
  _sleepSync(ms) {
    try {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    } catch {
      const end = Date.now() + ms;
      while (Date.now() < end) {}
    }
  }

  /**
   * Liveness check used during restore. A single has-session can transiently
   * fail right after the tmux server (re)starts or while many clients are
   * detaching at once — concluding "dead" then would wrongly demote a live
   * terminal to dormant. So we retry, but ONLY when the failure looks like the
   * server isn't reachable yet; a clean "can't find session" (server answered,
   * session genuinely absent) returns dead immediately, keeping startup fast.
   */
  _aliveAtRestore(id, sock) {
    if (!this.tmux) return false;
    const tries = 5;
    for (let i = 0; i < tries; i++) {
      const r = spawnSync(this.tmuxBin, this._tx(["has-session", "-t", "fleet_" + id], sock), { stdio: "pipe" });
      if (r.status === 0) return true;
      const err = (r.stderr || "").toString().toLowerCase();
      const serverUnreachable =
        !!r.error || err === "" || err.includes("no server") || err.includes("error connecting") || err.includes("no such file");
      if (!serverUnreachable) return false; // server answered: session is really gone
      if (i < tries - 1) this._sleepSync(200);
    }
    return false;
  }

  // ---- persistence + restore -------------------------------------------
  _persistState() {
    if (!this.stateFile) return;
    const dump = (p, dormant) => ({
      id: p.id,
      session: p.session,
      order: p.order,
      cwd: p.cwd,
      cmd: p.cmd,
      followUp: p.followUp,
      lastInput: p.lastInput || "",
      color: p.color || "",
      createdAt: p.createdAt,
      sock: p.sock ?? null,
      dormant,
      sessionAlive: dormant ? !!p.sessionAlive : undefined,
    });
    const data = [
      ...[...this.panes.values()].map((p) => dump(p, false)),
      ...[...this.dormant.values()].map((p) => dump(p, true)),
    ];
    try {
      writeFileSync(this.stateFile, JSON.stringify(data, null, 2));
    } catch (e) {
      console.warn(`[fleetview] could not write ${this.stateFile}: ${e.message}`);
    }
  }

  _blankPane(m) {
    return {
      id: m.id,
      cwd: m.cwd,
      cmd: m.cmd,
      session: m.session || null,
      order: m.order ?? this.seq,
      // Pre-upgrade entries have no `sock` → null = tmux's default socket, where
      // sessions from the old code still live, so we can reattach them.
      sock: m.sock !== undefined ? m.sock : null,
      pty: null,
      buffer: "",
      clients: new Set(),
      attention: { waiting: false, kind: null },
      followUp: !!m.followUp,
      lastInput: m.lastInput || "",
      color: m.color || "",
      createdAt: m.createdAt || Date.now(),
      sessionAlive: false,
      _intentional: false,
    };
  }

  _restore() {
    if (!this.stateFile || !existsSync(this.stateFile)) return;
    let saved;
    try {
      saved = JSON.parse(readFileSync(this.stateFile, "utf8"));
    } catch (e) {
      console.warn(`[fleetview] could not read ${this.stateFile} (${e.message}); starting with no restored terminals.`);
      return;
    }
    if (!Array.isArray(saved)) {
      console.warn(`[fleetview] ${this.stateFile} is not an array; ignoring it.`);
      return;
    }
    let restored = 0;
    let dormant = 0;
    for (const m of saved) {
      const pane = this._blankPane(m);
      if (pane.order >= this.seq) this.seq = pane.order + 1;
      const alive = this._aliveAtRestore(m.id, pane.sock);

      if (m.dormant) {
        // Was already set aside / dead. Keep it dormant; just re-check liveness.
        pane.sessionAlive = alive;
        this.dormant.set(pane.id, pane);
        dormant++;
        continue;
      }
      if (alive) {
        this._bridge(pane);
        // Inject the inline-render env into pre-existing sessions too, so restarting
        // Claude in an already-open box (exit + re-run) picks up inline rendering.
        if (this.tmux)
          spawnSync(this.tmuxBin, this._tx(["set-environment", "-t", "fleet_" + pane.id, "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN", "1"], pane.sock), { stdio: "ignore" });
        this.panes.set(pane.id, pane);
        restored++;
      } else {
        // Its tmux session is gone — DON'T drop it (that loses the only way to
        // bring the terminal back). Keep it dormant so the UI can offer respawn.
        pane.sessionAlive = false;
        this.dormant.set(pane.id, pane);
        dormant++;
      }
    }
    if (restored || dormant)
      console.log(
        `[fleetview] reattached ${restored} terminal(s); ${dormant} dormant (recoverable) from a prior run.`
      );
    this._persistState();
  }

  // ---- the pty that bridges xterm <-> the shell ------------------------
  _bridge(pane) {
    const env = {
      ...process.env,
      FLEET_PANE_ID: pane.id,
      FLEET_PORT: String(this.port),
      TERM: "xterm-256color",
      // Render Claude inline (no fullscreen/alternate-screen) so its output flows
      // into normal scrollback — you can drag-select and copy any of it. Fullscreen
      // mode repaints the screen and owns its own scroll, which breaks text
      // selection. (Claude-only var; harmless to other programs.)
      CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: "1",
    };
    const term = this.tmux
      ? pty.spawn(this.tmuxBin, this._tx(["attach-session", "-t", "fleet_" + pane.id], pane.sock), {
          name: "xterm-256color",
          cols: 80,
          rows: 24,
          env,
        })
      : pty.spawn(SHELL, ["-l"], {
          name: "xterm-256color",
          cwd: pane.cwd,
          cols: 80,
          rows: 24,
          env,
        });
    pane.pty = term;
    term.onData((d) => {
      pane.buffer = (pane.buffer + d).slice(-SCROLLBACK);
      for (const ws of pane.clients) safeSend(ws, { t: "d", d });
    });
    term.onExit(() => {
      // An intentional teardown (× close, or set-aside on Replace) has already
      // moved this pane to its final home — don't touch it again here.
      if (pane._intentional) return;
      // Unexpected: the bridge died because the tmux session vanished (server
      // torn down, `exit` typed, etc). Keep the pane as dormant so the user can
      // bring it back instead of silently losing it.
      this.panes.delete(pane.id);
      pane.pty = null;
      pane.clients = new Set();
      pane.buffer = "";
      pane.sessionAlive = this._hasSession(pane.id, pane.sock);
      this.dormant.set(pane.id, pane);
      this._persistState();
      this.emit("died", pane.id, pane.session, this._dormantInfo(pane));
    });
  }

  _newTmuxSession(id, dir, sock = this.sock) {
    const name = "fleet_" + id;
    // Detached session running the login shell, in the chosen dir, with the
    // FLEET_* breadcrumbs the Claude Code hooks read. `-e` sets the session env.
    spawnSync(
      this.tmuxBin,
      this._tx([
        "new-session", "-d", "-s", name, "-x", "220", "-y", "50", "-c", dir,
        "-e", "FLEET_PANE_ID=" + id, "-e", "FLEET_PORT=" + this.port,
        // Inline Claude rendering (see _bridge) so its output is selectable/copyable.
        "-e", "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1",
      ], sock),
      { stdio: "ignore" }
    );
    // Make it transparent: no status bar, no prefix key stealing input.
    for (const opt of [["status", "off"], ["prefix", "None"], ["prefix2", "None"]]) {
      spawnSync(this.tmuxBin, this._tx(["set-option", "-t", name, ...opt], sock), { stdio: "ignore" });
    }
  }

  _runStartup(pane) {
    if (!pane.cmd) return;
    setTimeout(() => {
      if (this.tmux) {
        spawnSync(this.tmuxBin, this._tx(["send-keys", "-t", "fleet_" + pane.id, pane.cmd, "Enter"], pane.sock), { stdio: "ignore" });
      } else {
        try {
          pane.pty.write(pane.cmd + "\r");
        } catch {}
      }
    }, 350);
  }

  create({ cwd, cmd, session } = {}) {
    const id = randomUUID().slice(0, 8);
    const home = os.homedir();
    const dir = cwd && String(cwd).trim() ? String(cwd).replace(/^~/, home) : home;
    const startup = cmd === undefined ? "claude" : cmd;

    const pane = {
      id,
      cwd: dir,
      cmd: startup,
      session: session || null,
      order: this.seq++,
      pty: null,
      buffer: "",
      clients: new Set(),
      attention: { waiting: false, kind: null },
      followUp: false,
      lastInput: "",
      color: "",
      createdAt: Date.now(),
      sock: this.sock, // new sessions always live on the stable socket
      sessionAlive: false,
      _intentional: false,
    };

    if (this.tmux) this._newTmuxSession(id, dir, this.sock);
    this._bridge(pane);
    this.panes.set(id, pane);
    this._runStartup(pane);
    this._persistState();
    return pane;
  }

  /**
   * Bring a dormant pane back. If its tmux session is still alive (it was set
   * aside, not killed) we just re-attach — the Claude session and its full state
   * are preserved. If the session is gone we spawn a fresh one in the same folder
   * and re-run its command.
   */
  respawn(id) {
    const pane = this.dormant.get(id);
    if (!pane) return null;
    const alive = this._hasSession(id, pane.sock);
    const fresh = this.tmux && !alive;
    if (fresh) {
      // A dead session is recreated on the stable socket — migrating it forward
      // off any legacy default-socket location it used to live on.
      pane.sock = this.sock;
      this._newTmuxSession(id, pane.cwd, this.sock);
    }

    pane._intentional = false;
    pane.pty = null;
    pane.buffer = "";
    pane.clients = new Set();
    pane.attention = { waiting: false, kind: null };
    this._bridge(pane);
    this.dormant.delete(id);
    this.panes.set(id, pane);
    // Only (re-)run the command on a fresh session; a reattach already has it.
    if (fresh || !this.tmux) this._runStartup(pane);
    this._persistState();
    return this.info(id);
  }

  /** Drop a dormant pane for good (user chose not to recover it). */
  discardDormant(id) {
    const pane = this.dormant.get(id);
    if (!pane) return;
    if (this.tmux) {
      // If its session was merely set aside (still alive), kill it now.
      spawnSync(this.tmuxBin, this._tx(["kill-session", "-t", "fleet_" + id], pane.sock), { stdio: "ignore" });
    }
    this.dormant.delete(id);
    this._persistState();
  }

  attach(id, ws) {
    const pane = this.panes.get(id);
    if (!pane) {
      try {
        ws.close();
      } catch {}
      return;
    }
    pane.clients.add(ws);
    safeSend(ws, { t: "d", d: pane.buffer });
    // Catch this fresh client up to the app's current mouse-tracking mode; without
    // it, clicks in a full-screen TUI (Claude) go nowhere (see _mouseEnables).
    const mouse = this._mouseEnables(pane);
    if (mouse) safeSend(ws, { t: "d", d: mouse });
    // Replaying pane.buffer alone can't rebuild a full-screen TUI's screen on a
    // fresh reconnect (the box would show blank). Give the client a beat to open
    // and send its size, then have tmux repaint the authoritative current screen.
    setTimeout(() => this._forceRedraw(pane), 60);
    ws.on("message", (raw) => {
      let m;
      try {
        m = JSON.parse(raw);
      } catch {
        return;
      }
      if (m.t === "d") {
        try {
          pane.pty.write(m.d);
        } catch {}
      } else if (m.t === "r") {
        try {
          pane.pty.resize(Math.max(2, m.cols | 0), Math.max(2, m.rows | 0));
        } catch {}
      }
    });
    ws.on("close", () => pane.clients.delete(ws));
  }

  setAttention(id, kind) {
    const pane = this.panes.get(id);
    if (!pane) return;
    pane.attention = { waiting: true, kind };
    this.emit("attention", id, kind);
  }

  clearAttention(id) {
    const pane = this.panes.get(id);
    if (pane) pane.attention = { waiting: false, kind: null };
  }

  setFollowUp(id, on) {
    const pane = this.panes.get(id) || this.dormant.get(id);
    if (!pane) return;
    pane.followUp = !!on;
    this._persistState();
  }

  // The last prompt the user submitted to this pane's Claude (from the
  // UserPromptSubmit hook). Pinned in the UI so you can see what you last asked.
  setLastInput(id, text) {
    const pane = this.panes.get(id) || this.dormant.get(id);
    if (!pane) return;
    pane.lastInput = String(text || "").slice(0, 2000);
    this._persistState();
  }

  lastInputOf(id) {
    return (this.panes.get(id) || this.dormant.get(id))?.lastInput || "";
  }

  // A user-chosen tint for this pane's border (a hex string, or "" to clear).
  setColor(id, color) {
    const pane = this.panes.get(id) || this.dormant.get(id);
    if (!pane) return;
    pane.color = String(color || "").slice(0, 32);
    this._persistState();
  }

  /** User closed the pane (×) — destroy it for good. */
  kill(id) {
    const pane = this.panes.get(id);
    if (!pane) {
      // Closing a pane that's already dormant just discards it.
      if (this.dormant.has(id)) this.discardDormant(id);
      return;
    }
    pane._intentional = true; // stop onExit from resurrecting it as dormant
    if (this.tmux) {
      spawnSync(this.tmuxBin, this._tx(["kill-session", "-t", "fleet_" + id], pane.sock), { stdio: "ignore" });
    }
    try {
      pane.pty.kill();
    } catch {}
    this.panes.delete(id);
    this._persistState();
  }

  /**
   * Set a pane aside without killing its work (used by layout "Replace"). The
   * tmux session keeps running detached; the pane goes dormant and can be
   * respawned later with its Claude session fully intact. Without tmux there's
   * nothing to detach, so it behaves like a recoverable (but fresh-on-respawn)
   * dormant pane.
   */
  setAside(id) {
    const pane = this.panes.get(id);
    if (!pane) return null;
    pane._intentional = true; // detaching kills the bridge pty; don't double-handle
    const alive = this._hasSession(id, pane.sock);
    try {
      pane.pty.kill(); // kills the attach client → detaches; tmux session lives on
    } catch {}
    this.panes.delete(id);
    pane.pty = null;
    pane.clients = new Set();
    pane.buffer = "";
    pane.sessionAlive = alive;
    this.dormant.set(id, pane);
    this._persistState();
    return this._dormantInfo(pane);
  }

  info(id) {
    const p = this.panes.get(id);
    if (!p) return null;
    return {
      id: p.id,
      cwd: p.cwd,
      cmd: p.cmd,
      session: p.session,
      attention: p.attention,
      followUp: p.followUp,
      lastInput: p.lastInput || "",
      color: p.color || "",
      createdAt: p.createdAt,
    };
  }

  _dormantInfo(p) {
    return {
      id: p.id,
      cwd: p.cwd,
      cmd: p.cmd,
      session: p.session,
      followUp: p.followUp,
      createdAt: p.createdAt,
      order: p.order,
      sessionAlive: !!p.sessionAlive,
    };
  }

  sessionOf(id) {
    return (this.panes.get(id) || this.dormant.get(id))?.session ?? null;
  }

  idsOf(session) {
    return [...this.panes.values()]
      .filter((p) => p.session === session)
      .map((p) => p.id);
  }

  reorder(session, ids) {
    let i = 0;
    for (const id of ids) {
      const p = this.panes.get(id);
      if (p && p.session === session) p.order = i++;
    }
    this._persistState();
  }

  list(session) {
    return [...this.panes.values()]
      .filter((p) => session === undefined || p.session === session)
      .sort((a, b) => a.order - b.order)
      .map((p) => this.info(p.id));
  }

  dormantList(session) {
    return [...this.dormant.values()]
      .filter((p) => session === undefined || p.session === session)
      .sort((a, b) => a.order - b.order)
      .map((p) => this._dormantInfo(p));
  }
}

function safeSend(ws, obj) {
  try {
    ws.send(JSON.stringify(obj));
  } catch {}
}
