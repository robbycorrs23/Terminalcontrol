import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, copyFileSync, statSync, unlinkSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { startClaudeSession } from "./agents/claude-driver.js";
import { startCodexSession } from "./agents/codex-driver.js";
import { restoreEvents, olderEvents, findTranscript, transcriptEntries, isHumanPrompt, eventsFromTranscript } from "./transcript.js";

const RING_BUFFER_SIZE = 300; // replayed to a client that attaches/reconnects
// Never ringed. Deltas would evict real history (see _handleEvent); progress
// ticks are stale the moment they land; the session-level ones are re-sent as
// current state on attach instead.
const LIVE_ONLY = new Set([
  "assistant_delta",
  "thinking_delta",
  "tool_progress",
  "commands",
  "models",
  "suggestion",
  "retry",
  "context",
  "task",
]);
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

/**
 * The REMOTE counterpart of accountConfigDirFor: a `$HOME`-relative shell
 * env-var assignment instead of a local homedir()-joined path, since a
 * remote pane's account isolation has to be set on the far end of the ssh
 * connection (baked into the command line — see ssh-remote-agent.js), not
 * via a local spawn() env option that never crosses the connection.
 */
function remoteEnvPrefix(cmd, provider) {
  if (!String(cmd || "").endsWith("-work")) return "";
  const v = provider === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR";
  return `${v}="$HOME/.${provider}-work" `;
}

/**
 * Validates/whitelists a client-supplied `remote` descriptor before it's
 * stored on a pane or shelled out to — same trust model as ssh-profiles.js's
 * save(): this is a local-only, unauthenticated tool, so the goal is
 * catching mistakes, not defending against a hostile caller.
 */
