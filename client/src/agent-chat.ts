import { PaneInfo, PaneView, TermHost, displayName, basename, workingOverlay, setBusyClass, profileOf, UsageRow, UsageWindow } from "./terminal";
import { AgentEvent, AgentQuestion, AgentTask, ModelOption } from "./agent-events";
import {
  el,
  toolLabel,
  toolDetail,
  todosOf,
  renderTodos,
  diffStat,
  inputDiff,
  inputPreview,
  renderDiff,
  stripAnsi,
  fmtDuration,
  lineCount,
} from "./chat-steps";
import { ApprovalDock, DockAnswer, PermissionEvent } from "./chat-dock";
import { CommandMenu } from "./chat-commands";
import { wireLightbox } from "./lightbox";
import { openChanges } from "./changes-panel";
import { createRewindEditor, RewindEditor, RewindPreview } from "./rewind-editor";
import { mediaSrc } from "./markdown";
import { uploadFiles, wireFileDrop, wireFilePicker } from "./attach";
import { renderMarkdown } from "./markdown";
import { enhanceRich } from "./rich";
import { attachSecretPopover } from "./secret-popover";
import { iconSvg, setIcon } from "./icons";

/**
 * Wrap a <select> so what you SEE is a small styled label, while the real
 * select sits invisibly on top of it at 16px. Why: iOS zooms the whole page
 * when you focus a form control whose text is under 16px — tapping the 11px
 * mode picker blew the app up and left it zoomed. The invisible select still
 * gets the tap and opens the native picker.
 */
function chipSelect(sel: HTMLSelectElement, cls: string): HTMLElement {
  const chip = el("span", `sel-chip ${cls}`);
  const label = el("span", "sel-label");
  chip.append(label, sel);
  const sync = () => {
    label.textContent = sel.selectedOptions[0]?.textContent || "";
    chip.title = sel.title;
  };
  sel.addEventListener("change", sync);
  (sel as HTMLSelectElement & { syncChip?: () => void }).syncChip = sync;
  sync();
  return chip;
}
function syncChip(sel: HTMLSelectElement) {
  (sel as HTMLSelectElement & { syncChip?: () => void }).syncChip?.();
}

/** Images in a paste event, as named Files (a pasted screenshot has no useful name). */
function clipboardImages(data: DataTransfer): File[] {
  const out: File[] = [...data.files].filter((f) => f.type.startsWith("image/"));
  if (!out.length) {
    for (const item of data.items) {
      if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
      const f = item.getAsFile();
      if (f) out.push(f);
    }
  }
  return out.map((f, i) => renamePasted(f, i));
}

/** Read images via the async Clipboard API (needs a user gesture; the browser may ask). */
async function readClipboardImages(): Promise<File[]> {
  try {
    const items = await navigator.clipboard.read();
    const out: File[] = [];
    for (const item of items) {
      const type = item.types.find((t) => t.startsWith("image/"));
      if (!type) continue;
      const blob = await item.getType(type);
      out.push(renamePasted(new File([blob], "image", { type }), out.length));
    }
    return out;
  } catch {
    return []; // denied, or nothing readable
  }
}

function renamePasted(f: File, i: number): File {
  if (f.name && f.name !== "image.png" && f.name !== "image") return f;
  const ext = (f.type.split("/")[1] || "png").replace("jpeg", "jpg").replace(/[^a-z0-9]/g, "");
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
  return new File([f], `pasted-${stamp}${i ? "-" + i : ""}.${ext}`, { type: f.type });
}

/**
 * Identity of an event shared by the live stream and the on-disk transcript —
 * how "load earlier" tells the server where this log begins. MIRRORS
 * server/transcript.js's `eventKey`.
 */
function eventKey(e: AgentEvent): string | null {
  if (e.t === "tool_call" || e.t === "tool_result") return `${e.t}:${e.id}`;
  if (e.t === "user") return `user:${e.text}`;
  if (e.t === "assistant_done") return `a:${e.text}`;
  if (e.t === "thinking") return `th:${e.text}`;
  return null;
}
function headKeysOf(events: AgentEvent[], n = 40): string[] {
  const out: string[] = [];
  for (const e of events) {
    const k = eventKey(e);
    if (k) out.push(k);
    if (out.length >= n) break;
  }
  return out;
}

