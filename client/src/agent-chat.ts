import { PaneInfo, PaneView, TermHost, displayName, basename, workingOverlay, setBusyClass, UsageRow, UsageWindow } from "./terminal";
import { AgentEvent, AgentQuestion } from "./agent-events";
import { uploadFiles, wireFileDrop, wireFilePicker } from "./attach";
import { renderMarkdown } from "./markdown";
import { enhanceRich } from "./rich";
import { attachSecretPopover } from "./secret-popover";

function el(tag: string, cls: string): HTMLElement {
  const n = document.createElement(tag);
  n.className = cls;
  return n;
}

function formatToolInput(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

// The one field that says what a call actually DID, so a collapsed card reads
// "Bash · npm run build" instead of a bare "Bash" that you have to open to
// identify. Ordered most- to least-specific; unknown tools just get their
// name, same as before. Any provider's tools work here (codex-driver.js maps
// its own items onto the same `{name,input}` shape) — these are the field
// names the common ones happen to use, not an exhaustive registry.
const TOOL_DETAIL_KEYS = ["command", "file_path", "path", "pattern", "url", "query", "prompt"];
function toolDetail(input: unknown): string {
  if (typeof input === "string") return input;
  if (!input || typeof input !== "object") return "";
  const rec = input as Record<string, unknown>;
  for (const key of TOOL_DETAIL_KEYS) {
    const v = rec[key];
    if (typeof v === "string" && v.trim()) return v.trim().replace(/\s+/g, " ");
  }
  return "";
}

/**
 * A "made for mobile" alternative to `Term`: instead of a PTY rendered
 * through xterm.js, this talks to the server's `/agent?pane=` WS, which is
 * backed by the Claude Agent SDK (see server/agent-manager.js) — messages,
 * tool calls, and permission requests arrive as normalized `AgentEvent`s,
 * not terminal bytes, so there's no cursor to fight and the log is a plain
 * `overflow-y:auto` element (real native scrolling, no touch-scroll hacks).
 *
 * Implements the same `PaneView` contract `Term` does, so main.ts's grid,
 * zoom, tray, drag, and attention-queue code needs zero changes to host
 * this alongside terminal panes — see terminal.ts's `PaneView` doc comment.
 */
/**
 * Turn a model id into something that fits a badge: "claude-opus-4-5-20260315"
 * -> "Opus 4.5". Falls back to the raw id minus the vendor prefix and date
 * suffix, so an unrecognised model still reads as something rather than
 * vanishing — the full id is always on the title attribute.
 */
function shortModel(id: string): string {
  const m = /(opus|sonnet|haiku)[-_]?(\d+)(?:[-.](\d+))?/i.exec(id);
  if (!m) return id.replace(/^claude-/, "").replace(/-\d{8}$/, "");
  const name = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
  return m[3] ? `${name} ${m[2]}.${m[3]}` : `${name} ${m[2]}`;
}

/** "5-hour" -> "5h", "7-day" -> "7d". Codex labels are data-driven, so fall back. */
function winShort(label: string): string {
  const m = /^(\d+)[-\s]*(hour|day|week|min)/i.exec(label);
  if (!m) return label.slice(0, 3);
  return m[1] + m[2][0].toLowerCase();
}

/**
 * A usage window as a small ring meter. This is the "single ratio against a
 * limit" case, so it is a meter, not a pie — and the percentage is ALWAYS
 * rendered in normal ink beside/inside the ring, never conveyed by colour
 * alone. That matters twice over: status colour must carry a label to be
 * accessible, and the amber step is deliberately low-contrast on a light
 * surface, so the numeral is what stays readable.
 */
const RING_NS = "http://www.w3.org/2000/svg";

function usageRing(win: UsageWindow): HTMLElement {
  const size = 20; // sits inside the 28px pill alongside its label
  const stroke = 3;
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, Math.round(win.percent)));

  const wrap = el("span", "ring " + usageLevel(pct));
  const svg = document.createElementNS(RING_NS, "svg");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.setAttribute("aria-hidden", "true"); // the text below carries it for AT

  const mk = (cls: string, dash?: string) => {
    const c = document.createElementNS(RING_NS, "circle");
    c.setAttribute("cx", String(size / 2));
    c.setAttribute("cy", String(size / 2));
    c.setAttribute("r", String(r));
    c.setAttribute("fill", "none");
    c.setAttribute("stroke-width", String(stroke));
    c.setAttribute("class", cls);
    if (dash) {
      c.setAttribute("stroke-dasharray", dash);
      c.setAttribute("stroke-linecap", "round");
      // start at 12 o'clock instead of 3
      c.setAttribute("transform", `rotate(-90 ${size / 2} ${size / 2})`);
    }
    return c;
  };
  svg.append(mk("ring-track"));
  if (pct > 0) svg.append(mk("ring-fill", `${(pct / 100) * circ} ${circ}`));

  const num = el("b", "ring-num");
  num.textContent = String(pct);
  const tag = el("i", "ring-tag");
  tag.textContent = winShort(win.label);

  const face = el("span", "ring-face");
  face.append(svg, num);
  wrap.append(face, tag);
  wrap.title =
    `${win.label}: ${pct}% used` + (win.resetsAt ? ` · resets ${resetAt(win.resetsAt)}` : "");
  return wrap;
}

/** Same thresholds as the settings panel's bars — one shared ramp (main.ts). */
function usageLevel(pct: number): string {
  if (pct >= 90) return "crit";
  if (pct >= 75) return "warn";
  return "ok";
}

