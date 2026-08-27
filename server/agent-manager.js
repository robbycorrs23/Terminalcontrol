import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { startClaudeSession } from "./agents/claude-driver.js";
import { startCodexSession } from "./agents/codex-driver.js";
import { restoreEvents } from "./transcript.js";

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
/**
 * The isolated config dir a "-work" pane's agent must run against, or null for
 * the default account. DERIVED from `cmd` rather than stored on the pane: this
 * has to survive a server restart, and `cmd` is persisted while a stored copy
 * of the resolved dir was not — which silently ran every restored "claude
 * (work)" pane on the personal account (wrong billing, and `resume` failing
 * with "No conversation found" because the transcript lives in the other
 * dir's projects/).
 */
function accountConfigDirFor(cmd, provider) {
  return String(cmd || "").endsWith("-work") ? join(homedir(), `.${provider}-work`) : null;
}

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
      const provider = r.provider || (String(r.cmd || "").startsWith("codex") ? "codex" : "claude");
      this.panes.set(r.id, {
        ...r,
        provider,
        // Recomputed, never read back from the record — see accountConfigDirFor.
        accountConfigDir: accountConfigDirFor(r.cmd, provider),
        mode: r.mode || "default", // older records predate mode-switching — default is what they always ran as
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
      mode: p.mode,
    }));
    writeFileSync(this.stateFile, JSON.stringify(records, null, 2));
  }

  _buildEnv(pane) {
    const env = { ...process.env };
    // Belt and braces: FleetView's own server may itself have been launched
    // from a shell with CLAUDE_CONFIG_DIR/CODEX_HOME exported, which would
    // leak that account into every pane that didn't ask for one.
    delete env.CLAUDE_CONFIG_DIR;
    delete env.CODEX_HOME;
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

  /**
   * A `resume` id only means something to the account that wrote it —
   * transcripts live under `<configDir>/projects/`, so an id recorded while
   * the pane was (mis)running on the other account resumes into nothing and
   * the pane errors out on every attach forever, with no UI to clear it.
   * Drop the id in that case and start a fresh session instead.
   *
   * Claude only: codex stores threads differently (`~/.codex/sessions`, plus a
   * session index) and its resume path isn't the one that broke here — not
   * worth guessing at that layout, so codex ids pass through untouched.
   */
  _resumableSessionId(pane) {
    const sid = pane.sdkSessionId;
    if (!sid || pane.provider === "codex") return sid || undefined;
    const projects = join(pane.accountConfigDir || join(homedir(), ".claude"), "projects");
    try {
      for (const proj of readdirSync(projects)) {
        if (existsSync(join(projects, proj, `${sid}.jsonl`))) return sid;
      }
    } catch {
      return sid; // can't tell (no projects dir yet) — let the SDK decide
    }
    return undefined;
  }

  /** Lazily starts (or resumes) the live driver for a pane. Idempotent. */
  _ensureDriver(pane) {
    if (pane.driver) return pane.driver;
    const start = pane.provider === "codex" ? startCodexSession : startClaudeSession;
    pane.driver = start({
      cwd: pane.cwd,
      resume: this._resumableSessionId(pane),
      mode: pane.mode || "default",
      env: this._buildEnv(pane),
      onEvent: (ev) => this._handleEvent(pane, ev),
      onSessionId: (sid) => {
        if (pane.sdkSessionId !== sid) {
          pane.sdkSessionId = sid;
          this._persist();
        }
      },
      // Limits are per-ACCOUNT, so this is keyed by cmd ("claude" / "claude-work"
      // / "codex" / "codex-work") — the same string accountConfigDirFor() reads —
      // not by pane id. Whoever consumes it is watching accounts, not boxes.
      onRateLimit: (data) => this.onRateLimit?.(String(pane.cmd || pane.provider), data),
    });
    return pane.driver;
  }

  _handleEvent(pane, ev) {
    // Deltas are LIVE-ONLY, never stored: codex streams one assistant message
    // as hundreds of assistant_delta events, so ringing them would evict the
    // entire 300-event replay history on a single long reply — a reattached
    // codex pane would come back showing the tail of one message and nothing
    // else. The assistant_done that follows carries the full text, so replay
    // loses nothing. Tradeoff: a message interrupted before item/completed
    // fires isn't in the replay (it stays on screen for connected clients).
    if (ev.t !== "assistant_delta") {
      pane.events.push(ev);
      if (pane.events.length > RING_BUFFER_SIZE) pane.events.shift();
    }

    if (ev.t === "permission_request" || ev.t === "question") {
      this.setAttention(pane.id, "question");
    } else if (ev.t === "status") {
      const wasWorking = pane.status === "working";
      pane.status = ev.state;
      // Mirror PtyManager's "work" edge onto the control socket so agent panes
      // get the same grid-wide working treatment terminal panes do.
      if (wasWorking !== (ev.state === "working"))
        this.broadcast(pane.session, { t: "work", pane: pane.id, on: ev.state === "working" });
      if (ev.state === "idle") this.setAttention(pane.id, "done");
    } else if (ev.t === "mode" && pane.mode !== ev.mode) {
      pane.mode = ev.mode;
      this._persist();
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
      accountConfigDir: accountConfigDirFor(cmd, provider),
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
      mode: "default",
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

  /**
   * Refill an empty event ring from the SDK's on-disk transcript, once per
   * process. Restarts leave a resumed pane with a working conversation but a
   * blank log (`events` is memory-only, see `_restore`); this puts the history
   * back on screen. Guarded on emptiness so it can never fight live events, and
   * flagged so a genuinely empty transcript isn't re-read on every attach.
   */
  _hydrateFromTranscript(pane) {
    if (pane._hydrated || pane.events.length || !pane.sdkSessionId) return;
    pane._hydrated = true;
    if (pane.provider === "codex") return; // different on-disk layout — see transcript.js
    try {
      const configDir = pane.accountConfigDir || join(homedir(), ".claude");
      const events = restoreEvents(configDir, pane.sdkSessionId, RING_BUFFER_SIZE - 10);
      if (events.length) {
        pane.events = events;
        console.log(`[fleetview] pane ${pane.id}: restored ${events.length} events from transcript`);
      }
    } catch {} // best effort — a blank log is the old behavior, not a failure
  }

  attach(id, ws) {
    const pane = this.panes.get(id);
    if (!pane) {
      try {
        ws.close();
      } catch {}
      return;
    }
    // Before _ensureDriver, so the driver's own `mode` event lands after the
    // restored history rather than being swallowed by the emptiness guard.
    this._hydrateFromTranscript(pane);
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
      } else if (m.t === "answer" && m.requestId && m.answers && typeof m.answers === "object") {
        this.answer(id, m.requestId, m.answers);
      } else if (m.t === "interrupt") {
        pane.driver?.interrupt();
      } else if (m.t === "setMode" && typeof m.mode === "string") {
        this.setMode(id, m.mode);
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

  /**
   * Switch a pane's permission mode. If a driver is already live and
   * supports it (currently just claude-driver.js — codex-driver.js's
   * protocol support isn't verified yet, see its own file comment about not
   * guessing at unconfirmed wire behavior), the change applies immediately
   * to the running session, which itself reports the new mode back via
   * `onEvent` — no need to also do it here. If there's no live driver yet
   * (never attached, or the provider doesn't support live switching), just
   * record it: the next `_ensureDriver()` call starts the session in this
   * mode, and attached clients still need telling now.
   */
  async setMode(id, mode) {
    const pane = this.panes.get(id);
    if (!pane) return false;
    if (pane.driver?.setMode) {
      try {
        await pane.driver.setMode(mode);
      } catch (err) {
        this._handleEvent(pane, { t: "status", state: "error", detail: err.message });
        return false;
      }
    } else {
      pane.mode = mode;
      this._persist();
      this._handleEvent(pane, { t: "mode", mode });
    }
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

  /** Answer an AskUserQuestion prompt (see claude-driver.js's `answer`). */
  answer(id, requestId, answers) {
    const pane = this.panes.get(id);
    if (!pane?.driver?.answer) return false;
    const ok = pane.driver.answer(requestId, answers);
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
      working: p.status === "working",
      followUp: p.followUp,
      lastInput: p.lastInput || "",
      color: p.color || "",
      name: p.name || "",
      createdAt: p.createdAt,
      mode: p.mode || "default",
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
