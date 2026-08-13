import { PaneInfo, PaneView, TermHost, displayName, basename } from "./terminal";
import { AgentEvent } from "./agent-events";
import { uploadFiles, wireFileDrop, wireFilePicker } from "./attach";

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
  private inputEl: HTMLTextAreaElement;
  private ws?: WebSocket;
  private reconnectTimer?: number;
  private disposed = false;
  private toolEls = new Map<string, HTMLElement>(); // tool_call id -> card, so a later tool_result can update it
  private permEls = new Map<string, HTMLElement>(); // permission requestId -> card
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
    // color-coding a chat pane isn't wired up yet, see setColor() below) so
    // the existing zoom/drag/mobile-collapse CSS and main.ts wiring apply
    // with no changes.
    this.titleBar.innerHTML =
      `<button class="ctl back" title="Back">‹</button>` +
      `<span class="dot">●</span>` +
      `<span class="path"></span>` +
      `<span class="badge-slot"></span>` +
      `<span class="spacer"></span>` +
      `<button class="ctl attach" title="Add file(s) to prompt">📎</button>` +
      `<button class="ctl flag" title="Mark for follow-up">🚩</button>` +
      `<button class="ctl min" title="Minimize">–</button>` +
      `<button class="ctl close" title="Close">✕</button>`;
    (this.titleBar.querySelector(".path") as HTMLElement).textContent = displayName(info);
    (this.titleBar.querySelector(".path") as HTMLElement).title = info.cwd;
    this.badgeSlot = this.titleBar.querySelector(".badge-slot") as HTMLElement;

    // Work-account panes (opened via "claude (work)" / "codex (work)") get a
    // didit-blue title tint, same as Term's — `.term.work .title` in
    // styles.css already covers that, it just needed the `work` class here
    // too. Term also overlays a big faint logo watermark across the whole
    // terminal, but there's no equivalent open canvas here (it's a column of
    // chat bubbles, not a blank viewport) and a mobile-sized box can't spare
    // the room anyway — a small badge in the title bar reads better at that
    // size, so it's a separate `.work-badge` element instead of reusing
    // Term's `.work-logo`.
    if (info.cmd === "claude-work" || info.cmd === "codex-work") {
      this.el.classList.add("work");
      const badge = document.createElement("img");
      badge.className = "work-badge";
      badge.src = "/didit-logo-white.png";
      badge.alt = "Work account";
      badge.title = "Work account";
      this.titleBar.querySelector(".attach")!.before(badge);
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
    this.ws = new WebSocket(`${proto}://${location.host}/agent?pane=${this.id}`);
    this.ws.onmessage = (e) => {
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
        this.streamingEls.clear();
        this.endToolGroup();
        for (const ev of m.events) this.applyEvent(ev);
        this.scrollToBottom();
      } else if (m.t === "ev" && m.ev) {
        this.applyEvent(m.ev);
        this.scrollToBottom();
      }
    };
    this.ws.onclose = () => {
      if (!this.disposed) this.scheduleReconnect();
    };
  }

  private scheduleReconnect(delay = 1000) {
    if (this.reconnectTimer != null) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
  }

  reconnectNow() {
    if (this.reconnectTimer != null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    try {
      this.ws?.close();
    } catch {}
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
        // in the Phase 1 MVP) — handled here for forward compatibility.
        let bubble = this.streamingEls.get(ev.id);
        if (!bubble) {
          bubble = this.appendBubble("assistant", "");
          this.streamingEls.set(ev.id, bubble);
        }
        bubble.textContent = (bubble.textContent || "") + ev.delta;
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
      case "status":
        this.setStatus(ev.state, ev.detail);
        break;
    }
  }

  private appendBubble(role: "user" | "assistant" | "error", text: string): HTMLElement {
    this.endToolGroup();
    const bubble = el("div", `msg ${role}`);
    bubble.textContent = text;
    this.logEl.append(bubble);
    return bubble;
  }

  private appendToolCard(id: string, name: string, input: unknown) {
    const details = document.createElement("details");
    details.className = "tool-card";
    details.open = false;
    const summary = document.createElement("summary");
    summary.textContent = `🔧 ${name}`;
    const body = document.createElement("pre");
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

  private setStatus(state: string, detail?: string) {
    if (state === "working" || state === "waiting_permission") {
      this.statusEl.hidden = false;
      this.statusEl.textContent = state === "waiting_permission" ? "● Waiting on your approval…" : "● Working…";
    } else {
      this.statusEl.hidden = true;
    }
    if (state === "error") this.appendBubble("error", detail || "Something went wrong.");
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