function resetAt(at: number): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const today = new Date().toDateString() === d.toDateString();
  return today ? time : `${d.toLocaleDateString([], { weekday: "short" })} ${time}`;
}

export class AgentChat implements PaneView {
  id: string;
  info: PaneInfo;
  cell: HTMLElement;
  el: HTMLElement;
  titleBar: HTMLElement;

  private logEl: HTMLElement;
  private statusEl: HTMLElement;
  private pinnedEl: HTMLElement;
  private badgeSlot: HTMLElement;
  private acctSlot!: HTMLElement;
  private modeSel: HTMLSelectElement;
  private isCodex: boolean;
  private isRemote: boolean;
  private inputEl: HTMLTextAreaElement;
  private toolsEl!: HTMLElement;
  private stopBtn!: HTMLButtonElement;
  private jumpBtn!: HTMLButtonElement;
  private modelEl!: HTMLElement;
  private usageEl!: HTMLElement;
  private ws?: WebSocket;
  private reconnectTimer?: number;
  private disposed = false;
  private toolEls = new Map<string, HTMLElement>(); // tool_call id -> card, so a later tool_result can update it
  private permEls = new Map<string, HTMLElement>(); // permission requestId -> card
  private questionEls = new Map<string, HTMLElement>(); // AskUserQuestion requestId -> card
  private streamingEls = new Map<string, HTMLElement>(); // assistant_delta id -> bubble being built

  // Consecutive tool_call events collapse into a single expandable group
  // instead of each getting its own full-width row — a turn with 8+ Read/Bash
  // calls used to render as a wall of near-identical pills before any actual
  // conversation text. Any non-tool event (bubble, permission card) or a
  // full replay closes the current group, so grouping only spans one
  // unbroken run of tool calls.
  private toolGroupEl: HTMLElement | null = null;
  private toolGroupBody: HTMLElement | null = null;
  private toolGroupNames: string[] = [];

