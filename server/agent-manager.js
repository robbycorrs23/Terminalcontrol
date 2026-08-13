import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { startClaudeSession } from "./agents/claude-driver.js";
import { startCodexSession } from "./agents/codex-driver.js";

const RING_BUFFER_SIZE = 300; // replayed to a client that attaches/reconnects
const LAST_INPUT_CAP = 2000; // matches PtyManager's UserPromptSubmit cap

/**
 * SDK/app-server-driven "chat" panes (see the plan) — the counterpart to
 * PtyManager, but for panes with no PTY at all. Owns attention/broadcast
 * glue directly (in-process, no HTTP hook round-trip) so the tray, queue,
 * follow-up chips, and mobile row-preview all keep working unmodified: every
 * method here mirrors PtyManager's same-named method and broadcast shape.
 *
 * No dormant/respawn/discard concept — durability is "resume by session id"
 * (see claude-driver.js's `resume` option), not a live-process handle to
 * reattach to, so on restart panes come back as metadata only
 * (`status:"disconnected"`) and the driver starts lazily on first `/agent`
 * attach or first sent message, never eagerly at boot.
 */
export class AgentManager {
  /**
   * @param {string} stateFile
   * @param {(session: string|null, msg: object) => void} broadcast
   */
  constructor(stateFile, broadcast) {
    this.stateFile = stateFile;
    this.broadcast = broadcast;
    this.panes = new Map(); // id -> agentPane
    this.seq = 0;
    this._restore();
  }

  _restore() {
    if (!existsSync(this.stateFile)) return;
    let records;
    try {
      records = JSON.parse(readFileSync(this.stateFile, "utf8"));
    } catch {
      return;
    }
    for (const r of records) {
      this.panes.set(r.id, {
        ...r,
        driver: null,
        events: [],
        clients: new Set(),
        attention: { waiting: false, kind: null },
        status: "disconnected",
      });
      this.seq = Math.max(this.seq, (r.order ?? 0) + 1);
    }
  }

  _persist() {
    const records = [...this.panes.values()].map((p) => ({
      id: p.id,
      cwd: p.cwd,
      cmd: p.cmd,
      session: p.session,
      order: p.order,
      provider: p.provider,
      sdkSessionId: p.sdkSessionId,
      followUp: p.followUp,
      lastInput: p.lastInput,
      color: p.color,
      name: p.name,
      createdAt: p.createdAt,
    }));
    writeFileSync(this.stateFile, JSON.stringify(records, null, 2));
  }

