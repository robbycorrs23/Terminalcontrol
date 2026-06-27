import * as pty from "node-pty";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import os from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

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
 * Emits:
 *   "attention" (paneId, kind)
 *   "exit"      (paneId, session)
 */
export class PtyManager extends EventEmitter {
  constructor(port, stateFile) {
    super();
    this.port = port;
    this.panes = new Map();
    this.seq = 0;
    this.stateFile = stateFile;
    this.tmuxBin = findTmux();
    this.tmux = !!this.tmuxBin;
    if (this.tmux) {
      // Make the inner tmux transparent + snappy for TUIs like Claude Code.
      spawnSync(this.tmuxBin, ["start-server"], { stdio: "ignore" });
      spawnSync(this.tmuxBin, ["set-option", "-g", "escape-time", "10"], { stdio: "ignore" });
      this._restore();
    }
  }

  // ---- persistence + restore -------------------------------------------
  _persistState() {
    if (!this.stateFile) return;
    const data = [...this.panes.values()].map((p) => ({
      id: p.id,
      session: p.session,
      order: p.order,
      cwd: p.cwd,
      cmd: p.cmd,
      followUp: p.followUp,
      createdAt: p.createdAt,
    }));
    try {
      writeFileSync(this.stateFile, JSON.stringify(data, null, 2));
    } catch {}
  }

  _restore() {
    if (!this.stateFile || !existsSync(this.stateFile)) return;
    let saved;
    try {
      saved = JSON.parse(readFileSync(this.stateFile, "utf8"));
    } catch {
      return;
    }
    let restored = 0;
    for (const m of saved) {
      const alive =
        spawnSync(this.tmuxBin, ["has-session", "-t", "fleet_" + m.id], { stdio: "ignore" })
          .status === 0;
      if (!alive) continue; // its tmux session is gone — drop it
      const pane = {
        id: m.id,
        cwd: m.cwd,
        cmd: m.cmd,
        session: m.session || null,
        order: m.order ?? this.seq,
        pty: null,
        buffer: "",
        clients: new Set(),
        attention: { waiting: false, kind: null },
        followUp: !!m.followUp,
        createdAt: m.createdAt || Date.now(),
      };
      this._bridge(pane);
      this.panes.set(pane.id, pane);
      if (pane.order >= this.seq) this.seq = pane.order + 1;
      restored++;
    }
    if (restored) console.log(`[fleetview] reattached ${restored} terminal(s) from tmux.`);
    this._persistState();
  }

  // ---- the pty that bridges xterm <-> the shell ------------------------
  _bridge(pane) {
    const env = {
      ...process.env,
      FLEET_PANE_ID: pane.id,
      FLEET_PORT: String(this.port),
      TERM: "xterm-256color",
    };
    const term = this.tmux
      ? pty.spawn(this.tmuxBin, ["attach-session", "-t", "fleet_" + pane.id], {
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
      this.panes.delete(pane.id);
      this._persistState();
      this.emit("exit", pane.id, pane.session);
    });
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
      createdAt: Date.now(),
    };

    if (this.tmux) {
      const name = "fleet_" + id;
      // Detached session running the login shell, in the chosen dir, with the
      // FLEET_* breadcrumbs the Claude Code hooks read. `-e` sets the session env.
      spawnSync(
        this.tmuxBin,
        ["new-session", "-d", "-s", name, "-x", "220", "-y", "50", "-c", dir,
         "-e", "FLEET_PANE_ID=" + id, "-e", "FLEET_PORT=" + this.port],
        { stdio: "ignore" }
      );
      // Make it transparent: no status bar, no prefix key stealing input.
      for (const opt of [["status", "off"], ["prefix", "None"], ["prefix2", "None"]]) {
        spawnSync(this.tmuxBin, ["set-option", "-t", name, ...opt], { stdio: "ignore" });
      }
    }

    this._bridge(pane);
    this.panes.set(id, pane);

    if (startup) {
      setTimeout(() => {
        if (this.tmux) {
          spawnSync(this.tmuxBin, ["send-keys", "-t", "fleet_" + id, startup, "Enter"], { stdio: "ignore" });
        } else {
          try {
            pane.pty.write(startup + "\r");
          } catch {}
        }
      }, 350);
    }
    this._persistState();
    return pane;
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
    const pane = this.panes.get(id);
    if (!pane) return;
    pane.followUp = !!on;
    this._persistState();
  }

  kill(id) {
    const pane = this.panes.get(id);
    if (!pane) return;
    if (this.tmux) {
      spawnSync(this.tmuxBin, ["kill-session", "-t", "fleet_" + id], { stdio: "ignore" });
    }
    try {
      pane.pty.kill();
    } catch {}
    this.panes.delete(id);
    this._persistState();
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
      createdAt: p.createdAt,
    };
  }

  sessionOf(id) {
    return this.panes.get(id)?.session ?? null;
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
}

function safeSend(ws, obj) {
  try {
    ws.send(JSON.stringify(obj));
  } catch {}
}