  constructor(info: PaneInfo, host: TermHost) {
    this.id = info.id;
    this.info = info;

    this.cell = el("div", "cell");
    this.el = el("div", "term agent");
    this.titleBar = el("div", "title");
    // Same classes/structure as Term's title bar (minus the color swatch —
    // color-coding a chat pane isn't wired up yet, see setColor() below —
    // and minus Term's attach button: Term only has the title-bar one, but
    // a chat pane also has one built into the input bar at the bottom next
    // to the textarea, which is the natural place to reach for it while
    // typing, so the title-bar one would just be a redundant second copy)
    // so the existing zoom/drag/mobile-collapse CSS and main.ts wiring apply
    // with no changes.
    this.titleBar.innerHTML =
      `<button class="ctl back" title="Back">‹</button>` +
      `<span class="dot">●</span>` +
      `<span class="path"></span>` +
      `<select class="mode-sel" title="Permission mode">` +
      `<option value="default">Ask</option>` +
      `<option value="acceptEdits">Auto-edit</option>` +
      `<option value="auto">Auto</option>` +
      `<option value="plan">Plan</option>` +
      `<option value="bypassPermissions">Bypass</option>` +
      `</select>` +
      `<span class="badge-slot"></span>` +
      `<span class="spacer"></span>` +
      // Account/host badges live in their OWN slot, not in .badge-slot:
      // setWaiting() clears .badge-slot on every attention change, which would
      // wipe them permanently the first time the pane said "needs you".
      `<span class="acct-slot"></span>` +
      `<button class="ctl flag" title="Mark for follow-up">⚑</button>` +
      `<button class="ctl min" title="Minimize">–</button>` +
      `<button class="ctl close" title="Close">✕</button>`;
    (this.titleBar.querySelector(".path") as HTMLElement).textContent = displayName(info);
    (this.titleBar.querySelector(".path") as HTMLElement).title = info.cwd;
    this.badgeSlot = this.titleBar.querySelector(".badge-slot") as HTMLElement;
    this.acctSlot = this.titleBar.querySelector(".acct-slot") as HTMLElement;

    // Permission-mode selector: which mode this session runs under, and the
    // only way to change it — there's no separate terminal TUI here to show
    // the agent's own mode indicator, since this view talks to the Agent SDK /
    // app-server directly.
    //
    // The two providers do NOT share a mode vocabulary, so neither does this
    // control. Claude has one permissionMode enum (default = ask for
    // everything, acceptEdits = auto-approve file edits, auto = route each
    // prompt through a model classifier, plan = read-only/no execution,
    // bypassPermissions = approve everything). Codex has two orthogonal axes
    // (approvalPolicy × sandboxPolicy), so it gets its OWN three options named
    // the way Codex names them, rather than being squeezed into Claude's
    // words — see CODEX_MODES in codex-driver.js for the exact pairs.
    this.modeSel = this.titleBar.querySelector(".mode-sel") as HTMLSelectElement;
    this.isCodex = info.cmd === "codex" || info.cmd === "codex-work";
    if (this.isCodex) {
      this.modeSel.innerHTML =
        `<option value="read-only">Read Only</option>` +
        `<option value="auto">Auto</option>` +
        `<option value="full-access">Full Access</option>`;
    }
    // Authored in the title-bar HTML string above only because that is where
    // its <option> list was easiest to write; it is MOVED (not cloned) into the
    // tools row below, next to the other pane-level controls. Detach it here so
    // the title bar is left with just name + flag/min/close.
    this.modeSel.remove();
    this.setModeUI(info.mode || (this.isCodex ? "auto" : "default"));
    // Not `.ctl` (which enableDrag() in main.ts already excludes from the
    // drag handle) — that class also carries Term's 20x18 icon-button
    // sizing, which would squash this chip-styled <select>. Stopping
    // pointerdown/click here does the same drag/zoom exclusion without
    // pulling that sizing in.
    this.modeSel.addEventListener("pointerdown", (e) => e.stopPropagation());
    this.modeSel.addEventListener("click", (e) => e.stopPropagation());
    this.modeSel.addEventListener("change", () => {
      this.wsSend({ t: "setMode", mode: this.modeSel!.value });
    });

    // Work-account panes (opened via "claude (work)" / "codex (work)") get a
    // didit-blue title tint, same as Term's — `.term.work .title` in
    // styles.css already covers that, it just needed the `work` class here
    // too. Term also overlays a big faint logo watermark across the whole
    // terminal, but there's no equivalent open canvas here (it's a column of
    // chat bubbles, not a blank viewport) and a mobile-sized box can't spare
    // the room anyway — a small badge in the title bar reads better at that
    // size, so it's a separate `.work-badge` element instead of reusing
    // Term's `.work-logo`. Sits directly left of the mode selector (which is
    // itself already positioned right before the flag button above), so the
    // right-hand cluster reads badge → mode → flag → min → close.
    if (info.cmd === "claude-work" || info.cmd === "codex-work") {
      this.el.classList.add("work");
      const badge = document.createElement("img");
      badge.className = "work-badge";
      badge.src = "/didit-logo-white.png";
      badge.alt = "Work account";
      badge.title = "Work account";
      this.acctSlot.append(badge);
    }
    // Remote (ssh) panes: claude/codex is running on another host, not here
    // (see server/ssh-remote-agent.js) — a small text badge, same slot/sizing
    // family as the work-account image badge above, since there's no logo
    // asset for an arbitrary hostname.
    this.isRemote = !!info.remote;
    if (info.remote) {
      const badge = el("span", "remote-badge");
      badge.textContent = "⇢ " + info.remote.target;
      badge.title = "Running on " + info.remote.target;
      this.acctSlot.append(badge);
    }

    const cwdline = el("div", "cwdline");
    cwdline.textContent = info.cwd;
    this.pinnedEl = el("div", "pinned");
    this.pinnedEl.hidden = true;

    const chat = el("div", "chat");
    this.logEl = el("div", "chat-log");
    this.statusEl = el("div", "status-line");
    this.statusEl.hidden = true;
    // ---- Tools row ------------------------------------------------------
    // One home for every pane-level control, directly above the composer:
    // actions on the left (attach, view flip, secret, permission mode), live
    // state on the right (model, jump-to-latest, stop, usage). These used to be
    // split between the title bar and the input bar — but a title bar already
    // carrying a name, a drag handle and four window controls has no room for
    // state, and a control you reach for WHILE typing belongs next to where you
    // type.
    this.toolsEl = el("div", "chat-tools");

    const attachBtn = el("button", "ctl attach") as HTMLButtonElement;
    attachBtn.textContent = "⊕";
    attachBtn.title = "Add file(s)";
    const viewBtn = el("button", "ctl view") as HTMLButtonElement;
    viewBtn.textContent = "▤";
    viewBtn.title = "Switch this box to terminal view";
    const secretBtn = el("button", "ctl secret") as HTMLButtonElement;
    secretBtn.textContent = "⚿";
    secretBtn.title = "Give this chat a secret (never saved to chat memory)";

    this.modelEl = el("span", "model-badge");
    this.modelEl.hidden = true;
    this.jumpBtn = el("button", "ctl jump") as HTMLButtonElement;
    this.jumpBtn.textContent = "↓";
    this.jumpBtn.title = "Jump to latest";
    this.jumpBtn.hidden = true;
    // Interrupt. Until this existed a chat pane could not cancel a running turn
    // at all: no softkeys, no PTY, so no Esc to send. The server and both
    // drivers already understood {t:"interrupt"} — nothing was sending it.
    this.stopBtn = el("button", "ctl stop") as HTMLButtonElement;
    this.stopBtn.textContent = "■";
    this.stopBtn.title = "Stop this turn";
    this.stopBtn.hidden = true;
    this.usageEl = el("span", "use-rings");

    this.toolsEl.append(
      attachBtn,
      viewBtn,
      secretBtn,
      this.modeSel,
      this.modelEl,
      el("span", "spacer"),
      this.jumpBtn,
      this.stopBtn,
      this.usageEl
    );
    if (info.model) this.setModel(info.model);

    const inputBar = el("div", "chat-input");
    this.inputEl = document.createElement("textarea");
    this.inputEl.rows = 1;
    this.inputEl.placeholder = "Message…";
    const sendBtn = el("button", "chat-send");
    sendBtn.textContent = "Send";
    // Phone-only (CSS decides): the tools row is wider than a 390px composer
    // can spare, so on mobile it collapses behind this and opens as a wrapped
    // row above the input. Lives in the input bar so it sits where the old
    // attach button did — thumb-reachable, next to what it acts on.
    const menuBtn = el("button", "chat-menu") as HTMLButtonElement;
    menuBtn.textContent = "☰";
    menuBtn.title = "Tools";
    menuBtn.setAttribute("aria-label", "Tools");
    inputBar.append(menuBtn, this.inputEl, sendBtn);
    chat.append(this.logEl, this.statusEl, this.toolsEl, inputBar, workingOverlay());

    this.el.append(this.titleBar, cwdline, this.pinnedEl, chat);
    this.cell.append(this.el);
    this.setBusy(!!info.working);

    this.wireRename(host);
    this.wireTitleBarButtons(host);
    // Both features write a file/secret to a path on FLEETVIEW'S OWN local
    // disk and hand that path to the driver as chat text — meaningless for a
    // remote pane, since claude/codex is running on a different machine and
    // can't read it (see the plan: a real fix means scp'ing bytes to the
    // remote host instead, not done here). Hide, don't wire — a visible but
    // silently-broken button would be worse than no button.
    if (this.isRemote) {
      secretBtn.hidden = true;
      attachBtn.hidden = true;
    } else {
      attachSecretPopover(secretBtn, this.el, host, this);
      // The popover defaults to hanging under the title bar; its anchor now
      // lives at the BOTTOM of the box, so open it upward instead.
      this.el.querySelector(".spop")?.classList.add("up");
      wireFilePicker(attachBtn, this.el, (files) => void this.attachFiles(files));
      wireFileDrop(this.el, (files) => void this.attachFiles(files));
    }

    menuBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.el.classList.toggle("tools-open");
    });
    // Any button in the row finishes the job it was opened for, so close after
    // it. The mode <select> is excluded — picking a mode is the whole action
    // and the row collapsing out from under an open dropdown is jarring.
    this.toolsEl.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".ctl")) this.el.classList.remove("tools-open");
    });

    viewBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      host.onFlipView(this);
    });
    this.stopBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.wsSend({ t: "interrupt" });
    });
    this.jumpBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.logEl.scrollTop = this.logEl.scrollHeight;
      this.jumpBtn.hidden = true;
    });
    // Offer the jump button only when it would actually do something. 24px of
    // slack keeps it from flickering on during momentum scrolling at the bottom.
    this.logEl.addEventListener("scroll", () => {
      const room = this.logEl.scrollHeight - this.logEl.scrollTop - this.logEl.clientHeight;
      this.jumpBtn.hidden = room < 24;
    });

    sendBtn.addEventListener("click", () => this.submit());
    this.inputEl.addEventListener("keydown", (e) => {
      e.stopPropagation(); // don't let Escape/etc bubble to the app-level zoom handler
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.submit();
      }
    });
    this.inputEl.addEventListener("input", () => this.autoGrow());

    // Click the box (outside controls/input) opens/zooms it, same as Term.
    this.el.addEventListener("click", (e) => {
      const tgt = e.target as HTMLElement;
      if (tgt.closest(".ctl") || tgt.closest(".chat-input") || tgt.closest(".chat-tools")) return;
      host.onOpen(this);
    });

    if (info.attention?.waiting && info.attention.kind) this.setWaiting(true, info.attention.kind);
    if (info.followUp) this.setFollowUp(true);
    if (info.lastInput) this.setLastInput(info.lastInput);
    if (info.color) this.setColor(info.color);

    this.connect();
  }

  private wireTitleBarButtons(host: TermHost) {
    this.titleBar.querySelector(".back")!.addEventListener("click", (e) => {
      e.stopPropagation();
      host.onBack(this);
    });
    this.titleBar.querySelector(".min")!.addEventListener("click", (e) => {
      e.stopPropagation();
      host.onMinimize(this);
    });
    this.titleBar.querySelector(".close")!.addEventListener("click", (e) => {
      e.stopPropagation();
      host.onClose(this);
    });
    this.titleBar.querySelector(".flag")!.addEventListener("click", (e) => {
      e.stopPropagation();
      host.onToggleFollowUp(this);
    });
  }

  /** Click the title text → edit it in place. Mirrors Term.wireRename. */
  private wireRename(host: TermHost) {
    const pathEl = this.titleBar.querySelector(".path") as HTMLElement;
    pathEl.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this.titleBar.querySelector(".rename")) return;
      const input = document.createElement("input");
      input.className = "rename";
      input.type = "text";
      input.maxLength = 60;
      input.value = displayName(this.info);
      input.placeholder = basename(this.info.cwd);
      pathEl.hidden = true;
      pathEl.after(input);
      input.focus();
      input.select();
      let done = false;
      const finish = (save: boolean) => {
        if (done) return;
        done = true;
        input.remove();
        pathEl.hidden = false;
        if (!save) return;
        let name = input.value.trim();
        if (name === basename(this.info.cwd)) name = "";
        if (name === (this.info.name || "")) return;
        this.setName(name);
        host.onRename(this, name);
      };
      input.addEventListener("keydown", (ev) => {
        ev.stopPropagation();
        if (ev.key === "Enter") finish(true);
        else if (ev.key === "Escape") finish(false);
      });
      input.addEventListener("blur", () => finish(true));
      input.addEventListener("click", (ev) => ev.stopPropagation());
      input.addEventListener("pointerdown", (ev) => ev.stopPropagation());
    });
  }

  // ---- WebSocket -----------------------------------------------------

  private connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/agent?pane=${this.id}`);
    this.ws = ws;
    ws.onmessage = (e) => {
      let m: { t: string; events?: AgentEvent[]; ev?: AgentEvent };
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (m.t === "replay" && m.events) {
        this.logEl.innerHTML = "";
        this.toolEls.clear();
        this.permEls.clear();
        this.questionEls.clear();
        this.streamingEls.clear();
        this.endToolGroup();
        for (const ev of m.events) this.applyEvent(ev);
        this.scrollToBottom();
      } else if (m.t === "ev" && m.ev) {
        this.applyEvent(m.ev);
        this.scrollToBottom();
      }
    };
    // Compare against `this.ws`, not just `!this.disposed`: reconnectNow() (see
    // below) replaces `this.ws` with a fresh socket and closes this old one out
    // from under it. That old socket's onclose still fires (asynchronously,
    // after this.ws already points at the new one) — without this check it
    // would schedule a SECOND, redundant reconnect ~1s later, leaving two live
    // sockets both receiving/rendering every broadcast event: every user
    // message and reply painted twice. Mirrors terminal.ts's Term.connect(),
    // which had the same bug fixed already.
    ws.onclose = () => {
      if (this.ws === ws) this.scheduleReconnect();
    };
  }

  private scheduleReconnect(delay = 1000) {
    if (this.disposed || this.reconnectTimer != null) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
  }

  /** Drop the current socket and reconnect immediately (e.g. on tab foreground/pageshow — see main.ts). */
  reconnectNow() {
    if (this.disposed) return;
    if (this.reconnectTimer != null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    const old = this.ws;
    if (old) {
      old.onclose = null; // we're reconnecting ourselves; don't double-schedule
      old.onerror = null;
      old.onmessage = null;
      try {
        old.close();
      } catch {}
    }
    this.connect();
  }

  private wsSend(m: object) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(m));
      } catch {}
    }
  }

  // ---- Input -----------------------------------------------------------

  private submit() {
    const text = this.inputEl.value.trim();
    if (!text) return;
    this.inputEl.value = "";
    this.autoGrow();
    this.wsSend({ t: "send", text });
  }

  private autoGrow() {
    this.inputEl.style.height = "auto";
    this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 160) + "px";
  }

  private async attachFiles(files: File[]) {
    const paths = await uploadFiles(this.id, files);
    if (!paths.length) return;
    this.inputEl.value = (this.inputEl.value ? this.inputEl.value + " " : "") + paths.join(" ") + " ";
    this.autoGrow();
    this.inputEl.focus();
  }

  // ---- Event rendering ---------------------------------------------------

  private applyEvent(ev: AgentEvent) {
    switch (ev.t) {
      case "user":
        this.appendBubble("user", ev.text);
        break;
      case "assistant_done": {
        // codex-driver.js streams this SAME message as assistant_delta first,
        // so a bubble for this id usually already exists and is fully
        // rendered — finalize it in place. Appending unconditionally rendered
        // every codex message twice. (`AgentMessageDeltaNotification.itemId`
        // and the `agentMessage` `ThreadItem.id` are the same item id —
        // verified against `codex app-server generate-ts` — so this lookup
        // hits.) claude-driver.js sends no deltas, so it takes the else branch
        // exactly as before.
        const streamed = this.streamingEls.get(ev.id);
        this.streamingEls.delete(ev.id);
        let bubbleEl: HTMLElement;
        if (streamed) {
          // Trust the completed item's text over the accumulated deltas: it's
          // the authoritative final form, and re-rendering from it repairs a
          // bubble that dropped a delta mid-stream.
          streamed.dataset.raw = ev.text;
          streamed.innerHTML = renderMarkdown(ev.text);
          // Charts/tables/clipping are built HERE and not on each delta: a
          // half-streamed ```chart block is invalid JSON, and rebuilding SVG
          // per token would thrash. The bubble reads as plain Markdown while
          // it streams and gains its rich layer the moment it's complete.
          enhanceRich(streamed);
          bubbleEl = streamed;
        } else {
          bubbleEl = this.appendBubble("assistant", ev.text);
        }
        // claude-driver.js only sets this when the SDK itself says the
        // message was truncated by an interrupt/abort — the content may end
        // mid-word. Mark it the same way updateToolCard marks a failed tool
        // result, so it doesn't read as a normal, if oddly-worded, finish.
        bubbleEl.classList.toggle("aborted", !!ev.aborted);
        break;
      }
      case "assistant_delta": {
        // Emitted by codex-driver.js (claude-driver.js has no partial-message
        // streaming). Keeps the raw source in a dataset field so each delta
        // re-renders the whole accumulated Markdown rather than appending to
        // already-rendered HTML.
        let bubble = this.streamingEls.get(ev.id);
        if (!bubble) {
          bubble = this.appendBubble("assistant", "");
          this.streamingEls.set(ev.id, bubble);
        }
        bubble.dataset.raw = (bubble.dataset.raw || "") + ev.delta;
        bubble.innerHTML = renderMarkdown(bubble.dataset.raw);
        break;
      }
      case "tool_call":
        this.appendToolCard(ev.id, ev.name, ev.input);
        break;
      case "tool_result":
        this.updateToolCard(ev.id, ev.output, ev.isError, ev.diff);
        break;
      case "permission_request":
        this.appendPermissionCard(ev);
        break;
      case "permission_resolved":
        this.resolvePermissionCard(ev.requestId, ev.decision);
        break;
      case "question":
        this.appendQuestionCard(ev);
        break;
      case "question_resolved":
        this.resolveQuestionCard(ev.requestId, ev.answers);
        break;
      case "status":
        this.setStatus(ev.state, ev.detail);
        break;
      case "mode":
        this.setModeUI(ev.mode);
        break;
    }
  }

  private appendBubble(role: "user" | "assistant" | "error" | "aborted", text: string): HTMLElement {
    this.endToolGroup();
    const bubble = el("div", `msg ${role}`);
    // Assistant text is Markdown (renderMarkdown escapes untrusted source
    // before adding any markup — see markdown.ts). User/error/aborted text
    // stays literal: the user typed it, or it's FleetView's own notice text,
    // neither should be reinterpreted as Markdown.
    if (role === "assistant") bubble.innerHTML = renderMarkdown(text);
    else bubble.textContent = text;
    this.logEl.append(bubble);
    // After the append, so the rich pass can measure real laid-out height.
    // Runs for user bubbles too — they carry no Markdown, but a pasted wall of
    // text is exactly as unreadable from either speaker, and clipping is the
    // only step that finds anything to do there.
    if (role !== "error" && role !== "aborted") enhanceRich(bubble);
    return bubble;
  }

  private appendToolCard(id: string, name: string, input: unknown) {
    const details = document.createElement("details");
    details.className = "tool-card";
    details.open = false;
    const summary = document.createElement("summary");
    const detail = toolDetail(input);
    summary.textContent = detail ? `⚙ ${name} · ${detail}` : `⚙ ${name}`;
    summary.title = summary.textContent; // the CSS ellipsis hides long commands
    const body = document.createElement("pre");
    body.className = "tool-input";
    body.textContent = formatToolInput(input);
    details.append(summary, body);
    this.toolGroup().append(details);
    this.toolEls.set(id, details);
    this.toolGroupNames.push(name);
    this.renderToolGroupSummary();
  }

  /** Current run's group container, creating one if the last thing appended wasn't a tool call. */
  private toolGroup(): HTMLElement {
    if (this.toolGroupBody) return this.toolGroupBody;
    const group = document.createElement("details");
    group.className = "tool-group";
    group.open = false;
    const summary = document.createElement("summary");
    const body = el("div", "tool-group-body");
    group.append(summary, body);
    this.logEl.append(group);
    this.toolGroupEl = group;
    this.toolGroupBody = body;
    this.toolGroupNames = [];
    return body;
  }

  private renderToolGroupSummary() {
    if (!this.toolGroupEl) return;
    const n = this.toolGroupNames.length;
    const preview = this.toolGroupNames.slice(0, 4).join(", ") + (n > 4 ? `, +${n - 4} more` : "");
    (this.toolGroupEl.querySelector("summary") as HTMLElement).textContent =
      `⚙ ${n} tool call${n === 1 ? "" : "s"}: ${preview}`;
  }

  private endToolGroup() {
    this.toolGroupEl = null;
    this.toolGroupBody = null;
    this.toolGroupNames = [];
  }

  private updateToolCard(id: string, output: string, isError: boolean, diff?: string) {
    let card = this.toolEls.get(id);
    if (!card) {
      // A tool_result with no matching tool_call in this session — e.g. we
      // reconnected mid-turn and missed the ring buffer's earlier entry.
      this.appendToolCard(id, "tool result", null);
      card = this.toolEls.get(id)!;
    }
    card.classList.toggle("error", isError);
    // Surface the error on the (possibly already-collapsed) group too, so a
    // failed call isn't hidden behind a summary line that only shows names.
    if (isError) card.closest(".tool-group")?.classList.add("error");
    if (diff) {
      const pre = document.createElement("pre");
      pre.className = "tool-diff";
      pre.innerHTML = diff
        .split("\n")
        .map((line) => {
          const cls = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "";
          const span = document.createElement("span");
          span.className = cls;
          span.textContent = line;
          return span.outerHTML;
        })
        .join("\n");
      card.append(pre);
    } else {
      const out = document.createElement("pre");
      out.className = "tool-output";
      out.textContent = output;
      card.append(out);
    }
  }

  private appendPermissionCard(ev: Extract<AgentEvent, { t: "permission_request" }>) {
    this.endToolGroup();
    const card = el("div", "permission-card");
    const text = el("div", "perm-text");
    text.textContent = ev.title || ev.description || `Allow "${ev.tool}"?`;
    const btns = el("div", "perm-btns");
    const mk = (label: string, decision: "allow" | "deny" | "always", cls: string) => {
      const b = document.createElement("button");
      b.className = `ctl perm-btn ${cls}`;
      b.textContent = label;
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        btns.querySelectorAll("button").forEach((x) => ((x as HTMLButtonElement).disabled = true));
        this.wsSend({ t: "approve", requestId: ev.requestId, decision });
      });
      return b;
    };
    btns.append(mk("Deny", "deny", "deny"), mk("Allow", "allow", "allow"), mk("Always Allow", "always", "always"));
    card.append(text, btns);
    this.logEl.append(card);
    this.permEls.set(ev.requestId, card);
  }

  private resolvePermissionCard(requestId: string, decision: string) {
    const card = this.permEls.get(requestId);
    if (!card) return;
    card.classList.add("resolved");
    const btns = card.querySelector(".perm-btns");
    if (btns) btns.textContent = decision === "deny" ? "Denied" : "Allowed";
  }

  /**
   * The interactive AskUserQuestion prompt (see claude-driver.js). Each
   * question renders its options as buttons plus an "Other…" write-in — the
   * tool provides an Other affordance automatically in its native UI, and its
   * answer is just a free string, so a typed value slots into the same answers
   * map as a chosen label. Single-select submits on click; multi-select and
   * write-ins wait for Submit. Answers are keyed by question TEXT (the shape
   * the tool echoes back) and sent as one `answer` message once complete.
   */
  private appendQuestionCard(ev: Extract<AgentEvent, { t: "question" }>) {
    this.endToolGroup();
    const card = el("div", "question-card");
    const picks = new Map<string, Set<string>>(); // question text -> chosen option labels
    const custom = new Map<string, string>(); // question text -> "Other" free text (when active)

    // The final answer for a question: chosen labels plus any active write-in,
    // comma-joined (the tool's own multi-select encoding).
    const answerFor = (q: string) => {
      const parts = [...(picks.get(q) || [])];
      const c = (custom.get(q) || "").trim();
      if (c) parts.push(c);
      return parts.join(", ");
    };
    const answered = (q: string) => (picks.get(q)?.size ?? 0) > 0 || (custom.get(q) || "").trim().length > 0;

    // Submit is created on demand: a single-select single-question card answers
    // on click and needs none — until the user picks "Other" and needs a way
    // to send the typed text.
    let submitBtn: HTMLButtonElement | null = null;
    const ensureSubmit = () => {
      if (submitBtn) return;
      submitBtn = document.createElement("button");
      submitBtn.className = "ctl q-submit";
      submitBtn.textContent = "Submit";
      submitBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        trySubmit();
      });
      card.append(submitBtn);
    };

    const trySubmit = () => {
      if (!ev.questions.every((q) => answered(q.question))) return;
      const answers: Record<string, string> = {};
      for (const q of ev.questions) answers[q.question] = answerFor(q.question);
      card.classList.add("resolved");
      card.querySelectorAll("button, input").forEach((b) => ((b as HTMLInputElement).disabled = true));
      this.renderQuestionSummary(card, answers);
      this.wsSend({ t: "answer", requestId: ev.requestId, answers });
    };

    for (const q of ev.questions) {
      picks.set(q.question, new Set<string>());
      const block = el("div", "q-block");
      if (q.header) {
        const h = el("div", "q-header");
        h.textContent = q.header;
        block.append(h);
      }
      const qt = el("div", "q-text");
      qt.textContent = q.question;
      block.append(qt);

      const opts = el("div", "q-opts");

      // "Other…" write-in row, revealed when its option is chosen.
      const otherWrap = el("div", "q-other");
      otherWrap.hidden = true;
      const otherInput = document.createElement("input");
      otherInput.type = "text";
      otherInput.className = "q-other-input";
      otherInput.placeholder = "Type your own answer…";
      otherInput.addEventListener("input", () => custom.set(q.question, otherInput.value));
      otherInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          trySubmit();
        }
      });
      otherWrap.append(otherInput);

      const deselectOpts = () => opts.querySelectorAll("button").forEach((x) => x.classList.remove("selected"));

      const otherBtn = document.createElement("button");
      otherBtn.className = "ctl q-opt q-opt-other";
      const olbl = el("span", "q-opt-label");
      olbl.textContent = "✎ Other…";
      otherBtn.append(olbl);

      for (const o of q.options) {
        const b = document.createElement("button");
        b.className = "ctl q-opt";
        const lbl = el("span", "q-opt-label");
        lbl.textContent = o.label;
        b.append(lbl);
        if (o.description) {
          const d = el("span", "q-opt-desc");
          d.textContent = o.description;
          b.append(d);
        }
        b.addEventListener("click", (e) => {
          e.stopPropagation();
          const set = picks.get(q.question)!;
          if (q.multiSelect) {
            if (set.has(o.label)) set.delete(o.label);
            else set.add(o.label);
            b.classList.toggle("selected", set.has(o.label));
          } else {
            set.clear();
            set.add(o.label);
            deselectOpts();
            b.classList.add("selected");
            // A concrete pick cancels an in-progress write-in.
            otherBtn.classList.remove("selected");
            otherWrap.hidden = true;
            custom.delete(q.question);
            trySubmit();
          }
        });
        opts.append(b);
      }

      otherBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (q.multiSelect) {
          const active = otherBtn.classList.toggle("selected");
          otherWrap.hidden = !active;
          if (active) otherInput.focus();
          else {
            custom.delete(q.question);
            otherInput.value = "";
          }
        } else {
          // Single-select: "Other" becomes the sole selection.
          picks.get(q.question)!.clear();
          deselectOpts();
          otherBtn.classList.add("selected");
          otherWrap.hidden = false;
          otherInput.focus();
          ensureSubmit(); // this card had none; the write-in needs one
        }
      });
      opts.append(otherBtn);

      block.append(opts, otherWrap);
      card.append(block);
    }

    // Multi-select or multi-question cards always need an explicit Submit;
    // single-select single-question cards get one lazily via "Other".
    if (ev.questions.some((q) => q.multiSelect) || ev.questions.length > 1) ensureSubmit();

    this.logEl.append(card);
    this.questionEls.set(ev.requestId, card);
    this.scrollToBottom();
  }

  private resolveQuestionCard(requestId: string, answers: Record<string, string>) {
    const card = this.questionEls.get(requestId);
    if (!card || card.classList.contains("resolved")) return;
    card.classList.add("resolved");
    card.querySelectorAll("button").forEach((b) => ((b as HTMLButtonElement).disabled = true));
    // Reflect the choice made on another window (or before a reconnect).
    for (const [q, ans] of Object.entries(answers)) {
      card.querySelectorAll(".q-block").forEach((block) => {
        if (block.querySelector(".q-text")?.textContent !== q) return;
        block.querySelectorAll(".q-opt").forEach((b) => {
          const label = b.querySelector(".q-opt-label")?.textContent || "";
          if (ans.split(", ").includes(label)) b.classList.add("selected");
        });
      });
    }
    this.renderQuestionSummary(card, answers);
  }

  private renderQuestionSummary(card: HTMLElement, answers: Record<string, string>) {
    let foot = card.querySelector(".q-foot") as HTMLElement | null;
    if (!foot) {
      foot = el("div", "q-foot");
      card.append(foot);
    }
    foot.textContent = "✓ " + Object.values(answers).join(" · ");
  }

  private setStatus(state: string, detail?: string) {
    this.setBusy(state === "working");
    if (state === "working" || state === "waiting_permission") {
      this.statusEl.hidden = false;
      this.statusEl.textContent = state === "waiting_permission" ? "● Waiting on your approval…" : "● Working…";
    } else {
      this.statusEl.hidden = true;
    }
    if (state === "error") this.appendBubble("error", detail || "Something went wrong.");
    // Distinct from "error": the turn was cut off (interrupt/restart/rate
    // limit/API hiccup), not necessarily something to fix — see
    // claude-driver.js/codex-driver.js's terminal_reason/Turn.status handling.
    else if (state === "aborted") this.appendBubble("aborted", detail || "This turn was interrupted before finishing.");
  }

  /** Reflects the session's current permission mode in the title-bar selector — see the `mode` AgentEvent. */
  private setModeUI(mode: string) {
    // A codex pane created before this control existed has "default"
    // persisted, which matches none of the codex <option> values and would
    // render the select blank. Codex's own default is Auto, so land there.
    if (this.isCodex && !["read-only", "auto", "full-access"].includes(mode)) mode = "auto";
    this.modeSel.value = mode;
    // The one mode per provider that skips every approval prompt — worth a
    // visual "this is the dangerous one" cue distinct from the others, which
    // all still ask before something destructive happens (plan/read-only ask
    // by never running anything at all).
    this.modeSel.classList.toggle("bypass", mode === "bypassPermissions" || mode === "full-access");
  }

  private scrollToBottom() {
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  // ---- PaneView -----------------------------------------------------

  isWaiting(): boolean {
    return this.el.classList.contains("waiting");
  }
  waitingKind(): "question" | "done" | "aborted" {
    if (this.el.classList.contains("done")) return "done";
    if (this.el.classList.contains("aborted")) return "aborted";
    return "question";
  }
  setWaiting(on: boolean, kind: "question" | "done" | "aborted" = "question") {
    this.el.classList.toggle("waiting", on);
    this.el.classList.toggle("done", on && kind === "done");
    this.el.classList.toggle("aborted", on && kind === "aborted");
    this.badgeSlot.innerHTML = "";
    if (on) {
      const badge = el("span", "badge");
      badge.textContent = kind === "done" ? "done" : kind === "aborted" ? "cut off" : "needs you";
      this.badgeSlot.append(badge);
    }
  }
  setBusy(on: boolean) {
    setBusyClass(this.el, on);
    // Only offer to stop something that is actually running.
    if (this.stopBtn) this.stopBtn.hidden = !on;
  }

  /**
   * Render this pane's account usage. A remote pane deliberately shows nothing:
   * its agent runs on another host against THAT machine's account, so the local
   * numbers would be confidently wrong.
   */
  setUsage(row: UsageRow | null) {
    this.usageEl.textContent = "";
    if (!row || !row.available || this.isRemote) {
      this.usageEl.hidden = true;
      return;
    }
    const wins = [row.primary, row.secondary].filter(Boolean) as UsageWindow[];
    if (!wins.length) {
      this.usageEl.hidden = true;
      return;
    }
    for (const w of wins) this.usageEl.append(usageRing(w));
    this.usageEl.hidden = false;
  }

  /** Which model this session resolved to; hidden until the driver says. */
  setModel(model: string) {
    if (!model) return;
    this.info.model = model;
    this.modelEl.textContent = shortModel(model);
    this.modelEl.title = model;
    this.modelEl.hidden = false;
  }
  isFlagged(): boolean {
    return this.el.classList.contains("flagged");
  }
  setFollowUp(on: boolean) {
    this.el.classList.toggle("flagged", on);
    (this.titleBar.querySelector(".flag") as HTMLElement)?.classList.toggle("active", on);
  }
  /** Tint this box (a hex string), or "" to clear it. No picker UI yet — see the title bar comment. */
  setColor(color: string) {
    this.info.color = color;
    if (color) {
      this.cell.style.setProperty("--tint", color);
      this.el.classList.add("tinted");
    } else {
      this.cell.style.removeProperty("--tint");
      this.el.classList.remove("tinted");
    }
  }
  setName(name: string) {
    this.info.name = name;
    (this.titleBar.querySelector(".path") as HTMLElement).textContent = displayName(this.info);
  }
  /** No xterm to theme — no-op, exists only to satisfy the PaneView contract. */
  setAppearance(_theme: object, _fontSize: number) {}
  setLastInput(text: string) {
    this.info.lastInput = text;
    const clean = (text || "").replace(/\s+/g, " ").trim();
    this.pinnedEl.hidden = !clean;
    this.pinnedEl.textContent = clean;
    this.pinnedEl.title = text || "";
  }
  refit() {
    this.scrollToBottom();
  }
  focusTerm() {
    this.inputEl.focus();
  }
  dispose() {
    this.disposed = true;
    if (this.reconnectTimer != null) clearTimeout(this.reconnectTimer);
    if (this.ws) {
      this.ws.onclose = null;
      try {
        this.ws.close();
      } catch {}
    }
    this.cell.remove();
  }
}