function sanitizeRemote(r) {
  if (!r || typeof r !== "object") return null;
  const target = String(r.target || "").trim().slice(0, 256);
  if (!target) return null;
  const out = { target };
  const port = parseInt(r.port, 10);
  if (Number.isFinite(port) && port > 0 && port <= 65535) out.port = port;
  if (r.identityFile) out.identityFile = String(r.identityFile).trim().slice(0, 512);
  return out;
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
        remote: sanitizeRemote(r.remote), // re-validated, not trusted verbatim off disk
        driver: null,
        events: [],
        clients: new Set(),
        queue: Array.isArray(r.queue) ? r.queue.filter((q) => q && typeof q.text === "string") : [],
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
      model: p.model || null,
      remote: p.remote || null,
      // Rewind state: a one-shot fork point for the next driver start, and
      // what "Undo rewind" needs (the pre-rewind session + file backups).
      resumeAt: p.resumeAt || null,
      rewindUndo: p.rewindUndo || null,
      chrome: !!p.chrome, // Claude in Chrome on for this session (setChrome)
      reviewOf: p.reviewOf || null, // a "Review with Claude" session: the pane it reviews
      queue: p.queue?.length ? p.queue : undefined, // survives closing the app AND a restart
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
    // codex ids are never verified (see the comment above), and neither is a
    // remote pane's — the local ~/.claude/projects scan below can only see
    // THIS machine's transcripts, which is meaningless for a session running
    // against a remote account. Trust the persisted id in both cases.
    if (!sid || pane.provider === "codex" || pane.remote) return sid || undefined;
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
      resumeAt: pane.resumeAt || undefined,
      mode: pane.mode || "default",
      chrome: !!pane.chrome,
      env: this._buildEnv(pane),
      remote: pane.remote ? { ...pane.remote, envPrefix: remoteEnvPrefix(pane.cmd, pane.provider) } : null,
      onEvent: (ev) => this._handleEvent(pane, ev),
      onSessionId: (sid) => {
        // A fork point is one-shot: once the forked session exists, later
        // driver starts just resume it.
        const forked = !!pane.resumeAt;
        pane.resumeAt = null;
        if (pane.sdkSessionId !== sid || forked) {
          pane.sdkSessionId = sid;
          this._persist();
        }
      },
      // Which model this session actually resolved to. Persisted so a restored
      // pane can label itself before its driver has started, and broadcast so
      // the badge updates without waiting for the next pane-list refresh.
      onModel: (model) => {
        if (!model || pane.model === model) return;
        pane.model = model;
        this._persist();
        this.broadcast(pane.session, { t: "model", pane: pane.id, model });
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
    // When it happened — drives "Thought for 8s" and similar in the client.
    if (ev.ts == null) ev.ts = Date.now();
    // Session-level facts, not log entries: kept as the pane's CURRENT value
    // and sent once after the replay (see attach), so a long commands list
    // can't evict history and a stale suggestion can't resurface on reload.
    if (ev.t === "commands") pane.commands = ev.commands;
    else if (ev.t === "models") pane.models = ev.models;
    else if (ev.t === "suggestion") (pane.suggestions ||= []).push(ev.text);
    else if (ev.t === "context") pane.context = ev;
    else if (ev.t === "task") {
      pane.tasks ||= new Map();
      if (ev.task.status === "running" || ev.task.status === "pending" || ev.task.status === "paused") pane.tasks.set(ev.task.id, ev.task);
      else pane.tasks.delete(ev.task.id);
      this._syncWork(pane);
    }
    else if (ev.t === "user" || (ev.t === "status" && ev.state === "working")) pane.suggestions = [];
    // Fleet inbox: what this pane is waiting on, and what it last said.
    let inboxChanged = false;
    if (ev.t === "permission_request" || ev.t === "question") {
      (pane.pending ||= new Map()).set(ev.requestId, ev);
      inboxChanged = true;
    } else if (ev.t === "permission_resolved" || ev.t === "question_resolved") {
      inboxChanged = !!pane.pending?.delete(ev.requestId);
    } else if (ev.t === "status" && (ev.state === "idle" || ev.state === "aborted" || ev.state === "error")) {
      if (pane.pending?.size) pane.pending.clear(); // a finished turn can't still be asking
      inboxChanged = true;
    } else if (ev.t === "assistant_done" && ev.text) {
      pane.lastReply = ev.text.slice(0, 600);
      pane.finalReply = ev.text.slice(0, 60000); // whole, for "Send findings" (Review with Claude)
    }
    if (inboxChanged) this.broadcast(pane.session, { t: "inbox" });
    if (!LIVE_ONLY.has(ev.t)) {
      pane.events.push(ev);
      if (pane.events.length > RING_BUFFER_SIZE) pane.events.shift();
    }

    if (ev.t === "permission_request" || ev.t === "question") {
      this.setAttention(pane.id, "question");
    } else if (ev.t === "status") {
      pane.status = ev.state;
      this._syncWork(pane);
      if (ev.state === "idle") this.setAttention(pane.id, "done");
      // Turn over cleanly → send what was queued meanwhile, as one message.
      // Server-side on purpose: it must happen with no app open at all.
      if (ev.state === "idle" && pane.queue?.length) {
        const text = pane.queue.map((q) => q.text).join("\n\n");
        pane.queue = [];
        this._queueChanged(pane);
        setImmediate(() => this.sendMessage(pane.id, text));
      }
      // Cut off (interrupt/restart/rate-limit/API hiccup), not a genuine
      // finish — see claude-driver.js/codex-driver.js. Its own attention
      // kind, not "done": the pane does need a look, but for a different
      // reason than "here's your answer."
      else if (ev.state === "aborted") this.setAttention(pane.id, "aborted");
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

  create({ cwd, cmd, session, remote, order, sdkSessionId, mode, chrome, reviewOf }) {
    const provider = cmd.startsWith("codex") ? "codex" : "claude";
    const id = randomUUID().slice(0, 8);
    const home = homedir();
    const dir = cwd && String(cwd).trim() ? String(cwd).replace(/^~/, home) : home;
    const pane = {
      chrome: !!chrome && !remote, // Claude in Chrome (setChrome / carried across a flip)
      reviewOf: reviewOf || null,
      id,
      kind: "agent",
      cwd: dir,
      cmd,
      provider,
      accountConfigDir: accountConfigDirFor(cmd, provider),
      // Set only when this pane's claude/codex runs over ssh on another
      // host instead of locally — see ssh-remote-agent.js / the plan.
      remote: sanitizeRemote(remote),
      session: session || null,
      order: order ?? this.seq++,
      // Normally null — the driver reports its own id on first connect. A value
      // here means this pane was flipped over from a terminal pane
      // (pane-registry.js `flip`) and should RESUME that conversation rather
      // than open a blank one; _ensureDriver picks it up via
      // _resumableSessionId, which also validates it against this account's
      // transcripts and quietly drops it if it isn't there.
      //
      sdkSessionId: sdkSessionId || null,
      driver: null,
      events: [],
      clients: new Set(),
      queue: [], // messages typed mid-turn, sent when the turn ends (queueAdd)
      attention: { waiting: false, kind: null },
      followUp: false,
      lastInput: "",
      color: "",
      name: "",
      createdAt: Date.now(),
      status: "idle",
      // NEW PANES START IN AUTO, not the CLI's "ask for everything" default —
      // that is what this fleet always switches to by hand, and the selector is
      // right there to change it per pane. An explicit `mode` (a view flip
      // carrying the mode across) always wins: losing it on a switch silently
      // downgrades a pane, which is exactly the quiet regression a "view"
      // toggle must not cause. Codex has its own vocabulary but happens to
      // spell this the same way.
      mode: mode || "auto",
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
    if (pane.remote) return; // transcript lives on the REMOTE disk — same "comes back empty" precedent as codex above
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
      const state = [];
      if (pane.commands) state.push({ t: "commands", commands: pane.commands });
      if (pane.models) state.push({ t: "models", models: pane.models });
      if (pane.context) state.push(pane.context);
      for (const task of pane.tasks?.values() || []) state.push({ t: "task", task });
      if (pane.status !== "working") for (const text of pane.suggestions || []) state.push({ t: "suggestion", text });
      for (const ev of state) ws.send(JSON.stringify({ t: "ev", ev }));
      ws.send(JSON.stringify({ t: "queue", items: pane.queue || [] }));
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
      } else if (m.t === "queueAdd" && typeof m.text === "string" && m.text.trim()) {
        this.queueAdd(id, m.text.slice(0, 100000));
      } else if (m.t === "queueTake" && Array.isArray(m.ids)) {
        // Edit (back into the composer) / interrupted turn: hand the texts
        // to THIS window only — whoever asked first gets them, no duplicates.
        const taken = this.queueTake(id, m.ids.map(String));
        if (taken.length && ws.readyState === 1) ws.send(JSON.stringify({ t: "queueTaken", items: taken, why: m.why || "" }));
      } else if (m.t === "queueSendNow" && typeof m.qid === "string") {
        const [item] = this.queueTake(id, [m.qid]);
        if (item) this.sendMessage(id, item.text);
      } else if (m.t === "queueDrop" && typeof m.qid === "string") {
        this.queueTake(id, [m.qid]);
      } else if (m.t === "approve" && m.requestId) {
        this.approve(id, m.requestId, m.decision, typeof m.message === "string" ? m.message.slice(0, 4000) : undefined);
      } else if (m.t === "answer" && m.requestId && m.answers && typeof m.answers === "object") {
        this.answer(id, m.requestId, m.answers);
      } else if (m.t === "interrupt") {
        pane.driver?.interrupt();
      } else if (m.t === "setMode" && typeof m.mode === "string") {
        this.setMode(id, m.mode);
      } else if (m.t === "setModel" && typeof m.model === "string" && m.model) {
        this.setModel(id, m.model);
      } else if (m.t === "rewindPreview" && typeof m.messageId === "string") {
        this.rewindPreview(id, m.messageId).then(
          (r) => ws.readyState === 1 && ws.send(JSON.stringify({ t: "rewindPreview", messageId: m.messageId, ...r })),
          () => {}
        );
      } else if (m.t === "rewind" && typeof m.messageId === "string" && typeof m.text === "string") {
        this.rewind(id, m.messageId, m.text.slice(0, 20000), !!m.restoreFiles).then(
          (r) => ws.readyState === 1 && ws.send(JSON.stringify({ t: "rewindResult", ...r })),
          (e) => ws.readyState === 1 && ws.send(JSON.stringify({ t: "rewindResult", ok: false, reason: e.message }))
        );
      } else if (m.t === "undoRewind") {
        this.undoRewind(id).then(
          (r) => ws.readyState === 1 && ws.send(JSON.stringify({ t: "undoResult", ...r })),
          () => {}
        );
      } else if (m.t === "stopTask" && typeof m.id === "string") {
        pane.driver?.stopTask?.(m.id);
      } else if (m.t === "history" && Array.isArray(m.anchors)) {
        // Older messages than the replay ring holds, read from the transcript.
        let page = { events: [], more: false };
        if (pane.provider !== "codex" && !pane.remote && pane.sdkSessionId) {
          try {
            const configDir = pane.accountConfigDir || join(homedir(), ".claude");
            page = olderEvents(configDir, pane.sdkSessionId, m.anchors.slice(0, 60).map(String));
          } catch {}
        }
        try {
          ws.send(JSON.stringify({ t: "history", events: page.events, more: page.more }));
        } catch {}
      }
    });
    ws.on("close", () => pane.clients.delete(ws));
  }

  /**
   * "Working" for the grid (box glow, Matrix rain, auto-update's idle check):
   * a turn in progress OR a background task still running after the turn
   * ended (a dev server, a long build, a subagent). The composer's Stop button
   * is NOT this — it follows the turn alone (agent-chat.ts).
   */
  _isWorking(p) {
    if (p.status === "working") return true;
    for (const t of p.tasks?.values() || []) if (t.status === "running" || t.status === "pending") return true;
    return false;
  }

  /** Stop the driver (rewind / Chrome / undo restart it): its background tasks die with it. */
  _dropDriver(pane) {
    pane.driver?.dispose();
    pane.driver = null;
    if (pane.tasks?.size) pane.tasks.clear();
    this._syncWork(pane);
  }

  /** Mirror PtyManager's "work" EDGE onto the control socket — one broadcast per change. */
  _syncWork(pane) {
    const on = this._isWorking(pane);
    if (!!pane.workOn === on) return;
    pane.workOn = on;
    this.broadcast(pane.session, { t: "work", pane: pane.id, on });
  }

  // ---- Queued messages (typed while a turn runs) --------------------------
  // Kept HERE, not in the page, so closing the app can't lose them: persisted
  // with the pane and sent by _handleEvent on the turn's clean end.

  queueAdd(id, text) {
    const pane = this.panes.get(id);
    if (!pane) return false;
    // The page thought it was mid-turn but the turn already ended: just send.
    if (pane.status !== "working" && pane.status !== "waiting_permission") return this.sendMessage(id, text);
    (pane.queue ||= []).push({ id: randomUUID().slice(0, 8), text, at: Date.now() });
    this._queueChanged(pane);
    return true;
  }

  queueTake(id, qids) {
    const pane = this.panes.get(id);
    if (!pane?.queue?.length) return [];
    const want = new Set(qids);
    const taken = pane.queue.filter((q) => want.has(q.id));
    if (!taken.length) return [];
    pane.queue = pane.queue.filter((q) => !want.has(q.id));
    this._queueChanged(pane);
    return taken;
  }

  _queueChanged(pane) {
    this._persist();
    const msg = JSON.stringify({ t: "queue", items: pane.queue || [] });
    for (const ws of pane.clients) {
      try {
        ws.send(msg);
      } catch {}
    }
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

  /** Switch a live session's model (claude only; codex reports no model). */
  async setModel(id, model) {
    const pane = this.panes.get(id);
    if (!pane?.driver?.setModel) return false;
    try {
      await pane.driver.setModel(model);
    } catch (err) {
      this._handleEvent(pane, { t: "status", state: "error", detail: err.message });
      return false;
    }
    return true;
  }

  approve(id, requestId, decision, message) {
    const pane = this.panes.get(id);
    if (!pane?.driver) return false;
    const ok = pane.driver.approve(requestId, decision, message);
    if (ok) {
      this.clearAttention(id);
      this.broadcast(pane.session, { t: "cleared", pane: id });
    }
    return ok;
  }

  // ---- Rewind: edit an earlier message and resend from there ------------------
  // The conversation is restarted at that point as a FORK (new session id, the
  // original transcript untouched — so it can be undone). Files are optionally
  // put back with the SDK's file checkpoints (only edits made by Claude's file
  // tools, in sessions that had checkpointing on); whatever a restore would
  // overwrite is copied aside first, so "Undo rewind" can put it back too.

  _rewindable(pane) {
    if (!pane) return "No such pane.";
    if (pane.provider !== "claude") return "Rewind is only available for Claude sessions.";
    if (pane.remote) return "This session runs on another machine.";
    if (!pane.sdkSessionId) return "This session has no saved history yet.";
    if (pane.status === "working" || pane.status === "waiting_permission") return "Wait for the current turn to finish (or stop it) first.";
    return null;
  }

  /** The message's transcript entry and everything a rewind needs to know about it. */
  _rewindTarget(pane, messageId) {
    const configDir = pane.accountConfigDir || join(homedir(), ".claude");
    const file = findTranscript(configDir, pane.sdkSessionId);
    if (!file) return { error: "This session's saved history couldn't be found." };
    const entries = transcriptEntries(file);
    const idx = entries.findIndex((e) => e.uuid === messageId && isHumanPrompt(e));
    if (idx < 0)
      return {
        error:
          "That message isn't in this session's saved history — it was sent before rewind support, or the conversation was compacted past it.",
      };
    const laterTurns = entries.slice(idx + 1).filter(isHumanPrompt).length;
    return { file, configDir, entry: entries[idx], laterTurns };
  }

  /** What a rewind to `messageId` would do — shown before you confirm. */
  async rewindPreview(id, messageId) {
    const pane = this.panes.get(id);
    const why = this._rewindable(pane);
    if (why) return { ok: false, reason: why };
    const t = this._rewindTarget(pane, messageId);
    if (t.error) return { ok: false, reason: t.error };
    let files = { available: false, list: [], note: "" };
    try {
      const r = await this._ensureDriver(pane).rewindFiles(messageId, true);
      files = r?.canRewind
        ? { available: true, list: r.filesChanged || [], insertions: r.insertions || 0, deletions: r.deletions || 0 }
        : { available: false, list: [], note: r?.error || "No file backups for this session (it started before they were turned on)." };
    } catch (e) {
      files = { available: false, list: [], note: "File backups aren't available for this session." };
    }
    return { ok: true, laterTurns: t.laterTurns, files };
  }

  /** Copy what a file restore is about to overwrite, so Undo can put it back. */
  _backupFiles(pane, paths) {
    const dir = join(homedir(), ".fleetview", "rewind-backups", `${pane.id}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const files = paths.map((path, i) => {
      try {
        if (statSync(path).isFile()) {
          copyFileSync(path, join(dir, String(i)));
          return { path, existed: true, copy: String(i) };
        }
      } catch {}
      return { path, existed: false };
    });
    return { dir, files };
  }

  _restoreBackup(backup) {
    for (const f of backup.files) {
      try {
        if (f.existed) {
          mkdirSync(dirname(f.path), { recursive: true });
          copyFileSync(join(backup.dir, f.copy), f.path);
        } else if (existsSync(f.path)) {
          unlinkSync(f.path); // the rewind brought it back; before, it didn't exist
        }
      } catch {}
    }
  }

  _dropBackup(undo) {
    if (undo?.backup?.dir) rmSync(undo.backup.dir, { recursive: true, force: true });
  }

  /** Replace every attached window's log with `events` (after a rewind or undo). */
  _replayAll(pane, events) {
    pane.events = events.slice(-(RING_BUFFER_SIZE - 10));
    pane._hydrated = true;
    pane.suggestions = [];
    const msg = JSON.stringify({ t: "replay", events: pane.events });
    for (const ws of pane.clients) {
      try {
        ws.send(msg);
      } catch {}
    }
  }

  /**
   * Edit message `messageId` to `text` and resend from there. Returns
   * `{ ok, reason?, restored? }`.
   */
  async rewind(id, messageId, text, restoreFiles) {
    const pane = this.panes.get(id);
    const why = this._rewindable(pane);
    if (why) return { ok: false, reason: why };
    const body = String(text || "").trim();
    if (!body) return { ok: false, reason: "The edited message is empty." };
    const t = this._rewindTarget(pane, messageId);
    if (t.error) return { ok: false, reason: t.error };

    let backup = null;
    if (restoreFiles) {
      const driver = this._ensureDriver(pane);
      const dry = await driver.rewindFiles(messageId, true).catch((e) => ({ canRewind: false, error: e.message }));
      if (!dry?.canRewind) return { ok: false, reason: dry?.error || "Files can't be restored for this session." };
      backup = this._backupFiles(pane, dry.filesChanged || []);
      const done = await driver.rewindFiles(messageId, false).catch((e) => ({ canRewind: false, error: e.message }));
      if (!done?.canRewind) {
        this._restoreBackup(backup); // undo any partial restore
        this._dropBackup({ backup });
        return { ok: false, reason: done?.error || "Restoring files failed; nothing was changed." };
      }
    }

    // Keep exactly one level of undo: a new rewind retires the previous one.
    this._dropBackup(pane.rewindUndo);
    pane.rewindUndo = { sdkSessionId: pane.sdkSessionId, backup };

    // Restart the conversation as a fork, just before the edited message.
    this._dropDriver(pane);
    const parent = t.entry.parentUuid || null;
    if (parent) pane.resumeAt = { at: parent };
    else {
      pane.sdkSessionId = null; // editing the very first message: a fresh session
      pane.resumeAt = null;
    }

    // Everything the chat showed before that message, then the new message.
    const all = eventsFromTranscript(t.file, Infinity).filter((e) => e.t !== "status");
    const cut = all.findIndex((e) => e.t === "user" && e.id === messageId);
    this._replayAll(pane, cut >= 0 ? all.slice(0, cut) : []);
    this._persist();
    this.sendMessage(id, body);
    return { ok: true, restored: backup ? backup.files.length : 0, removedTurns: t.laterTurns + 1 };
  }

  /**
   * Turn Claude in Chrome on/off for a chat session WITHOUT losing it: the
   * driver is restarted resuming the same conversation (sdkSessionId), now with
   * (or without) --chrome. Refused mid-turn — a restart would cut the reply off.
   */
  setChrome(id, on) {
    const pane = this.panes.get(id);
    if (!pane) return { ok: false, reason: "No such session." };
    if (pane.provider !== "claude") return { ok: false, reason: "Claude in Chrome is a Claude feature." };
    if (pane.remote) return { ok: false, reason: "Chrome runs on this machine — not for a session on another one." };
    if (pane.status === "working" || pane.status === "waiting_permission")
      return { ok: false, reason: "Wait for the current turn to finish (or stop it) first." };
    if (!!pane.chrome === !!on) return { ok: true, chrome: !!on };
    pane.chrome = !!on;
    this._dropDriver(pane); // the next message (or attach) resumes the same session with the new flag
    this._persist();
    this._ensureDriver(pane);
    this.broadcast(pane.session, { t: "chrome", pane: id, on: !!on });
    return { ok: true, chrome: !!on };
  }

  /** Put the conversation (and any restored files) back as they were before the last rewind. */
  async undoRewind(id) {
    const pane = this.panes.get(id);
    const undo = pane?.rewindUndo;
    if (!undo) return { ok: false, reason: "Nothing to undo." };
    if (pane.status === "working" || pane.status === "waiting_permission")
      return { ok: false, reason: "Wait for the current turn to finish (or stop it) first." };
    this._dropDriver(pane);
    if (undo.backup) this._restoreBackup(undo.backup);
    this._dropBackup(undo);
    pane.rewindUndo = null;
    pane.resumeAt = null;
    pane.sdkSessionId = undo.sdkSessionId;
    const configDir = pane.accountConfigDir || join(homedir(), ".claude");
    this._replayAll(pane, restoreEvents(configDir, pane.sdkSessionId, RING_BUFFER_SIZE - 10));
    this._persist();
    return { ok: true };
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

  sdkSessionIdOf(id) {
    return this.panes.get(id)?.sdkSessionId || null;
  }

  /** Open approvals / questions, oldest first, plus the last reply — for the fleet inbox. */
  /** The latest complete assistant reply (in memory only), or "". */
  lastReplyOf(id) {
    return this.panes.get(id)?.finalReply || "";
  }

  inboxOf(id) {
    const pane = this.panes.get(id);
    if (!pane) return null;
    return { pending: [...(pane.pending?.values() || [])], lastReply: pane.lastReply || "", status: pane.status };
  }

  info(id) {
    const p = this.panes.get(id);
    if (!p) return null;
    return {
      id: p.id,
      kind: "agent",
      cwd: p.cwd,
      cmd: p.cmd,
      chrome: !!p.chrome,
      reviewOf: p.reviewOf || null,
      session: p.session,
      // See PtyManager.info — needed for registry.list()'s cross-manager sort.
      order: p.order,
      attention: p.attention,
      working: this._isWorking(p),
      followUp: p.followUp,
      lastInput: p.lastInput || "",
      color: p.color || "",
      name: p.name || "",
      createdAt: p.createdAt,
      mode: p.mode || "default",
      model: p.model || null,
      remote: p.remote || null,
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

  // `session` ignored — one workspace per machine (see pane-registry.js).
  idsOf() {
    return [...this.panes.values()].map((p) => p.id);
  }

  // Mirrors PtyManager.reorder's per-manager-local sequential numbering
  // exactly (increments only on a match) — see pane-registry.js for the
  // known limitation this produces when a drag-reorder mixes pty and agent
  // panes in the same window.
  reorder(_session, ids) {
    let i = 0;
    for (const id of ids) {
      const p = this.panes.get(id);
      if (p) p.order = i++;
    }
    this._persist();
  }

  /**
   * Assign order from an id -> position map computed ACROSS both managers.
   * `reorder` above can't do that job: it numbers only the ids it owns, 0..n,
   * so a grid holding both kinds ends up with two independent sequences and
   * every position collides with its opposite number. That was survivable when
   * kinds rarely mixed; flipping a pane's view mixes them constantly.
   */
  applyOrder(orderById) {
    for (const [id, n] of orderById) {
      const p = this.panes.get(id);
      if (p) p.order = n;
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
