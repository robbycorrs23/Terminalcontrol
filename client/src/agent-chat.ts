import { PaneInfo, PaneView, TermHost, displayName, basename } from "./terminal";
import { AgentEvent, AgentQuestion } from "./agent-events";
import { uploadFiles, wireFileDrop, wireFilePicker } from "./attach";
import { renderMarkdown } from "./markdown";

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
  private modeSel: HTMLSelectElement;
  private inputEl: HTMLTextAreaElement;
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
      `<button class="ctl flag" title="Mark for follow-up">🚩</button>` +
      `<button class="ctl min" title="Minimize">–</button>` +
      `<button class="ctl close" title="Close">✕</button>`;
    (this.titleBar.querySelector(".path") as HTMLElement).textContent = displayName(info);
    (this.titleBar.querySelector(".path") as HTMLElement).title = info.cwd;
    this.badgeSlot = this.titleBar.querySelector(".badge-slot") as HTMLElement;

    // Permission-mode selector: which of the SDK's modes (default = ask for
    // everything, acceptEdits = auto-approve file edits, auto = route each
    // prompt through a model classifier instead of asking you, plan =
    // read-only/no execution, bypassPermissions = approve everything) this
    // session runs under, and the only way to change it — there's no separate terminal
    // TUI here to show Claude Code's own mode indicator/Shift+Tab toggle,
    // since this view talks to the Agent SDK directly (see claude-driver.js).
    // Only wired for claude-driver.js today — codex-driver.js's app-server
    // protocol doesn't have a confirmed equivalent (see that file's own
    // comment on not guessing at unverified wire behavior), so the control
    // is hidden rather than silently doing nothing for a codex pane.
    this.modeSel = this.titleBar.querySelector(".mode-sel") as HTMLSelectElement;
    // Right side, immediately before the flag button — grouped with the
    // other pane-level (not per-message) controls, rather than crowding the
    // name on the left. Written in the HTML string next to .path above only
    // because that's where its <option> list was easiest to author; this
    // moves the actual node (not a clone) to where it's meant to render.
    this.titleBar.querySelector(".flag")!.before(this.modeSel);
    if (info.cmd === "codex" || info.cmd === "codex-work") {
      this.modeSel.hidden = true;
    } else {
      this.setModeUI(info.mode || "default");
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
    }

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
      this.modeSel.before(badge);
    }

    const cwdline = el("div", "cwdline");
    cwdline.textContent = info.cwd;
    this.pinnedEl = el("div", "pinned");
    this.pinnedEl.hidden = true;

    const chat = el("div", "chat");
    this.logEl = el("div", "chat-log");
    this.statusEl = el("div", "status-line");
    this.statusEl.hidden = true;
    const inputBar = el("div", "chat-input");
    this.inputEl = document.createElement("textarea");
    this.inputEl.rows = 1;
    this.inputEl.placeholder = "Message…";
    const attachBtn = el("button", "chat-attach");
    attachBtn.textContent = "📎";
    attachBtn.title = "Add file(s)";
    const sendBtn = el("button", "chat-send");
    sendBtn.textContent = "Send";
    inputBar.append(attachBtn, this.inputEl, sendBtn);
    chat.append(this.logEl, this.statusEl, inputBar);

    this.el.append(this.titleBar, cwdline, this.pinnedEl, chat);
    this.cell.append(this.el);

    this.wireRename(host);
    this.wireTitleBarButtons(host);
    wireFilePicker(attachBtn, this.el, (files) => void this.attachFiles(files));
    wireFileDrop(this.el, (files) => void this.attachFiles(files));

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
      if (tgt.closest(".ctl") || tgt.closest(".chat-input")) return;
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
      case "assistant_done":
        this.streamingEls.delete(ev.id);
        this.appendBubble("assistant", ev.text);
        break;
      case "assistant_delta": {
        // Not emitted by claude-driver.js yet (no partial-message streaming
        // in the Phase 1 MVP) — handled here for forward compatibility. Keeps
        // the raw source in a dataset field so each delta re-renders the whole
        // accumulated Markdown rather than appending to already-rendered HTML.
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

  private appendBubble(role: "user" | "assistant" | "error", text: string): HTMLElement {
    this.endToolGroup();
    const bubble = el("div", `msg ${role}`);
    // Assistant text is Markdown (renderMarkdown escapes untrusted source
    // before adding any markup — see markdown.ts). User and error text stays
    // literal: the user typed it, and an error string shouldn't be reinterpreted.
    if (role === "assistant") bubble.innerHTML = renderMarkdown(text);
    else bubble.textContent = text;
    this.logEl.append(bubble);
    return bubble;
  }

  private appendToolCard(id: string, name: string, input: unknown) {
    const details = document.createElement("details");
    details.className = "tool-card";
    details.open = false;
    const summary = document.createElement("summary");
    const detail = toolDetail(input);
    summary.textContent = detail ? `🔧 ${name} · ${detail}` : `🔧 ${name}`;
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
      `🔧 ${n} tool call${n === 1 ? "" : "s"}: ${preview}`;
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
   * question renders its options as buttons — single-select submits on click,
   * multi-select toggles and waits for a Submit. We collect selections keyed
   * by question TEXT (the shape the tool echoes back as its answers map) and
   * send them as one `answer` message once every question has a pick.
   */
  private appendQuestionCard(ev: Extract<AgentEvent, { t: "question" }>) {
    this.endToolGroup();
    const card = el("div", "question-card");
    const picks = new Map<string, Set<string>>(); // question text -> chosen labels

    const trySubmit = () => {
      // Only submit once every question has at least one pick — a single-select
      // card with one question reaches this the moment it's clicked; a card
      // with several (or a multi-select) waits for the rest / the Submit press.
      const complete = ev.questions.every((q) => (picks.get(q.question)?.size ?? 0) > 0);
      if (!complete) return;
      const answers: Record<string, string> = {};
      for (const q of ev.questions) answers[q.question] = [...(picks.get(q.question) || [])].join(", ");
      card.classList.add("resolved");
      card.querySelectorAll("button").forEach((b) => ((b as HTMLButtonElement).disabled = true));
      this.renderQuestionSummary(card, answers);
      this.wsSend({ t: "answer", requestId: ev.requestId, answers });
    };

    for (const q of ev.questions) {
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
          const set = picks.get(q.question) || new Set<string>();
          if (q.multiSelect) {
            if (set.has(o.label)) set.delete(o.label);
            else set.add(o.label);
            b.classList.toggle("selected", set.has(o.label));
            picks.set(q.question, set);
          } else {
            set.clear();
            set.add(o.label);
            picks.set(q.question, set);
            opts.querySelectorAll("button").forEach((x) => x.classList.remove("selected"));
            b.classList.add("selected");
            trySubmit();
          }
        });
        opts.append(b);
      }
      block.append(opts);
      card.append(block);
    }

    // Multi-select needs an explicit Submit; single-select cards with one
    // question submit on click and never show it.
    if (ev.questions.some((q) => q.multiSelect) || ev.questions.length > 1) {
      const submit = document.createElement("button");
      submit.className = "ctl q-submit";
      submit.textContent = "Submit";
      submit.addEventListener("click", (e) => {
        e.stopPropagation();
        trySubmit();
      });
      card.append(submit);
    }

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
    if (state === "working" || state === "waiting_permission") {
      this.statusEl.hidden = false;
      this.statusEl.textContent = state === "waiting_permission" ? "● Waiting on your approval…" : "● Working…";
    } else {
      this.statusEl.hidden = true;
    }
    if (state === "error") this.appendBubble("error", detail || "Something went wrong.");
  }

  /** Reflects the session's current permission mode in the title-bar selector — see the `mode` AgentEvent. */
  private setModeUI(mode: string) {
    this.modeSel.value = mode;
    // bypassPermissions skips every approval prompt — worth a visual "this is
    // the dangerous one" cue distinct from the other three, which all still
    // ask before something destructive happens (plan asks by never running
    // anything at all).
    this.modeSel.classList.toggle("bypass", mode === "bypassPermissions");
  }

  private scrollToBottom() {
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  // ---- PaneView -----------------------------------------------------

  isWaiting(): boolean {
    return this.el.classList.contains("waiting");
  }
  waitingKind(): "question" | "done" {
    return this.el.classList.contains("done") ? "done" : "question";
  }
  setWaiting(on: boolean, kind: "question" | "done" = "question") {
    this.el.classList.toggle("waiting", on);
    this.el.classList.toggle("done", on && kind === "done");
    this.badgeSlot.innerHTML = "";
    if (on) {
      const badge = el("span", "badge");
      badge.textContent = kind === "done" ? "done" : "needs you";
      this.badgeSlot.append(badge);
    }
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