/** Steps a tool run shows before older ones fold behind "N earlier steps" (mirrored in styles.css). */
const TOOL_RUN_VISIBLE = 3;

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
  private plusMenu!: HTMLElement;
  private sendBtn!: HTMLButtonElement;
  private jumpBtn!: HTMLButtonElement;
  private modelSel!: HTMLSelectElement;
  private models: ModelOption[] = [];
  private usageEl!: HTMLElement;
  private ctxEl!: HTMLElement; // context-window meter in the composer row
  private infoEl!: HTMLElement; // + menu header: plan usage + context, labelled
  private usageRow: UsageRow | null = null;
  private ctxInfo: { percent: number; used: number; max: number } | null = null;
  private taskTray!: HTMLElement; // background tasks, each with its own stop
  private tasks = new Map<string, AgentTask>();
  private connEl!: HTMLElement; // "Reconnecting…" banner
  private connTimer?: number;
  private dock!: ApprovalDock;
  private cmdMenu!: CommandMenu;
  private suggestEl!: HTMLElement;
  private busy = false;
  private thinkingEls = new Map<string, HTMLElement>(); // thinking id -> row being streamed
  private turnStart: number | null = null; // ts of the user message that opened the current turn
  private turnEls: HTMLElement[] = []; // assistant text blocks of the current turn (for Copy)
  private turnFiles = new Set<string>(); // files edited this turn → "N files changed" under it
  private rewind: { messageId: string; editor: RewindEditor; bubble: HTMLElement } | null = null;
  private undoBar!: HTMLElement; // "Rewound · Undo" above the composer
  private attachRow!: HTMLElement;
  private attachments: { path: string; name: string; uploading?: boolean }[] = [];
  private lastTs: number | undefined;
  // "Load earlier": keys of the oldest events shown, whether the server may
  // have more, a request in flight, and the marker at the top of the log.
  private headKeys: string[] = [];
  private historyMore = true;
  private historyLoading = false;
  private historyTop!: HTMLElement;
  private prepending = false; // rendering an older page off-screen: no live side effects
  // Messages typed while a turn runs wait here (visible, editable,
  // cancellable) and go out together when the turn ends.
  private queued: string[] = [];
  private queueEl!: HTMLElement; // ts of the previous event (thinking's start when replayed whole)
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
      `<button class="ctl flag" title="Mark for follow-up">${iconSvg("flag")}</button>` +
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
    // Matches AgentManager.create's default so the chip never briefly shows a
    // mode the pane isn't actually running in.
    this.setModeUI(info.mode || "auto");
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
    if (profileOf(info.cmd).endsWith("-work")) {
      this.el.classList.add("work");
      // Image comes from the machine's own settings via --work-logo; see
      // terminal.ts for the same treatment and main.ts for where it's set.
      const badge = el("span", "work-badge");
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
    // ---- "+" menu ---------------------------------------------------------
    // Pane-level actions that aren't needed while typing — add files, hand
    // over a secret, flip to terminal view — live behind the composer's "+",
    // as in the Claude app, instead of in a row of bare icons of their own.
    // (They used to be a separate tools row between log and composer.)
    const menuItem = (cls: string, icon: Parameters<typeof setIcon>[1], label: string) => {
      const b = el("button", `menu-item ${cls}`) as HTMLButtonElement;
      b.innerHTML = iconSvg(icon);
      const l = el("span", "menu-label");
      l.textContent = label;
      b.append(l);
      b.title = label;
      return b;
    };
    const attachBtn = menuItem("attach", "attach", "Add files");
    // Explicit "paste what I copied" for when the system paste gesture won't
    // offer an image (iOS shows no Paste in a text box for an image-only
    // clipboard). Uses the async Clipboard API, which asks once.
    const pasteBtn = menuItem("paste-img", "image", "Paste image");
    // What this session has changed, as it is on disk now (changes-panel.ts).
    const changesBtn = menuItem("changes", "branch", "Changes");
    const secretBtn = menuItem("secret", "secret", "Give it a secret");
    secretBtn.title = "Give this chat a secret (never saved to chat memory)";
    // `.view` is what main.ts's flipView() looks up to disable during a flip.
    const viewBtn = menuItem("view", "terminal", "Switch to terminal view");
    this.plusMenu = el("div", "plus-menu");
    this.plusMenu.hidden = true;
    this.infoEl = el("div", "menu-info");
    this.infoEl.hidden = true;
    this.plusMenu.append(this.infoEl, changesBtn, attachBtn, pasteBtn, secretBtn, viewBtn);
    changesBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.showChanges();
    });
    pasteBtn.hidden = !navigator.clipboard?.read;
    pasteBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const files = await readClipboardImages();
      if (files.length) void this.attachFiles(files);
      else this.flashNote("No image on the clipboard — copy one first");
    });

    // Model picker: filled from the SDK's own list (`models` event); until it
    // arrives (or for codex, which reports none) it's a disabled one-option
    // badge for whatever the pane says it's running.
    this.modelSel = document.createElement("select");
    this.modelSel.className = "model-sel";
    this.modelSel.title = "Model";
    this.modelSel.hidden = true;
    this.modelSel.addEventListener("pointerdown", (e) => e.stopPropagation());
    this.modelSel.addEventListener("click", (e) => e.stopPropagation());
    this.modelSel.addEventListener("change", () => this.wsSend({ t: "setModel", model: this.modelSel.value }));
    // Floating "jump to latest" pill over the bottom of the log.
    this.jumpBtn = el("button", "jump-pill") as HTMLButtonElement;
    this.jumpBtn.innerHTML = iconSvg("down");
    this.jumpBtn.title = "Jump to latest";
    this.jumpBtn.setAttribute("aria-label", "Jump to latest");
    this.jumpBtn.hidden = true;
    this.usageEl = el("span", "use-rings");

    if (info.model) this.setModel(info.model);

    // ---- Composer -------------------------------------------------------
    // One rounded box, as in the Claude app: the text on top, a row of
    // controls under it — attach, permission mode, model, and a single
    // button that is Send when there's text and Stop (■) while a turn runs
    // with nothing typed. Typing during a turn still sends: the SDK queues
    // it for when the current turn ends.
    const inputBar = el("div", "chat-input");
    this.inputEl = document.createElement("textarea");
    this.inputEl.rows = 1;
    this.inputEl.placeholder = this.isCodex ? "Message Codex…" : "Message Claude…";
    this.sendBtn = el("button", "chat-send") as HTMLButtonElement;
    const plusBtn = el("button", "chat-plus") as HTMLButtonElement;
    setIcon(plusBtn, "plus");
    plusBtn.title = "Add files, secrets, view";
    plusBtn.setAttribute("aria-label", "More");
    const row = el("div", "composer-row");
    this.ctxEl = el("button", "ctx-meter");
    this.ctxEl.hidden = true;
    // No hover on a phone: tapping the % opens the + menu, which spells out
    // context and plan usage with labels.
    this.ctxEl.addEventListener("click", (e) => {
      e.stopPropagation();
      this.plusMenu.hidden = !this.plusMenu.hidden;
      plusBtn.classList.toggle("open", !this.plusMenu.hidden);
    });
    row.append(
      plusBtn,
      chipSelect(this.modeSel, "mode-chip"),
      el("span", "spacer"),
      this.ctxEl,
      this.usageEl,
      chipSelect(this.modelSel, "model-chip"),
      this.sendBtn
    );
    this.setModeUI(this.modeSel.value); // now that the chip exists, colour it
    // Attachments wait here as thumbnails (the way the app shows them) rather
    // than as raw upload paths pasted into your message.
    this.attachRow = el("div", "attach-row");
    this.attachRow.hidden = true;
    inputBar.append(this.attachRow, this.inputEl, row);

    this.cmdMenu = new CommandMenu(this.inputEl, () => {
      this.autoGrow();
      this.syncSend();
    });
    this.suggestEl = el("div", "chat-suggest");
    this.suggestEl.hidden = true;
    this.queueEl = el("div", "chat-queue");
    this.queueEl.hidden = true;
    this.dock = new ApprovalDock(
      this.isCodex,
      (ev, a) => this.answerPermission(ev, a),
      (open) => {
        chat.classList.toggle("has-dock", open);
        // Move focus between composer and dock only if it was already in
        // THIS pane — a prompt in another box must not steal your typing.
        const mine = this.el.contains(document.activeElement);
        if (open && mine) this.dock.focus();
        else if (!open && mine) this.inputEl.focus({ preventScroll: true });
        this.scrollToBottom();
      }
    );
    const logWrap = el("div", "log-wrap");
    logWrap.append(this.logEl, this.jumpBtn);
    wireLightbox(chat);
    this.undoBar = el("div", "rw-undo");
    this.undoBar.hidden = true;
    this.taskTray = el("div", "task-tray");
    this.taskTray.hidden = true;
    this.connEl = el("div", "conn-banner");
    this.connEl.hidden = true;
    this.connEl.textContent = "Reconnecting…";
    logWrap.append(this.connEl);
    chat.append(
      logWrap,
      this.statusEl,
      this.plusMenu,
      this.cmdMenu.el,
      this.undoBar,
      this.taskTray,
      this.suggestEl,
      this.queueEl,
      this.dock.el,
      inputBar,
      workingOverlay()
    );
    this.syncSend();

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
      changesBtn.hidden = true; // its files are on another machine
      pasteBtn.hidden = true;
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

    plusBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.plusMenu.hidden = !this.plusMenu.hidden;
      plusBtn.classList.toggle("open", !this.plusMenu.hidden);
    });
    // Picking anything finishes the job the menu was opened for. Capture
    // phase: the file picker's own handler stops the click from bubbling.
    this.plusMenu.addEventListener(
      "click",
      () => {
        this.plusMenu.hidden = true;
        plusBtn.classList.remove("open");
      },
      true
    );
    this.plusMenu.addEventListener("pointerdown", (e) => e.stopPropagation());
    document.addEventListener("pointerdown", (e) => {
      if (this.plusMenu.hidden || plusBtn.contains(e.target as Node)) return;
      this.plusMenu.hidden = true;
      plusBtn.classList.remove("open");
    });
    viewBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      host.onFlipView(this);
    });
    this.sendBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this.sendBtn.classList.contains("stop")) this.wsSend({ t: "interrupt" });
      else this.submit();
      this.inputEl.focus({ preventScroll: true });
    });
    this.jumpBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.logEl.scrollTop = this.logEl.scrollHeight;
      this.jumpBtn.hidden = true;
      this.stick = true;
    });
    // Offer the jump button only when it would actually do something. 24px of
    // slack keeps it from flickering on during momentum scrolling at the bottom.
    // Also decides whether new output follows the bottom: scrolled up to
    // read something, the log stays put (the app doesn't yank you down
    // mid-read); back at the bottom, it follows again.
    this.logEl.addEventListener("scroll", () => {
      const room = this.logEl.scrollHeight - this.logEl.scrollTop - this.logEl.clientHeight;
      this.jumpBtn.hidden = room < 24;
      this.stick = room < 48;
      if (this.logEl.scrollTop < 400) this.requestHistory();
    });

    this.inputEl.addEventListener("keydown", (e) => {
      e.stopPropagation(); // don't let Escape/etc bubble to the app-level zoom handler
      if (this.cmdMenu.handleKey(e)) {
        e.preventDefault();
        return;
      }
      // Tab takes the suggested follow-up when the box is empty, like the CLI.
      if (e.key === "Tab" && !e.shiftKey && !this.inputEl.value && this.suggestion) {
        e.preventDefault();
        this.inputEl.value = this.suggestion;
        this.autoGrow();
        this.syncSend();
        return;
      }
      if (e.key === "Escape" && this.busy && !this.inputEl.value) {
        e.preventDefault();
        this.wsSend({ t: "interrupt" }); // Esc interrupts, as in Claude Code
        return;
      }
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this.submit();
      }
    });
    this.inputEl.addEventListener("input", () => {
      this.autoGrow();
      this.cmdMenu.update();
      this.syncSend();
    });
    this.inputEl.addEventListener("blur", () => this.cmdMenu.close());
    // Paste a screenshot or copied image straight into the message. Safari
    // often leaves clipboardData.files empty and puts the image only in
    // .items, so read both. Text in the same paste still pastes normally
    // unless an image was found.
    this.inputEl.addEventListener("paste", (e) => {
      if (this.isRemote || !e.clipboardData) return;
      const files = clipboardImages(e.clipboardData);
      if (!files.length) return;
      e.preventDefault();
      void this.attachFiles(files);
    });

    // Click the box (outside controls/input) opens/zooms it, same as Term.
    this.el.addEventListener("click", (e) => {
      const tgt = e.target as HTMLElement;
      if (tgt.closest(".ctl, .chat-input, .plus-menu, .jump-pill, .chat-dock, .chat-suggest, .cmd-menu, .turn-meta, .rw-card, .rw-undo, .msg-edit")) return;
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
    ws.onopen = () => {
      if (this.ws === ws) this.setConnected(true);
    };
    ws.onmessage = (e) => {
      let m: { t: string; events?: AgentEvent[]; ev?: AgentEvent; more?: boolean; [k: string]: unknown };
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (m.t === "replay" && m.events) {
        this.resetLog();
        for (const ev of m.events) this.applyEvent(ev);
        this.headKeys = headKeysOf(m.events);
        this.historyMore = this.headKeys.length > 0;
        this.historyLoading = false;
        this.renderHistoryTop();
        this.scrollToBottom(true);
      } else if (m.t === "rewindPreview") {
        if (this.rewind && this.rewind.messageId === m.messageId) this.rewind.editor.apply(m as unknown as RewindPreview);
      } else if (m.t === "rewindResult") {
        if (m.ok) {
          this.rewind = null; // the replay already replaced the log, editor included
          const n = Number(m.restored || 0);
          this.showUndoBar(n ? `Rewound · ${n} file${n === 1 ? "" : "s"} restored` : "Rewound");
        } else this.rewind?.editor.fail(String(m.reason || "Couldn't rewind."));
      } else if (m.t === "undoResult") {
        this.undoBar.hidden = true;
        this.flashNote(m.ok ? "Rewind undone" : String(m.reason || "Couldn't undo."));
      } else if (m.t === "history" && m.events) {
        this.prependHistory(m.events, !!m.more);
      } else if (m.t === "ev" && m.ev) {
        this.applyEvent(m.ev);
        if (m.ev.t === "status") this.onLiveStatus(m.ev.state);
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
      if (this.ws !== ws) return;
      this.setConnected(false);
      this.scheduleReconnect();
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
    const typed = this.inputEl.value.trim();
    if (this.attachments.some((a) => a.uploading)) return; // wait for the upload
    const paths = this.attachments.map((a) => a.path);
    if (!typed && !paths.length) return;
    const text = [typed, ...paths].filter(Boolean).join("\n");
    this.attachments = [];
    this.renderAttachments();
    this.inputEl.value = "";
    if (this.busy) {
      // Claude is mid-turn: hold it (visibly) and send when the turn ends.
      this.queued.push(text);
      this.renderQueue();
      this.autoGrow();
      this.syncSend();
      return;
    }
    this.autoGrow();
    this.cmdMenu.close();
    this.stick = true; // sending is "take me to the bottom"
    this.wsSend({ t: "send", text });
    this.syncSend();
  }

  /** A brief note above the composer (e.g. "no image on the clipboard"). */
  private flashNote(text: string) {
    const n = el("div", "chat-flash");
    n.textContent = text;
    this.el.querySelector(".chat")?.insertBefore(n, this.el.querySelector(".chat-input"));
    setTimeout(() => n.remove(), 2600);
  }

  /** One button, two jobs: Send when there's text, Stop while a turn runs with nothing typed. */
  private syncSend() {
    const has = !!this.inputEl.value.trim() || this.attachments.length > 0;
    const stop = this.busy && !has;
    this.sendBtn.classList.toggle("stop", stop);
    this.sendBtn.classList.toggle("empty", !stop && !has);
    setIcon(this.sendBtn, stop ? "stop" : "send");
    const label = stop ? "Stop (Esc)" : this.busy ? "Queue message" : "Send";
    this.sendBtn.title = label;
    this.sendBtn.setAttribute("aria-label", label);
  }

  private autoGrow() {
    this.inputEl.style.height = "auto";
    this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 160) + "px";
  }

  /**
   * Upload, then hold each file as a chip in the composer. On send their
   * paths are appended to the message (one per line) — still the same text
   * protocol the driver always had, so Claude reads them with its Read tool,
   * images included — and the bubble renders them back as images.
   */
  private async attachFiles(files: File[]) {
    if (!files.length) return;
    const placeholders: { path: string; name: string; uploading?: boolean }[] = files.map((f) => ({
      path: "",
      name: f.name || "image",
      uploading: true,
    }));
    this.attachments.push(...placeholders);
    this.renderAttachments();
    const paths = await uploadFiles(this.id, files);
    this.attachments = this.attachments.filter((a) => !placeholders.includes(a));
    for (const path of paths) this.attachments.push({ path, name: basename(path) });
    this.renderAttachments();
    this.inputEl.focus({ preventScroll: true });
  }

  private renderAttachments() {
    this.attachRow.textContent = "";
    this.attachRow.hidden = !this.attachments.length;
    for (const a of this.attachments) {
      const chip = el("div", "attach-chip" + (a.uploading ? " uploading" : ""));
      const media = a.path ? mediaSrc(a.path) : null;
      if (media?.kind === "image") {
        const thumb = el("span", "attach-thumb");
        const img = document.createElement("img");
        img.src = media.src;
        img.alt = a.name;
        thumb.append(img);
        chip.append(thumb);
      } else {
        const name = el("span", "attach-name");
        name.textContent = a.uploading ? "Uploading…" : a.name;
        chip.append(name);
      }
      if (!a.uploading) {
        const x = el("button", "attach-x") as HTMLButtonElement;
        x.textContent = "✕";
        x.title = `Remove ${a.name}`;
        x.setAttribute("aria-label", `Remove ${a.name}`);
        x.addEventListener("click", (e) => {
          e.stopPropagation();
          this.attachments = this.attachments.filter((b) => b !== a);
          this.renderAttachments();
        });
        chip.append(x);
      }
      this.attachRow.append(chip);
    }
    this.syncSend();
  }

  // ---- Event rendering ---------------------------------------------------

  private stick = true; // follow new output? false while the user is scrolled up reading
  private suggestion = "";

  private resetLog() {
    this.logEl.innerHTML = "";
    this.historyTop = el("div", "history-top");
    this.historyTop.addEventListener("click", (e) => {
      e.stopPropagation();
      this.requestHistory();
    });
    this.logEl.append(this.historyTop);
    this.toolEls.clear();
    this.permEls.clear();
    this.questionEls.clear();
    this.streamingEls.clear();
    this.thinkingEls.clear();
    this.dock.clear();
    this.endToolGroup();
    this.turnStart = null;
    this.turnEls = [];
    this.setSuggestion("");
    this.tasks.clear();
    this.renderTasks();
    this.rewind = null;
  }

  private applyEvent(ev: AgentEvent) {
    // Output is flowing again after an API retry: back to "Working…".
    if (!this.prepending && this.statusEl.classList.contains("retry") && /^(assistant_delta|thinking_delta|tool_call|assistant_done)$/.test(ev.t))
      this.setStatus("working");
    this.applyEventInner(ev);
    if (ev.ts) this.lastTs = ev.ts;
  }

  private applyEventInner(ev: AgentEvent) {
    switch (ev.t) {
      case "user":
        this.closeThinking();
        // Older pages carry no per-turn status events; close each turn
        // (Copy + time) when the next prompt starts instead.
        if (this.prepending && this.turnEls.length) this.appendTurnMeta(this.turnStart && ev.ts ? ev.ts - this.turnStart : undefined);
        this.addEditAction(this.appendBubble("user", ev.text), ev.id, ev.text);
        this.turnStart = ev.ts ?? Date.now();
        this.turnEls = [];
        this.turnFiles = new Set();
        if (!this.prepending) this.setSuggestion("");
        break;
      case "assistant_done": {
        // A streamed block (claude via includePartialMessages, codex natively)
        // already has a bubble under this id — finalize it in place.
        this.closeThinking();
        const streamed = this.streamingEls.get(ev.id);
        this.streamingEls.delete(ev.id);
        let bubbleEl: HTMLElement;
        if (streamed) {
          // Trust the completed text over the accumulated deltas: it's the
          // authoritative form and repairs a dropped delta.
          streamed.dataset.raw = ev.text;
          streamed.innerHTML = renderMarkdown(ev.text);
          streamed.classList.remove("streaming");
          // Charts/tables are built HERE, not per delta: a half-streamed
          // ```chart block is invalid JSON, and rebuilding SVG per token thrashes.
          enhanceRich(streamed);
          bubbleEl = streamed;
        } else {
          bubbleEl = this.appendBubble("assistant", ev.text);
        }
        this.turnEls.push(bubbleEl);
        // Only set when the SDK itself says the message was truncated.
        bubbleEl.classList.toggle("aborted", !!ev.aborted);
        break;
      }
      case "assistant_delta": {
        this.closeThinking();
        let bubble = this.streamingEls.get(ev.id);
        if (!bubble) {
          bubble = this.appendBubble("assistant", "");
          bubble.classList.add("streaming");
          this.streamingEls.set(ev.id, bubble);
        }
        bubble.dataset.raw = (bubble.dataset.raw || "") + ev.delta;
        bubble.innerHTML = renderMarkdown(bubble.dataset.raw);
        break;
      }
      case "thinking_delta":
        this.thinkingRow(ev.id, ev.ts).dataset.raw += ev.delta;
        this.renderThinking(ev.id);
        break;
      case "thinking": {
        // Replayed whole (no deltas): it began roughly when the previous event landed.
        const row = this.thinkingRow(ev.id, this.thinkingEls.has(ev.id) ? ev.ts : (this.lastTs ?? ev.ts));
        row.dataset.raw = ev.text;
        this.renderThinking(ev.id);
        this.finishThinking(row, ev.ts);
        break;
      }
      case "tool_call":
        this.closeThinking();
        this.appendToolCard(ev.id, ev.name, ev.input, ev.parent);
        break;
      case "tool_result":
        this.updateToolCard(ev.id, ev.output, ev.isError, ev.diff);
        break;
      case "tool_progress": {
        const card = this.toolEls.get(ev.id);
        if (card?.classList.contains("pending")) {
          const t = card.querySelector(":scope > summary .tool-time") as HTMLElement | null;
          if (t) t.textContent = fmtDuration(ev.seconds * 1000);
        }
        break;
      }
      case "permission_request":
        this.closeThinking();
        this.appendPermissionNote(ev);
        break;
      case "permission_resolved":
        this.resolvePermissionNote(ev.requestId, ev.decision, ev.message);
        break;
      case "question":
        this.closeThinking();
        this.appendQuestionCard(ev);
        break;
      case "question_resolved":
        this.resolveQuestionCard(ev.requestId, ev.answers);
        break;
      case "status":
        this.setStatus(ev.state, ev.detail, ev.durationMs, ev.ts);
        break;
      case "mode":
        this.setModeUI(ev.mode);
        break;
      case "commands":
        this.cmdMenu.setCommands(ev.commands);
        break;
      case "models":
        this.models = ev.models;
        this.renderModels();
        break;
      case "suggestion":
        if (!this.busy) this.setSuggestion(ev.text);
        break;
      case "retry":
        this.showRetry(ev.attempt, ev.max, ev.delayMs, ev.status);
        break;
      case "compact":
        this.appendCompact(ev.trigger, ev.preTokens, ev.postTokens);
        break;
      case "context":
        this.setContext(ev.percent, ev.used, ev.max);
        break;
      case "task":
        this.updateTask(ev.task);
        break;
    }
  }

  private appendBubble(role: "user" | "assistant" | "error" | "aborted", text: string): HTMLElement {
    this.endToolGroup();
    const bubble = el("div", `msg ${role}`);
    // Assistant text is Markdown (renderMarkdown escapes untrusted source
    // before adding any markup — see markdown.ts). User/error/aborted text
    // stays literal.
    if (role === "assistant") bubble.innerHTML = renderMarkdown(text);
    else if (role === "user") this.renderUserText(bubble, text);
    else bubble.textContent = text;
    this.logEl.append(bubble);
    // After the append, so the rich pass can measure real laid-out height.
    if (role !== "error" && role !== "aborted" && text) enhanceRich(bubble);
    return bubble;
  }

  /**
   * Your message, with any image paths in it (attachments, or a path you
   * typed) shown as the images themselves under the text — and dropped from
   * the visible text, since a 90-character temp path tells you nothing.
   */
  private renderUserText(bubble: HTMLElement, text: string) {
    const images: { src: string; name: string }[] = [];
    const rest = text
      .split("\n")
      .map((line) =>
        line
          .split(/(\s+)/)
          .filter((tok) => {
            const m = /^(\/|~\/)\S+$/.test(tok) ? mediaSrc(tok) : null;
            if (m?.kind !== "image") return true;
            images.push({ src: m.src, name: basename(tok) });
            return false;
          })
          .join("")
          .trimEnd()
      )
      .join("\n")
      .trim();
    if (rest) {
      const t = el("div", "msg-text");
      t.textContent = rest;
      bubble.append(t);
    }
    if (images.length) {
      bubble.classList.add("has-images");
      const grid = el("div", "msg-images");
      for (const im of images) {
        const img = document.createElement("img");
        img.className = "msg-img";
        img.src = im.src;
        img.alt = im.name;
        img.loading = "lazy";
        img.decoding = "async";
        img.addEventListener("error", () => img.classList.add("missing"));
        grid.append(img);
      }
      bubble.append(grid);
    }
  }

  // ---- Thinking ------------------------------------------------------------
  // A collapsible step in the same timeline as tool calls: "Thinking…" with a
  // shimmer while it streams, "Thought for 8s" once done. Collapsed by
  // default — it's the model's scratchpad, not the answer.

  private thinkingRow(id: string, ts?: number): HTMLElement {
    let row = this.thinkingEls.get(id);
    if (row) return row;
    row = document.createElement("details");
    row.className = "tool-card thinking pending";
    row.dataset.raw = "";
    row.dataset.start = String(ts ?? Date.now());
    const summary = document.createElement("summary");
    const dot = el("span", "tool-dot");
    const verb = el("span", "tool-verb");
    verb.textContent = "Thinking…";
    summary.append(dot, verb);
    const body = el("div", "thinking-body");
    row.append(summary, body);
    this.toolGroup().append(row);
    this.renderToolGroupSummary();
    this.thinkingEls.set(id, row);
    return row;
  }

  private renderThinking(id: string) {
    const row = this.thinkingEls.get(id);
    if (!row) return;
    (row.querySelector(".thinking-body") as HTMLElement).innerHTML = renderMarkdown(row.dataset.raw || "");
  }

  private finishThinking(row: HTMLElement, ts?: number) {
    if (!row.classList.contains("pending")) return;
    row.classList.remove("pending");
    const start = Number(row.dataset.start);
    const secs = ts && start ? (ts - start) / 1000 : 0;
    (row.querySelector(".tool-verb") as HTMLElement).textContent =
      secs >= 1 ? `Thought for ${fmtDuration(secs * 1000)}` : "Thought";
  }

  /** Something else started, so any thinking still streaming is over. */
  private closeThinking() {
    if (this.prepending) return; // an older page must not touch a live thinking row
    for (const row of this.thinkingEls.values()) this.finishThinking(row, Date.now());
  }

  // ---- Tool steps ------------------------------------------------------------

  /**
   * One step in the Claude-app style: a borderless row reading "● Verb
   * target  stat", whose dot pulses until its tool_result lands. Clicking it
   * opens a body built for that tool: `$ command` + output for Bash, a diff
   * for edits (shown before the result, from the call's own input), the
   * checklist for todos (open by default), the plan for ExitPlanMode.
   * Subagent steps (`parent` set) nest inside their Agent step.
   */
  private appendToolCard(id: string, name: string, input: unknown, parent?: string) {
    if (this.toolEls.has(id)) return;
    const details = document.createElement("details");
    details.className = "tool-card pending";
    details.dataset.tool = name;
    const fileArg = input && typeof input === "object" ? (input as Record<string, unknown>).file_path : undefined;
    if (typeof fileArg === "string") details.dataset.file = fileArg;
    if (!parent && typeof fileArg === "string" && /^(Edit|MultiEdit|Write|NotebookEdit)$/.test(name)) this.turnFiles.add(fileArg);
    const summary = document.createElement("summary");
    const { verb, target } = toolLabel(name, input);
    const dot = el("span", "tool-dot");
    const verbEl = el("span", "tool-verb");
    verbEl.textContent = verb;
    const targetEl = el("span", "tool-target");
    targetEl.textContent = target;
    const stat = el("span", "tool-stat");
    const time = el("span", "tool-time");
    summary.append(dot, verbEl, targetEl, stat, time);
    const full = toolDetail(input);
    summary.title = full ? `${name} · ${full}` : name;
    details.append(summary);

    const body = el("div", "tool-body");
    const preview = inputPreview(name, input);
    if (preview) body.append(preview);
    details.append(body);

    const todos = name === "TodoWrite" ? todosOf(input) : null;
    if (todos) {
      details.classList.add("todos");
      details.open = true;
      stat.textContent = `${todos.filter((t) => t.status === "completed").length}/${todos.length}`;
    }
    if (name === "ExitPlanMode" && preview) {
      details.classList.add("plan");
      details.open = true;
      enhanceRich(preview);
    }
    const diff = inputDiff(name, input);
    if (diff) this.setDiffStat(stat, diff);
    if (name === "Task" || name === "Agent") {
      details.classList.add("agent");
      const kids = el("div", "tool-children");
      body.prepend(kids);
    }

    const parentCard = parent ? this.toolEls.get(parent) : undefined;
    if (parentCard) {
      parentCard.querySelector(".tool-children")?.append(details);
      const n = parentCard.querySelectorAll(".tool-children > .tool-card").length;
      (parentCard.querySelector(":scope > summary .tool-stat") as HTMLElement).textContent = `${n} step${n === 1 ? "" : "s"}`;
    } else {
      this.toolGroup().append(details);
      this.renderToolGroupSummary();
    }
    this.toolEls.set(id, details);
  }

  private setDiffStat(stat: HTMLElement, diff: string) {
    const { add, del } = diffStat(diff);
    stat.textContent = "";
    const a = el("span", "add");
    a.textContent = `+${add}`;
    const d = el("span", "del");
    d.textContent = `−${del}`;
    stat.append(a, d);
  }

  /**
   * Current run's container, creating one if the last thing appended wasn't a
   * step. A run is a vertical timeline of rows, always visible — only once it
   * grows past TOOL_RUN_VISIBLE do the OLDER rows fold behind "N earlier
   * steps", so the live edge stays in view. The fold is CSS (nth-last-child).
   */
  private toolGroup(): HTMLElement {
    if (this.toolGroupBody) return this.toolGroupBody;
    const group = el("div", "tool-group");
    const more = el("button", "tool-more") as HTMLButtonElement;
    more.hidden = true;
    more.addEventListener("click", (e) => {
      e.stopPropagation();
      group.classList.toggle("expanded");
      this.renderToolGroupSummary(group);
    });
    const body = el("div", "tool-group-body");
    group.append(more, body);
    this.logEl.append(group);
    this.toolGroupEl = group;
    this.toolGroupBody = body;
    return body;
  }

  private renderToolGroupSummary(group: HTMLElement | null = this.toolGroupEl) {
    if (!group) return;
    const more = group.querySelector(".tool-more") as HTMLButtonElement;
    // Count exactly what the CSS fold hides: rows before the last
    // TOOL_RUN_VISIBLE, minus the ones it always keeps (errors, todo lists).
    const rows = [...group.querySelector(".tool-group-body")!.children];
    const hidden = rows.filter((r, i) => i < rows.length - TOOL_RUN_VISIBLE && !r.matches(".error, .todos")).length;
    more.hidden = hidden <= 0;
    more.textContent = group.classList.contains("expanded")
      ? "Hide earlier steps"
      : `${hidden} earlier step${hidden === 1 ? "" : "s"}`;
  }

  private endToolGroup() {
    this.toolGroupEl = null;
    this.toolGroupBody = null;
  }

  private updateToolCard(id: string, output: string, isError: boolean, diff?: string) {
    let card = this.toolEls.get(id);
    if (!card) {
      // A tool_result with no matching tool_call in this session — e.g. we
      // reconnected mid-turn and missed the ring buffer's earlier entry.
      this.appendToolCard(id, "tool result", null);
      card = this.toolEls.get(id)!;
    }
    card.classList.remove("pending", "awaiting");
    card.classList.toggle("error", isError);
    (card.querySelector(":scope > summary .tool-time") as HTMLElement).textContent = "";
    // Surface the error on the group too; .tool-card.error is also exempt
    // from the "earlier steps" fold, so a failure is never tucked away.
    if (isError) {
      const group = card.closest(".tool-group") as HTMLElement | null;
      group?.classList.add("error");
      this.renderToolGroupSummary(group);
    }
    const name = card.dataset.tool || "";
    const body = card.querySelector(":scope > .tool-body") as HTMLElement;
    const stat = card.querySelector(":scope > summary .tool-stat") as HTMLElement;
    const text = stripAnsi(output || "");

    // The checklist / plan already say everything; their results are boilerplate.
    if ((name === "TodoWrite" || name === "ExitPlanMode") && !isError) return;
    if (diff) {
      this.setDiffStat(stat, diff);
      body.append(renderDiff(diff));
      return;
    }
    // Edits already show their diff from the input; a success message adds nothing.
    if (!isError && card.querySelector(":scope > .tool-body .diff-block")) return;

    if (!isError && name === "Read") {
      const fp = card.dataset.file || "";
      const media = fp ? mediaSrc(fp) : null;
      if (media?.kind === "image") {
        // Claude looked at a picture — show the picture, not "[image]".
        const img = document.createElement("img");
        img.className = "step-img";
        img.src = media.src;
        img.alt = basename(fp);
        img.loading = "lazy";
        body.querySelector(".tool-input")?.remove(); // the picture says which file
        body.append(img);
        (card as HTMLDetailsElement).open = true;
        return;
      }
    }
    if (!isError && (name === "Read" || name === "Grep" || name === "Glob") && !stat.textContent) {
      const n = lineCount(text);
      stat.textContent = name === "Read" ? `${n} line${n === 1 ? "" : "s"}` : `${n} result${n === 1 ? "" : "s"}`;
    }
    if (card.classList.contains("agent") && !isError && text.trim()) {
      // A subagent's final report is prose — render it like a reply.
      const md = el("div", "agent-result msg assistant");
      md.innerHTML = renderMarkdown(text);
      body.append(md);
      return;
    }
    if (!text.trim()) return;
    // A denial's "result" just echoes the reason already shown on the row.
    if (isError && card.querySelector(":scope > summary .step-note.denied")) return;
    const term = body.querySelector(".term-block") as HTMLElement | null;
    if (term && name === "Bash") {
      const out = el("span", isError ? "term-out err" : "term-out");
      out.textContent = "\n" + text;
      term.append(out);
      term.classList.add("tool-output");
      return;
    }
    const out = el("pre", "tool-output");
    out.textContent = text;
    body.append(out);
  }

  // ---- Permissions -----------------------------------------------------------
  // The prompt itself lives in the dock (chat-dock.ts), where the composer
  // is. In the log, the step it gates is marked in place — amber "Waiting
  // for approval", then "Denied — <your reason>" / "Always allowed" (plain
  // Allow just lets the step run, which says it already). Only a prompt with
  // no matching step (codex has no tool-use id) gets a standalone line.

  private appendPermissionNote(ev: PermissionEvent) {
    if (this.permEls.has(ev.requestId)) return;
    const card = ev.toolUseId ? this.toolEls.get(ev.toolUseId) : undefined;
    if (card) {
      card.classList.add("awaiting");
      this.setStepNote(card, "Waiting for approval", "pending");
      this.permEls.set(ev.requestId, card);
    } else {
      const note = el("div", "perm-note pending");
      const { verb, target } = toolLabel(ev.tool, ev.input);
      note.dataset.what = `${verb}${target ? " " + target : ""}`;
      note.textContent = `Waiting for approval · ${note.dataset.what}`;
      this.logEl.append(note);
      this.permEls.set(ev.requestId, note);
    }
    this.dock.add(ev);
  }

  /** A short status beside a step's label ("Waiting for approval", "Denied — …"). */
  private setStepNote(card: HTMLElement, text: string, kind: string) {
    const summary = card.querySelector(":scope > summary") as HTMLElement;
    let note = summary.querySelector(".step-note") as HTMLElement | null;
    if (!text) return note?.remove();
    if (!note) {
      note = el("span", "step-note");
      summary.querySelector(".tool-stat")!.before(note);
    }
    note.className = `step-note ${kind}`;
    note.textContent = text;
    note.title = text;
  }

  private answerPermission(ev: PermissionEvent, a: DockAnswer) {
    this.wsSend({ t: "approve", requestId: ev.requestId, decision: a.decision, ...(a.message ? { message: a.message } : {}) });
    // Plan approval also picks the mode to carry on in, as the CLI does.
    if (a.mode && a.decision !== "deny") this.wsSend({ t: "setMode", mode: a.mode });
  }

  private resolvePermissionNote(requestId: string, decision: string, message?: string) {
    this.dock.resolve(requestId);
    const target = this.permEls.get(requestId);
    if (!target) return;
    if (target.classList.contains("tool-card")) {
      target.classList.remove("awaiting");
      if (decision === "deny") this.setStepNote(target, message ? `Denied — “${message}”` : "Denied", "denied");
      else this.setStepNote(target, decision === "always" ? "Always allowed" : "", "allowed");
      return;
    }
    target.classList.remove("pending");
    target.classList.add(decision === "deny" ? "denied" : "allowed");
    const what = target.dataset.what || "";
    target.textContent =
      decision === "deny"
        ? `Denied · ${what}${message ? ` — “${message}”` : ""}`
        : `${decision === "always" ? "Always allowed" : "Allowed"} · ${what}`;
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

  // ---- Edit & resend (rewind) -------------------------------------------------

  /**
   * "Edit" on your own messages: hover on desktop, tap the message on a phone.
   * Claude chat panes only — codex has no rewind, and a remote session's
   * files and history live on another machine.
   */
  private addEditAction(bubble: HTMLElement, messageId: string, text: string) {
    if (this.isCodex || this.isRemote || !messageId) return;
    bubble.dataset.id = messageId;
    bubble.classList.add("editable");
    const edit = el("button", "msg-edit") as HTMLButtonElement;
    edit.textContent = "Edit";
    edit.title = "Edit this message and resend from here";
    edit.addEventListener("click", (e) => {
      e.stopPropagation();
      this.startRewind(bubble, messageId, text);
    });
    bubble.append(edit);
    bubble.addEventListener("click", (e) => {
      // Phone: tapping your message reveals Edit (no hover on touch). Only in
      // an open pane — in the grid, a click still means "open this box".
      if (!this.el.classList.contains("zoomed")) return;
      if ((e.target as HTMLElement).closest("img, a, .msg-edit")) return;
      e.stopPropagation();
      bubble.classList.toggle("show-edit");
    });
  }

  private startRewind(bubble: HTMLElement, messageId: string, text: string) {
    if (this.busy) return this.flashNote("Wait for the current turn to finish, or stop it first.");
    if (this.rewind) this.cancelRewind();
    const editor = createRewindEditor(
      text,
      (body, restoreFiles) => this.wsSend({ t: "rewind", messageId, text: body, restoreFiles }),
      () => this.cancelRewind()
    );
    bubble.hidden = true;
    bubble.after(editor.el);
    this.rewind = { messageId, editor, bubble };
    editor.focus();
    editor.el.scrollIntoView({ block: "nearest" });
    this.wsSend({ t: "rewindPreview", messageId });
  }

  private cancelRewind() {
    if (!this.rewind) return;
    this.rewind.editor.el.remove();
    this.rewind.bubble.hidden = false;
    this.rewind.bubble.classList.remove("show-edit");
    this.rewind = null;
  }

  /** "Rewound · Undo" — one level, until dismissed or the next rewind. */
  private showUndoBar(text: string) {
    this.undoBar.textContent = "";
    const t = el("span", "rw-undo-text");
    t.textContent = text;
    const undo = el("button", "rw-undo-btn") as HTMLButtonElement;
    undo.textContent = "Undo";
    undo.title = "Put the conversation (and any restored files) back as they were";
    undo.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this.busy) return this.flashNote("Wait for the current turn to finish, or stop it first.");
      undo.disabled = true;
      this.wsSend({ t: "undoRewind" });
    });
    const x = el("button", "rw-undo-x") as HTMLButtonElement;
    x.textContent = "✕";
    x.title = "Dismiss";
    x.setAttribute("aria-label", "Dismiss");
    x.addEventListener("click", (e) => {
      e.stopPropagation();
      this.undoBar.hidden = true;
    });
    this.undoBar.append(t, undo, x);
    this.undoBar.hidden = false;
    this.scrollToBottom(true); // the bar takes height from the log; keep the new reply in view
  }

  /** The Changes panel over this pane's chat (changes-panel.ts). */
  private showChanges() {
    const chat = this.el.querySelector(".chat") as HTMLElement | null;
    if (chat) openChanges(chat, this.id);
  }

  // ---- Connection, retries, compaction, context, background tasks ---------------

  /**
   * "Reconnecting…" over the log while the socket is down. Delayed a beat so
   * the routine wake-from-sleep reconnect (usually <1s) doesn't flash it —
   * it's for "this is NOT live right now", not for every blip.
   */
  private setConnected(on: boolean) {
    if (on) {
      if (this.connTimer != null) clearTimeout(this.connTimer);
      this.connTimer = undefined;
      this.connEl.hidden = true;
    } else if (this.connEl.hidden && this.connTimer == null) {
      // Not restarted by each failed retry (one per second while the server
      // is down) — that kept pushing the banner back so it never showed.
      this.connTimer = window.setTimeout(() => {
        this.connTimer = undefined;
        this.connEl.hidden = false;
      }, 1500);
    }
  }

  /** The API is overloaded/erroring and the SDK is backing off — say so instead of looking hung. */
  private showRetry(attempt: number, max: number, delayMs: number, status: number | null) {
    this.statusEl.hidden = false;
    this.statusEl.classList.add("retry");
    const word = this.statusEl.querySelector(".status-word") as HTMLElement | null;
    const text = `Retrying in ${Math.max(1, Math.round(delayMs / 1000))}s · attempt ${attempt}/${max}${status ? ` (API ${status})` : ""}`;
    if (word) word.textContent = text;
    else this.statusEl.textContent = text;
  }

  private appendCompact(trigger: string, pre?: number, post?: number) {
    this.endToolGroup();
    const k = (n?: number) => (n == null ? "" : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
    const d = el("div", "compact-divider");
    const label = el("span", "compact-label");
    label.textContent =
      `Conversation compacted${trigger === "manual" ? "" : " automatically"}` +
      (pre ? ` · ${k(pre)}${post ? ` → ${k(post)}` : ""} tokens` : "");
    d.append(label);
    this.logEl.append(d);
  }

  /** How full the context window is: "23%" in the composer row, colour-ramped like the usage rings. */
  private setContext(percent: number, used: number, max: number) {
    this.ctxEl.hidden = false;
    this.ctxEl.className = `ctx-meter ${usageLevel(percent)}`;
    this.ctxEl.textContent = "";
    const bar = el("span", "ctx-bar");
    const fill = el("span", "ctx-fill");
    fill.style.width = `${Math.min(100, Math.max(2, percent))}%`;
    bar.append(fill);
    const n = el("span", "ctx-num");
    n.textContent = `${percent}%`;
    this.ctxEl.append(bar, n);
    this.ctxEl.title = `Context: ${used.toLocaleString()} of ${max.toLocaleString()} tokens used`;
    this.ctxEl.setAttribute("aria-label", `Context ${percent}% full`);
    this.ctxInfo = { percent, used, max };
    this.renderInfo();
  }

  /**
   * Background tasks (subagents, background shells) in a tray above the
   * composer, each with its own ■ — the turn's Stop leaves them running
   * (perTaskStopAffordance in the driver). Finished ones linger a moment so
   * you see how they ended, then go.
   */
  private updateTask(task: AgentTask) {
    const live = task.status === "running" || task.status === "pending" || task.status === "paused";
    this.tasks.set(task.id, task);
    if (!live) setTimeout(() => {
      if (this.tasks.get(task.id) === task) {
        this.tasks.delete(task.id);
        this.renderTasks();
      }
    }, 5000);
    // Mark the step that launched it.
    const card = task.toolUseId ? this.toolEls.get(task.toolUseId) : undefined;
    if (card && task.backgrounded) this.setStepNote(card, live ? "Running in background" : task.status === "completed" ? "Finished" : task.status === "failed" ? "Failed" : "Stopped", live ? "pending" : task.status === "failed" ? "denied" : "allowed");
    this.renderTasks();
  }

  private renderTasks() {
    this.taskTray.textContent = "";
    // Only backgrounded work belongs here; a foreground subagent is already
    // visible as its Agent step and stops with the turn.
    const list = [...this.tasks.values()].filter((t) => t.backgrounded);
    this.taskTray.hidden = !list.length;
    for (const t of list) {
      const live = t.status === "running" || t.status === "pending" || t.status === "paused";
      const row = el("div", `task-row ${t.status}`);
      const dot = el("span", "task-dot");
      const text = el("span", "task-text");
      const name = el("span", "task-name");
      name.textContent = t.description || (t.kind === "local_bash" ? "Background command" : "Background task");
      const sub = el("span", "task-sub");
      const bits = [
        t.kind === "local_bash" ? "shell" : t.kind || "agent",
        live ? t.summary || (t.lastTool ? `using ${t.lastTool}` : "running") : t.status,
        t.durationMs ? fmtDuration(t.durationMs) : "",
      ].filter(Boolean);
      sub.textContent = bits.join(" · ");
      text.append(name, sub);
      row.append(dot, text);
      if (live) {
        const stop = el("button", "task-stop") as HTMLButtonElement;
        setIcon(stop, "stop");
        stop.title = "Stop this task";
        stop.setAttribute("aria-label", `Stop ${name.textContent}`);
        stop.addEventListener("click", (e) => {
          e.stopPropagation();
          stop.disabled = true;
          this.wsSend({ t: "stopTask", id: t.id });
        });
        row.append(stop);
      }
      this.taskTray.append(row);
    }
  }

  // ---- Earlier history ---------------------------------------------------------
  // The replay ring holds the last ~300 events; anything older is fetched from
  // the transcript a page at a time as you scroll toward the top.

  private requestHistory() {
    if (this.historyLoading || !this.historyMore || !this.headKeys.length) return;
    this.historyLoading = true;
    this.renderHistoryTop();
    this.wsSend({ t: "history", anchors: this.headKeys });
  }

  private renderHistoryTop() {
    if (!this.historyTop) return;
    const t = this.historyTop;
    t.classList.toggle("loading", this.historyLoading);
    t.textContent = this.historyLoading ? "Loading earlier messages…" : this.historyMore ? "Load earlier messages" : "";
    t.hidden = !this.historyLoading && !this.historyMore;
  }

  /** Render an older page off-screen with this view's own renderer, then slide it in above, keeping your place. */
  private prependHistory(events: AgentEvent[], more: boolean) {
    this.historyLoading = false;
    this.historyMore = more && events.length > 0;
    if (events.length) {
      const saved = {
        log: this.logEl,
        g: this.toolGroupEl,
        gb: this.toolGroupBody,
        ts: this.turnStart,
        te: this.turnEls,
        tf: this.turnFiles,
        last: this.lastTs,
      };
      const page = el("div", "chat-log");
      this.logEl = page;
      this.endToolGroup();
      this.turnStart = null;
      this.turnEls = [];
      this.turnFiles = new Set();
      this.lastTs = undefined;
      this.prepending = true;
      try {
        for (const ev of events) this.applyEvent(ev);
      } finally {
        this.prepending = false;
        this.logEl = saved.log;
        this.toolGroupEl = saved.g;
        this.toolGroupBody = saved.gb;
        this.turnStart = saved.ts;
        this.turnEls = saved.te;
        this.turnFiles = saved.tf;
        this.lastTs = saved.last;
      }
      const before = this.logEl.scrollHeight;
      const top = this.logEl.scrollTop;
      this.historyTop.after(...page.childNodes);
      this.logEl.scrollTop = top + (this.logEl.scrollHeight - before);
      this.headKeys = [...headKeysOf(events), ...this.headKeys].slice(0, 40);
    }
    this.renderHistoryTop();
  }

  // ---- Queued messages ----------------------------------------------------------

  private renderQueue() {
    this.queueEl.textContent = "";
    this.queueEl.hidden = !this.queued.length;
    this.queued.forEach((text, i) => {
      const row = el("div", "queued");
      const label = el("span", "queued-label");
      label.textContent = "Queued";
      const body = el("div", "queued-text");
      this.renderUserText(body, text);
      body.title = "Edit";
      body.addEventListener("click", (e) => {
        // Tap to edit: back into the composer.
        e.stopPropagation();
        this.queued.splice(i, 1);
        this.inputEl.value = this.inputEl.value ? `${text}\n${this.inputEl.value}` : text;
        this.renderQueue();
        this.autoGrow();
        this.syncSend();
        this.inputEl.focus();
      });
      const now = el("button", "queued-now") as HTMLButtonElement;
      now.textContent = "Send now";
      now.title = "Send it now — Claude picks it up mid-turn";
      now.addEventListener("click", (e) => {
        e.stopPropagation();
        this.queued.splice(i, 1);
        this.renderQueue();
        this.wsSend({ t: "send", text });
      });
      const x = el("button", "queued-x") as HTMLButtonElement;
      x.textContent = "✕";
      x.title = "Remove";
      x.setAttribute("aria-label", "Remove queued message");
      x.addEventListener("click", (e) => {
        e.stopPropagation();
        this.queued.splice(i, 1);
        this.renderQueue();
      });
      row.append(label, body, now, x);
      this.queueEl.append(row);
    });
  }

  /**
   * A LIVE status change (never a replayed one — a reload must not fire a
   * stale queue). Turn ended cleanly → send what's queued, as one message.
   * Interrupted → put it back in the composer to rethink, as Claude Code does.
   */
  private onLiveStatus(state: string) {
    if (!this.queued.length) return;
    if (state === "idle") {
      const text = this.queued.join("\n\n");
      this.queued = [];
      this.renderQueue();
      this.stick = true;
      this.wsSend({ t: "send", text });
    } else if (state === "aborted") {
      this.inputEl.value = [...this.queued, this.inputEl.value].filter(Boolean).join("\n\n");
      this.queued = [];
      this.renderQueue();
      this.autoGrow();
      this.syncSend();
    }
  }

  private setStatus(state: string, detail?: string, durationMs?: number, ts?: number) {
    this.setBusy(state === "working");
    if (state === "working" || state === "waiting_permission") {
      this.statusEl.hidden = false;
      this.statusEl.textContent = "";
      // Claude Code's own spinner glyph + a word; the spark is animated in CSS.
      const spark = el("span", "spark");
      spark.textContent = "✻";
      const word = el("span", "status-word");
      word.textContent = state === "waiting_permission" ? "Waiting for your approval…" : "Working…";
      const hint = el("span", "status-hint");
      hint.textContent = state === "working" ? "esc to interrupt" : "";
      this.statusEl.append(spark, word, hint);
      this.statusEl.classList.toggle("waiting", state === "waiting_permission");
      this.statusEl.classList.remove("retry");
      this.setSuggestion("");
      return;
    }
    this.statusEl.hidden = true;
    this.closeThinking();
    // The turn is over, so nothing is still in flight: settle any step whose
    // result never arrived (interrupted turn, transcript replay that ended
    // mid-call) instead of letting its dot pulse forever — and drop any
    // prompt nobody can answer any more.
    this.logEl.querySelectorAll(".tool-card.pending").forEach((c) => c.classList.remove("pending"));
    for (const [id, t] of this.permEls)
      if (t.classList.contains("pending") || t.classList.contains("awaiting")) this.resolvePermissionNote(id, "deny");
    for (const card of this.streamingEls.values()) card.classList.remove("streaming");

    if (state === "error") this.appendBubble("error", detail || "Something went wrong.");
    else if (state === "aborted") this.appendBubble("aborted", detail || "This turn was interrupted before finishing.");
    this.appendTurnMeta(durationMs ?? (this.turnStart && ts ? ts - this.turnStart : undefined));
  }

  /**
   * The line under a finished turn: "Worked for 1m 12s" + Copy (the turn's
   * whole reply as Markdown). Only after a turn that actually said something.
   */
  private appendTurnMeta(durationMs?: number) {
    const texts = this.turnEls.slice();
    const files = this.turnFiles.size;
    this.turnStart = null;
    this.turnEls = [];
    this.turnFiles = new Set();
    if (!texts.length && !files) return;
    this.endToolGroup();
    const meta = el("div", "turn-meta");
    const copy = el("button", "turn-copy") as HTMLButtonElement;
    setIcon(copy, "copy");
    copy.title = "Copy reply";
    copy.setAttribute("aria-label", "Copy reply");
    copy.addEventListener("click", async (e) => {
      e.stopPropagation();
      const md = texts.map((t) => t.dataset.raw || t.innerText).join("\n\n");
      try {
        await navigator.clipboard.writeText(md);
        setIcon(copy, "check");
        setTimeout(() => setIcon(copy, "copy"), 1200);
      } catch {}
    });
    if (texts.length) meta.append(copy);
    if (files && !this.isRemote) {
      // Like the app's "Edited 3 files" — opens the Changes panel.
      const ch = el("button", "turn-files") as HTMLButtonElement;
      ch.textContent = `${files} file${files === 1 ? "" : "s"} changed`;
      ch.addEventListener("click", (e) => {
        e.stopPropagation();
        this.showChanges();
      });
      meta.append(ch);
    }
    if (durationMs && durationMs >= 1000) {
      const d = el("span", "turn-time");
      d.textContent = `Worked for ${fmtDuration(durationMs)}`;
      meta.append(d);
    }
    this.logEl.append(meta);
  }

  /** A suggested follow-up: a chip above the composer, and the input's placeholder (Tab takes it). */
  private setSuggestion(text: string) {
    this.suggestion = text;
    this.suggestEl.textContent = "";
    this.suggestEl.hidden = !text;
    this.inputEl.placeholder = text ? `${text}  (Tab)` : this.isCodex ? "Message Codex…" : "Message Claude…";
    if (!text) return;
    const chip = el("button", "suggest-chip") as HTMLButtonElement;
    chip.textContent = text;
    chip.title = "Use this suggestion";
    chip.addEventListener("click", (e) => {
      e.stopPropagation();
      this.inputEl.value = text;
      this.autoGrow();
      this.syncSend();
      this.inputEl.focus();
    });
    this.suggestEl.append(chip);
  }

  /** Fill the model picker: the SDK's list when we have it, else just the current model, disabled. */
  private renderModels() {
    const cur = this.info.model || "";
    this.modelSel.textContent = "";
    const opts = this.models.slice();
    const match = opts.find((m) => m.value === cur || m.resolved === cur);
    if (cur && !match) opts.unshift({ value: cur, label: shortModel(cur), description: "" });
    for (const m of opts) {
      const o = document.createElement("option");
      o.value = m.value;
      o.textContent = m.value === cur ? shortModel(cur) : m.label;
      o.title = m.description;
      this.modelSel.append(o);
    }
    if (match) {
      this.modelSel.value = match.value;
      // The selected row reads as the concrete model ("Opus 5.5"), not "Default".
      const sel = this.modelSel.selectedOptions[0];
      if (sel) sel.textContent = shortModel(cur);
    } else if (cur) this.modelSel.value = cur;
    this.modelSel.disabled = this.models.length < 2 || this.isRemote;
    this.modelSel.hidden = !opts.length;
    const chip = this.modelSel.parentElement;
    if (chip?.classList.contains("sel-chip")) {
      chip.hidden = !opts.length;
      chip.classList.toggle("disabled", this.modelSel.disabled);
    }
    syncChip(this.modelSel);
    this.modelSel.title = cur ? `Model: ${cur}` : "Model";
  }

  /** Reflects the session's current permission mode in the composer's selector — see the `mode` AgentEvent. */
  private setModeUI(mode: string) {
    // A codex pane created before this control existed has "default"
    // persisted, which matches none of the codex <option> values and would
    // render the select blank. Codex's own default is Auto, so land there.
    if (this.isCodex && !["read-only", "auto", "full-access"].includes(mode)) mode = "auto";
    this.modeSel.value = mode;
    // The one mode per provider that skips every approval prompt — worth a
    // visual "this is the dangerous one" cue.
    this.modeSel.classList.toggle("bypass", mode === "bypassPermissions" || mode === "full-access");
    this.modeSel.classList.toggle("plan", mode === "plan");
    const chip = this.modeSel.parentElement;
    if (chip?.classList.contains("sel-chip")) {
      chip.classList.toggle("bypass", mode === "bypassPermissions" || mode === "full-access");
      chip.classList.toggle("plan", mode === "plan");
    }
    syncChip(this.modeSel);
  }

  private scrollToBottom(force = false) {
    if (force || this.stick) this.logEl.scrollTop = this.logEl.scrollHeight;
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
    this.busy = on;
    // The composer's button becomes Stop while a turn runs (see syncSend).
    if (this.sendBtn) this.syncSend();
  }

  /**
   * Render this pane's account usage. A remote pane deliberately shows nothing:
   * its agent runs on another host against THAT machine's account, so the local
   * numbers would be confidently wrong.
   */
  setUsage(row: UsageRow | null) {
    this.usageRow = row;
    this.renderInfo();
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

  /**
   * The + menu's header: plan usage and context spelled out in words — the
   * composer row only has room for bare numbers (and on a phone, not even
   * for the usage rings).
   */
  private renderInfo() {
    if (!this.infoEl) return;
    this.infoEl.textContent = "";
    const line = (label: string, value: string, sub: string) => {
      const r = el("div", "info-line");
      const l = el("span", "info-label");
      l.textContent = label;
      const v = el("span", "info-value");
      v.textContent = value;
      r.append(l, v);
      if (sub) {
        const s2 = el("span", "info-sub");
        s2.textContent = sub;
        r.append(s2);
      }
      this.infoEl.append(r);
    };
    if (this.ctxInfo) {
      const k = (n: number) =>
        n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
      line("Context", `${this.ctxInfo.percent}%`, `${k(this.ctxInfo.used)} of ${k(this.ctxInfo.max)} tokens in this chat`);
    }
    const row = this.usageRow;
    if (row && row.available && !this.isRemote) {
      for (const w of [row.primary, row.secondary].filter(Boolean) as UsageWindow[]) {
        const name = /5.?h/i.test(w.label) ? "5-hour limit" : /7.?d|week/i.test(w.label) ? "Weekly limit" : w.label;
        line(name, `${Math.round(w.percent)}%`, w.resetsAt ? `resets ${resetAt(w.resetsAt)}` : "");
      }
    }
    this.infoEl.hidden = !this.infoEl.childElementCount;
  }

  /** Which model this session resolved to; hidden until the driver says. */
  setModel(model: string) {
    if (!model) return;
    this.info.model = model;
    if (this.modelSel) this.renderModels();
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
    if (this.dock.open) this.dock.focus();
    else this.inputEl.focus();
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