  _buildEnv(pane) {
    const env = { ...process.env };
    // A stray ANTHROPIC_API_KEY in the parent env would silently switch this
    // subprocess from subscription billing to pay-per-token API billing the
    // first time it's used — never let it through.
    delete env.ANTHROPIC_API_KEY;
    // The env var that isolates a "-work" account's config differs by
    // provider: CLAUDE_CONFIG_DIR for claude, CODEX_HOME for codex (same
    // pattern the PTY-based "claude (work)"/"codex (work)" options already
    // use — see server/index.js).
    if (pane.accountConfigDir) {
      env[pane.provider === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"] = pane.accountConfigDir;
    }
    return env;
  }

  /** Lazily starts (or resumes) the live driver for a pane. Idempotent. */
  _ensureDriver(pane) {
    if (pane.driver) return pane.driver;
    const start = pane.provider === "codex" ? startCodexSession : startClaudeSession;
    pane.driver = start({
      cwd: pane.cwd,
      resume: pane.sdkSessionId || undefined,
      env: this._buildEnv(pane),
      onEvent: (ev) => this._handleEvent(pane, ev),
      onSessionId: (sid) => {
        if (pane.sdkSessionId !== sid) {
          pane.sdkSessionId = sid;
          this._persist();
        }
      },
    });
    return pane.driver;
  }

  _handleEvent(pane, ev) {
    pane.events.push(ev);
    if (pane.events.length > RING_BUFFER_SIZE) pane.events.shift();

    if (ev.t === "permission_request") {
      this.setAttention(pane.id, "question");
    } else if (ev.t === "status") {
      pane.status = ev.state;
      if (ev.state === "idle") this.setAttention(pane.id, "done");
    }

    const msg = JSON.stringify({ t: "ev", ev });
    for (const ws of pane.clients) {
      try {
        ws.send(msg);
      } catch {}
    }
  }

  // ---- Creation / lifecycle, mirrors PtyManager's surface ---------------

  create({ cwd, cmd, session }) {
    const provider = cmd.startsWith("codex") ? "codex" : "claude";
    const id = randomUUID().slice(0, 8);
    const home = homedir();
    const dir = cwd && String(cwd).trim() ? String(cwd).replace(/^~/, home) : home;
    const pane = {
      id,
      kind: "agent",
      cwd: dir,
      cmd,
      provider,
      accountConfigDir: cmd.endsWith("-work") ? join(home, `.${provider}-work`) : null,
      session: session || null,
      order: this.seq++,
      sdkSessionId: null,
      driver: null,
      events: [],
      clients: new Set(),
      attention: { waiting: false, kind: null },
      followUp: false,
      lastInput: "",
      color: "",
      name: "",
      createdAt: Date.now(),
      status: "idle",
    };
    this.panes.set(id, pane);
    this._persist();
    return pane;
  }

  kill(id) {
    const pane = this.panes.get(id);
    if (!pane) return;
    pane.driver?.dispose();
    this.panes.delete(id);
    this._persist();
  }

  /** Layout "Replace" — no dormant tier for agent panes, so this is just a kill. */
  setAside(id) {
    this.kill(id);
    return { id };
  }

  // ---- Live WS attach, mirrors PtyManager.attach for /term --------------

  attach(id, ws) {
    const pane = this.panes.get(id);
    if (!pane) {
      try {
        ws.close();
      } catch {}
      return;
    }
    try {
      this._ensureDriver(pane);
    } catch (err) {
      try {
        ws.send(JSON.stringify({ t: "ev", ev: { t: "status", state: "error", detail: err.message } }));
      } catch {}
    }
    pane.clients.add(ws);
    try {
      ws.send(JSON.stringify({ t: "replay", events: pane.events }));
    } catch {}
    ws.on("message", (raw) => {
      let m;
      try {
        m = JSON.parse(raw);
      } catch {
        return;
      }
      if (m.t === "send" && typeof m.text === "string" && m.text.trim()) {
        this.sendMessage(id, m.text);
      } else if (m.t === "approve" && m.requestId) {
        this.approve(id, m.requestId, m.decision);
      } else if (m.t === "interrupt") {
        pane.driver?.interrupt();
      }
    });
    ws.on("close", () => pane.clients.delete(ws));
  }

  sendMessage(id, text) {
    const pane = this.panes.get(id);
    if (!pane) return false;
    try {
      this._ensureDriver(pane);
    } catch (err) {
      this._handleEvent(pane, { t: "status", state: "error", detail: err.message });
      return false;
    }
    // Same compatibility contract PTY panes get from the UserPromptSubmit
    // hook: pin the last input, clear attention, broadcast both.
    this.setLastInput(id, text);
    this.broadcast(pane.session, { t: "input", pane: id, text: this.lastInputOf(id) });
    this.clearAttention(id);
    this.broadcast(pane.session, { t: "cleared", pane: id });
    pane.driver.send(text);
    return true;
  }

  approve(id, requestId, decision) {
    const pane = this.panes.get(id);
    if (!pane?.driver) return false;
    const ok = pane.driver.approve(requestId, decision);
    if (ok) {
      this.clearAttention(id);
      this.broadcast(pane.session, { t: "cleared", pane: id });
    }
    return ok;
  }

  // ---- Generic pane metadata, same method names/shapes as PtyManager ----

  info(id) {
    const p = this.panes.get(id);
    if (!p) return null;
    return {
      id: p.id,
      kind: "agent",
      cwd: p.cwd,
      cmd: p.cmd,
      session: p.session,
      attention: p.attention,
      followUp: p.followUp,
      lastInput: p.lastInput || "",
      color: p.color || "",
      name: p.name || "",
      createdAt: p.createdAt,
    };
  }

  list(session) {
    return [...this.panes.values()]
      .filter((p) => session === undefined || p.session === session)
      .sort((a, b) => a.order - b.order)
      .map((p) => this.info(p.id));
  }

  /** No dormant/recovery tier for agent panes — see the class doc comment. */
  dormantList() {
    return [];
  }

  sessionOf(id) {
    return this.panes.get(id)?.session ?? null;
  }

  idsOf(session) {
    return [...this.panes.values()].filter((p) => p.session === session).map((p) => p.id);
  }

  // Mirrors PtyManager.reorder's per-manager-local sequential numbering
  // exactly (increments only on a match) — see pane-registry.js for the
  // known limitation this produces when a drag-reorder mixes pty and agent
  // panes in the same window.
  reorder(session, ids) {
    let i = 0;
    for (const id of ids) {
      const p = this.panes.get(id);
      if (p && p.session === session) p.order = i++;
    }
    this._persist();
  }

  setAttention(id, kind) {
    const pane = this.panes.get(id);
    if (!pane) return;
    pane.attention = { waiting: true, kind };
    this.broadcast(pane.session, { t: "attention", pane: id, kind });
  }

  clearAttention(id) {
    const pane = this.panes.get(id);
    if (pane) pane.attention = { waiting: false, kind: null };
  }

  setFollowUp(id, on) {
    const p = this.panes.get(id);
    if (p) {
      p.followUp = !!on;
      this._persist();
    }
  }

  setColor(id, color) {
    const p = this.panes.get(id);
    if (p) {
      p.color = color || "";
      this._persist();
    }
  }

  setName(id, name) {
    const p = this.panes.get(id);
    if (p) {
      p.name = name || "";
      this._persist();
    }
  }

  setLastInput(id, text) {
    const p = this.panes.get(id);
    if (p) {
      p.lastInput = (text || "").slice(0, LAST_INPUT_CAP);
      this._persist();
    }
  }

  lastInputOf(id) {
    return this.panes.get(id)?.lastInput || "";
  }
}
