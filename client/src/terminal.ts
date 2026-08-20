import { Terminal as Xterm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { installFileLinks } from "./links";
import "@xterm/xterm/css/xterm.css";
import { xtermTheme, xtermFontSize } from "./settings";
import { uploadFiles, wireFileDrop, wireFilePicker } from "./attach";

export interface PaneInfo {
  id: string;
  kind: "pty" | "agent";
  cwd: string;
  cmd: string;
  attention?: { waiting: boolean; kind: "question" | "done" | null };
  /** Is something running in this pane right now? (see PtyManager's work detection) */
  working?: boolean;
  followUp?: boolean;
  lastInput?: string;
  color?: string;
  name?: string; // user-chosen display name; ""/absent = show the cwd basename
  createdAt: number;
  /** Claude Agent SDK permission mode (agent panes only — see agent-chat.ts's mode selector). */
  mode?: "default" | "acceptEdits" | "auto" | "plan" | "bypassPermissions";
}

/** What to call this pane everywhere it's shown: custom name, else folder name. */
export function displayName(info: { name?: string; cwd: string }): string {
  return info.name || basename(info.cwd);
}

/**
 * What the orchestrator (main.ts) needs from any pane box, terminal or not —
 * grid/zoom/tray/drag/attention all drive this shape, not `Term` directly, so
 * a non-terminal view (e.g. a mobile agent-chat pane) can slot in alongside
 * `Term` with zero changes to that code. `Term` implements this.
 */
export interface PaneView {
  id: string;
  info: PaneInfo;
  cell: HTMLElement; // grid placeholder (keeps the slot during zoom/drag)
  el: HTMLElement; // the .term box (this is what zooms/drags)
  titleBar: HTMLElement; // drag handle
  isWaiting(): boolean;
  waitingKind(): "question" | "done";
  setWaiting(on: boolean, kind?: "question" | "done"): void;
  setBusy(on: boolean): void;
  isFlagged(): boolean;
  setFollowUp(on: boolean): void;
  setColor(color: string): void;
  setName(name: string): void;
  setAppearance(theme: object, fontSize: number): void;
  setLastInput(text: string): void;
  refit(): void;
  focusTerm(): void;
  reconnectNow(): void;
  dispose(): void;
}

export interface TermHost {
  onOpen(t: PaneView): void; // user clicked the box → zoom it
  onBack(t: PaneView): void; // ‹ (mobile, zoomed only) → unzoom, unambiguously
  onClose(t: PaneView): void; // × → kill it
  onMinimize(t: PaneView): void; // – → send to tray
  onToggleFollowUp(t: PaneView): void; // 🚩 → toggle the follow-up flag
  onSetColor(t: PaneView, color: string): void; // ● → tint the border ("" = clear)
  onRename(t: PaneView, name: string): void; // title text edited ("" = revert to folder)
}

// The five border tints offered in the color popover.
export const TINT_COLORS = ["#f85149", "#e3b341", "#3fb950", "#58a6ff", "#bc8cff"];

/**
 * One terminal box: a DOM cell + an xterm bound to a WebSocket to its PTY.
 * Knows nothing about the grid, zoom, tray, or drag — it just renders, forwards
 * bytes, and exposes `cell`, `el`, and `titleBar` for the orchestrator to drive.
 */
export class Term implements PaneView {
  id: string;
  info: PaneInfo;
  cell: HTMLElement; // grid placeholder (keeps the slot during zoom/drag)
  el: HTMLElement; // the .term box (this is what zooms/drags)
  titleBar: HTMLElement; // drag handle
  private xtEl: HTMLElement;
  private pinnedEl: HTMLElement; // pinned "last prompt you sent" strip
  private badgeSlot: HTMLElement;
  private term: Xterm;
  private fit: FitAddon;
  private ws?: WebSocket;
  private ro: ResizeObserver;
  private reconnectTimer?: number;
  private connectedOnce = false; // have we ever had an open socket?
  private disposed = false;
  // While the server's scrollback replay is being parsed, xterm auto-answers any
  // terminal queries it contains (DA/DSR/…). Those answers must NOT reach the
  // live shell — they'd be typed as junk ("1;2c0;276;0c") at the prompt. The
  // server strips known queries from the replay; this mute catches the rest.
  private muteInput = false;
  private replayGen = 0; // guards against a stale replay callback unmuting a newer one
  private ctrlArmed = false; // mobile soft-key "Ctrl" toggle — see wireSoftKeys()
  private ctrlKeyBtn?: HTMLElement;

  constructor(info: PaneInfo, host: TermHost) {
    this.id = info.id;
    this.info = info;

    this.cell = el("div", "cell");
    this.el = el("div", "term");
    this.titleBar = el("div", "title");
    this.titleBar.innerHTML =
      `<button class="ctl back" title="Back">‹</button>` +
      `<span class="dot">●</span>` +
      `<span class="path"></span>` +
      `<span class="badge-slot"></span>` +
      `<span class="spacer"></span>` +
      `<button class="ctl attach" title="Add file(s) to prompt">📎</button>` +
      `<button class="ctl color" title="Color-code this terminal"></button>` +
      `<button class="ctl flag" title="Mark for follow-up">🚩</button>` +
      `<button class="ctl min" title="Minimize">–</button>` +
      `<button class="ctl close" title="Close">✕</button>`;
    (this.titleBar.querySelector(".path") as HTMLElement).textContent =
      displayName(info);
    (this.titleBar.querySelector(".path") as HTMLElement).title = info.cwd;
    this.wireRename(host);
    this.badgeSlot = this.titleBar.querySelector(".badge-slot") as HTMLElement;
    const cwdline = el("div", "cwdline");
    cwdline.textContent = info.cwd;
    this.pinnedEl = el("div", "pinned");
    this.pinnedEl.hidden = true;
    this.xtEl = el("div", "xt");
    // Mobile-only, shown while zoomed (see styles.css): a phone's on-screen
    // keyboard has no Esc or Ctrl, and without Esc there's no way to interrupt
    // Claude Code from a phone at all. Sits at the bottom of the (already
    // keyboard-aware-sized, see centerRect() in main.ts) zoomed box, so it
    // naturally ends up right above the keyboard when one is open.
    const softkeys = el("div", "softkeys");
    softkeys.innerHTML =
      `<button data-key="Escape">Esc</button>` +
      `<button data-key="Ctrl" class="ctrl-key">Ctrl</button>` +
      `<button data-key="Tab">Tab</button>` +
      `<button data-key="Up">↑</button>` +
      `<button data-key="Down">↓</button>` +
      `<button data-key="Left">←</button>` +
      `<button data-key="Right">→</button>`;
    this.xtEl.append(workingOverlay());
    this.el.append(this.titleBar, cwdline, this.pinnedEl, this.xtEl, softkeys);
    this.cell.append(this.el);
    this.setBusy(!!info.working);
    this.wireSoftKeys(softkeys);
    // Boxes opened via the "claude (work)" / "codex (work)" picker options get
    // a dark-green title tint + a faint logo watermark centered over the
    // terminal, so they're visually distinct from personal-account boxes
    // without getting in the way of reading the actual output. No manual
    // step — `cmd` persists across respawns, so the tag survives them too.
    if (info.cmd === "claude-work" || info.cmd === "codex-work") {
      this.el.classList.add("work");
      const logo = el("img", "work-logo") as HTMLImageElement;
      logo.src = "/didit-logo-white.png";
      logo.alt = "";
      this.xtEl.append(logo);
    }

    this.term = new Xterm({
      // Required to load the Unicode11 addon below — it's an xterm "proposed API".
      // Without this, loadAddon(Unicode11Addon) throws and the whole Term ctor
      // fails, so no terminal box ever mounts (blank grid, recover does nothing).
      allowProposedApi: true,
      // Monospace first, then symbol/emoji fallbacks so Claude's TUI glyphs
      // (e.g. ⏵ U+23F5, arrows) render instead of showing missing-glyph marks.
      fontFamily:
        'ui-monospace, Menlo, Monaco, "DejaVu Sans Mono", "Apple Symbols", "Segoe UI Symbol", "Noto Sans Symbols2", "Apple Color Emoji", "Noto Color Emoji", monospace',
      fontSize: xtermFontSize(),
      cursorBlink: true,
      scrollback: 5000,
      theme: xtermTheme(),
    });
    // Use Unicode 11 character widths so emoji (and other post-Unicode-6 glyphs)
    // are measured as 2 cells to match tmux/Claude. Without this, xterm's default
    // Unicode 6 table sizes them at 1 cell, desyncing its grid from the screen and
    // breaking text selection at the first emoji. Must be active before any output.
    this.term.loadAddon(new Unicode11Addon());
    this.term.unicode.activeVersion = "11";
    this.fit = new FitAddon();
    this.term.loadAddon(this.fit);
    this.term.open(this.xtEl);
    // Make URLs clickable (open in a new tab) and file paths clickable (open in
    // an editor via the server). Must come after open() so the DOM layer exists.
    this.term.loadAddon(new WebLinksAddon());
    installFileLinks(this.term, this.id, (path, line) => this.openFile(path, line));
    this.wireTouchScroll();
    this.term.onData((d) => {
      if (this.muteInput) return; // replay-triggered query answers, not the user
      if (this.ctrlArmed) {
        this.ctrlArmed = false;
        this.ctrlKeyBtn?.classList.remove("active");
        d = this.applyCtrl(d);
      }
      this.send({ t: "d", d });
    });

    // Window controls. (Drag-to-reorder is wired by the orchestrator on titleBar.)
    // Mobile-only (see styles.css): the ✕ already unzooms rather than closing
    // when zoomed (see onClose below), but on a full-bleed phone screen that's
    // not obvious — people read ✕ as "close" and avoid it, then have no way
    // back short of backgrounding the browser. This is an unambiguous "back".
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
    this.buildColorPopover(host);
    // 📎 opens a file picker — the same path-injection flow as drag-and-drop.
    wireFilePicker(this.titleBar.querySelector(".attach")!, this.el, (files) => void this.dropFiles(files));

    // Click the box (outside the controls) opens/zooms it.
    this.el.addEventListener("click", (e) => {
      const tgt = e.target as HTMLElement;
      if (tgt.closest(".ctl")) return;
      host.onOpen(this);
    });

    wireFileDrop(this.el, (files) => void this.dropFiles(files));

    this.ro = new ResizeObserver(() => this.refit());
    this.ro.observe(this.xtEl);

    this.connect();
    if (info.attention?.waiting && info.attention.kind) {
      this.setWaiting(true, info.attention.kind);
    }
    if (info.followUp) this.setFollowUp(true);
    if (info.lastInput) this.setLastInput(info.lastInput);
    if (info.color) this.setColor(info.color);
  }

  /** Set the custom display name ("" reverts to the folder name). */
  setName(name: string) {
    this.info.name = name;
    const pathEl = this.titleBar.querySelector(".path") as HTMLElement;
    pathEl.textContent = displayName(this.info);
  }

  /**
   * Click the title text → edit it in place. Enter/blur saves, Esc cancels;
   * saving empty (or the folder's own name) clears the custom name.
   */
  private wireRename(host: TermHost) {
    const pathEl = this.titleBar.querySelector(".path") as HTMLElement;
    pathEl.addEventListener("click", (e) => {
      e.stopPropagation(); // the name is an edit target, not a zoom trigger
      if (this.titleBar.querySelector(".rename")) return; // already editing
      const input = el("input", "rename") as HTMLInputElement;
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
        if (name === basename(this.info.cwd)) name = ""; // typing the default = no custom name
        if (name === (this.info.name || "")) return;
        this.setName(name); // optimistic; server broadcast confirms
        host.onRename(this, name);
      };
      input.addEventListener("keydown", (ev) => {
        ev.stopPropagation(); // Esc must cancel the edit, not un-zoom the box
        if (ev.key === "Enter") finish(true);
        else if (ev.key === "Escape") finish(false);
      });
      input.addEventListener("blur", () => finish(true));
      // Clicks/drag-selection inside the input must not zoom or drag the box.
      input.addEventListener("click", (ev) => ev.stopPropagation());
      input.addEventListener("pointerdown", (ev) => ev.stopPropagation());
    });
  }

  /** Tint this box (a hex string), or "" to clear it. */
  setColor(color: string) {
    this.info.color = color;
    // Store `--tint` on the CELL, not the box: zoom/unzoom and drag-end call
    // `el.removeAttribute("style")` on the box, which would wipe an inline custom
    // property there. The cell is never style-stripped, and `--tint` inherits down
    // to the title; the `.tinted` class on the box survives removeAttribute().
    if (color) {
      this.cell.style.setProperty("--tint", color);
      this.el.classList.add("tinted");
    } else {
      this.cell.style.removeProperty("--tint");
      this.el.classList.remove("tinted");
    }
  }

  // The ● control: a popover of 5 swatches + a clear button.
  private buildColorPopover(host: TermHost) {
    const btn = this.titleBar.querySelector(".color") as HTMLElement;
    const pop = el("div", "cpop");
    pop.hidden = true;
    pop.addEventListener("click", (e) => e.stopPropagation()); // don't zoom the box
    for (const c of TINT_COLORS) {
      const sw = el("button", "sw") as HTMLButtonElement;
      sw.style.setProperty("--c", c);
      sw.title = c;
      sw.addEventListener("click", () => {
        this.setColor(c); // optimistic; server broadcast confirms
        host.onSetColor(this, c);
        pop.hidden = true;
      });
      pop.append(sw);
    }
    const clear = el("button", "sw clear") as HTMLButtonElement;
    clear.textContent = "⊘";
    clear.title = "Clear color";
    clear.addEventListener("click", () => {
      this.setColor("");
      host.onSetColor(this, "");
      pop.hidden = true;
    });
    pop.append(clear);
    this.el.append(pop);

    // Toggle on the ● button; close on an outside click.
    const onDoc = (ev: PointerEvent) => {
      const t = ev.target as HTMLElement;
      if (pop.contains(t) || t === btn) return;
      pop.hidden = true;
      document.removeEventListener("pointerdown", onDoc);
    };
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      pop.hidden = !pop.hidden;
      if (!pop.hidden) document.addEventListener("pointerdown", onDoc);
      else document.removeEventListener("pointerdown", onDoc);
    });
  }

  /** Pin the last prompt sent to this window's Claude (from the server). */
  setLastInput(text: string) {
    this.info.lastInput = text;
    const clean = (text || "").replace(/\s+/g, " ").trim();
    this.pinnedEl.hidden = !clean;
    this.pinnedEl.textContent = clean;
    this.pinnedEl.title = text || ""; // full prompt on hover
    this.refit(); // the strip changed the terminal's available height
  }

  private connect() {
    if (this.disposed) return;
    // A fresh connection starts unmuted (its own replay will re-mute); this
    // clears a mute left dangling if the previous socket died mid-replay.
    this.replayGen++;
    this.muteInput = false;
    // On a reconnect the box already shows the old output; the server replays the
    // full scrollback on attach, so clear first to avoid stacking it on top.
    if (this.connectedOnce) {
      try {
        this.term.reset();
      } catch {}
    }
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/term?pane=${this.id}`);
    this.ws = ws;
    ws.onopen = () => {
      this.connectedOnce = true;
      this.refit();
    };
    // The first "d" on a fresh socket is the server's scrollback replay (sent
    // unconditionally on attach). Mute input until xterm has finished parsing
    // it, so any query answers it provokes are dropped instead of typed into
    // the shell. Live output after that flows (and unmutes) normally.
    let sawReplay = false;
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.t !== "d") return;
      if (!sawReplay) {
        sawReplay = true;
        const gen = ++this.replayGen;
        this.muteInput = true;
        this.term.write(m.d, () => {
          if (gen === this.replayGen) this.muteInput = false;
        });
      } else {
        this.term.write(m.d);
      }
    };
    // The PTY socket previously never reconnected, so after the laptop slept
    // (which silently kills the socket) the box looked alive but its terminal was
    // dead until a manual page refresh. Reconnect on drop; the server replays
    // scrollback on re-attach, repainting the screen.
    ws.onclose = () => {
      if (this.ws === ws) this.scheduleReconnect();
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {}
    };
  }

  private scheduleReconnect(delay = 1000) {
    if (this.disposed || this.reconnectTimer != null) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
  }

  /**
   * Drop the current socket and reconnect immediately. Used when the page wakes
   * from sleep: the socket may be a "zombie" (readyState still OPEN but actually
   * dead), so we can't trust it — tear it down and re-attach to be sure I/O flows.
   */
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
    this.ws = undefined;
    this.connect();
  }

  private send(m: unknown) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(m));
    }
  }

  /** Resize xterm to its container and tell the PTY the new size. */
  refit() {
    try {
      this.fit.fit();
      this.send({ t: "r", cols: this.term.cols, rows: this.term.rows });
    } catch {}
  }

  focusTerm() {
    this.term.focus();
  }

  /**
   * Let users drop (or 📎-pick) files onto the box: upload each via
   * attach.ts's `uploadFiles` and type the returned absolute path into the
   * prompt — the same thing dragging a file into a native terminal does,
   * which is how Claude picks up images and documents.
   */
  private async dropFiles(files: File[]) {
    const paths = await uploadFiles(this.id, files);
    if (!paths.length) return;
    // Type the path(s) into the prompt with a trailing space, but don't submit —
    // the user adds their message and hits Enter.
    this.send({ t: "d", d: paths.join(" ") + " " });
    this.focusTerm();
  }

  /**
   * Esc/Tab/arrows send their real bytes immediately — identical to a
   * physical keypress, so there's no ambiguity risk the way translating a
   * tap position into keystrokes had. Ctrl is the one two-step key: tapping
   * it arms a one-shot modifier that transforms the next character typed on
   * the real (on-screen) keyboard — e.g. arm Ctrl, then type "c", and "c"
   * arrives as Ctrl-C instead. Tapping Ctrl again while armed cancels it.
   */
  private wireSoftKeys(container: HTMLElement) {
    const KEYS: Record<string, string> = {
      Escape: "\x1b",
      Tab: "\t",
      Up: "\x1b[A",
      Down: "\x1b[B",
      Left: "\x1b[D",
      Right: "\x1b[C",
    };
    this.ctrlKeyBtn = container.querySelector(".ctrl-key") as HTMLElement;
    container.querySelectorAll("button").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation(); // don't let the box's own click-to-zoom/unzoom fire
        const key = (btn as HTMLElement).dataset.key!;
        if (key === "Ctrl") {
          this.ctrlArmed = !this.ctrlArmed;
          this.ctrlKeyBtn?.classList.toggle("active", this.ctrlArmed);
          return;
        }
        this.send({ t: "d", d: KEYS[key] });
        this.focusTerm();
      });
    });
  }

  /**
   * xterm.js already turns a touch-drag into scrollback scrolling on its own
   * — but only while the shell hasn't put the terminal into mouse-tracking
   * mode (xterm's own touch handler explicitly backs off then, since a touch
   * is supposed to become a mouse-report byte sequence instead). tmux mouse
   * mode (`set -g mouse on`, a common tmux default) and some TUI screens in
   * claude/codex turn mouse tracking on, and at that point touch-drag does
   * nothing at all — no scroll, no mouse report either, since we never send
   * touches as synthesized mouse events. This fills that gap: drive
   * scrollback ourselves whenever mouse tracking is the reason xterm's own
   * handling is sitting out, so a touch-drag always scrolls something.
   */
  private wireTouchScroll() {
    let lastY: number | null = null;
    let carry = 0; // fractional line remainder between touchmove events
    this.xtEl.addEventListener(
      "touchstart",
      (e) => {
        lastY =
          e.touches.length === 1 && this.term.modes.mouseTrackingMode !== "none"
            ? e.touches[0].pageY
            : null;
        carry = 0;
      },
      { passive: true },
    );
    this.xtEl.addEventListener(
      "touchmove",
      (e) => {
        if (lastY == null || e.touches.length !== 1) return;
        const y = e.touches[0].pageY;
        const deltaPx = lastY - y;
        lastY = y;
        const cellH = this.term.element
          ? this.term.element.getBoundingClientRect().height / this.term.rows
          : 0;
        if (!cellH) return;
        carry += deltaPx / cellH;
        const lines = Math.trunc(carry);
        if (lines !== 0) {
          this.term.scrollLines(lines);
          carry -= lines;
        }
        e.preventDefault(); // we're driving the scroll; don't let the page also rubber-band
      },
      { passive: false },
    );
    this.xtEl.addEventListener("touchend", () => (lastY = null));
  }

  /** Ctrl-<letter> → the standard control code (Ctrl-C = 0x03, etc). Only
   * transforms the first character; anything else passes through untouched
   * so this is a no-op for non-letter input instead of doing something odd. */
  private applyCtrl(d: string): string {
    const c = d[0];
    if (!c || !/[a-zA-Z]/.test(c)) return d;
    return String.fromCharCode(c.toUpperCase().charCodeAt(0) - 64) + d.slice(1);
  }

  /**
   * A file path was clicked in the terminal. Ask the server to open it in an
   * editor; the server resolves it against this pane's cwd and stats it, so a
   * bad match is a silent no-op. Any failure here is ignored on purpose.
   */
  private openFile(path: string, line?: number) {
    fetch(`/api/panes/${this.id}/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, line }),
    }).catch(() => {});
  }

  /** Re-theme / resize the xterm when the user toggles appearance. */
  setAppearance(theme: object, fontSize: number) {
    this.term.options.theme = theme;
    this.term.options.fontSize = fontSize;
    this.refit();
  }

  isWaiting() {
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

  setBusy(on: boolean) {
    setBusyClass(this.el, on);
  }

  isFlagged() {
    return this.el.classList.contains("flagged");
  }

  setFollowUp(on: boolean) {
    this.el.classList.toggle("flagged", on);
    (this.titleBar.querySelector(".flag") as HTMLElement)?.classList.toggle("active", on);
  }

  dispose() {
    this.disposed = true; // stop any pending/!future reconnect
    if (this.reconnectTimer != null) clearTimeout(this.reconnectTimer);
    this.ro.disconnect();
    if (this.ws) {
      this.ws.onclose = null; // closing on purpose — don't trigger a reconnect
      try {
        this.ws.close();
      } catch {}
    }
    this.term.dispose();
    this.cell.remove();
  }
}

// Half-width katakana (the Matrix alphabet) mixed with digits and the operators
// you'd actually see in code — pure katakana reads as decoration, pure ASCII
// reads as a stack trace. The mix reads as "something is running".
const RAIN_GLYPHS = "ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789<>{}[]()=+*/$;:";
const RAIN_COLUMNS = 40;
const RAIN_GLYPHS_PER_COLUMN = 34; // one copy must out-tall the pane — see styles.css

/**
 * The "this pane is working" overlay: Matrix rain over the pane's content.
 *
 * Deliberately `pointer-events:none` and low-opacity — you read the terminal
 * straight through it and clicks still land on the box. CSS hides AND pauses it
 * unless the box has `.busy`, so an idle grid costs nothing (see styles.css).
 *
 * No canvas and no rAF on purpose: each column is one element animated with a
 * `transform` only, which the compositor owns outright. A dozen busy panes is a
 * few hundred composited layers doing zero per-frame JS, where the canvas
 * version would be a dozen render loops fighting over the main thread.
 *
 * Each column's glyphs are emitted TWICE so `translateY(-50%) → 0` loops
 * seamlessly, and every column gets its own duration/phase/opacity so they
 * never march in lockstep.
 */
export function workingOverlay(): HTMLElement {
  const o = el("div", "busy-rain");
  o.setAttribute("aria-hidden", "true");
  for (let i = 0; i < RAIN_COLUMNS; i++) {
    const col = el("div", "rain-col");
    let seq = "";
    for (let j = 0; j < RAIN_GLYPHS_PER_COLUMN; j++) {
      seq += RAIN_GLYPHS[Math.floor(Math.random() * RAIN_GLYPHS.length)] + "\n";
    }
    col.textContent = seq + seq; // the two identical copies the loop relies on
    col.style.animationDuration = `${(3.2 + Math.random() * 5).toFixed(2)}s`;
    col.style.animationDelay = `${(-Math.random() * 8).toFixed(2)}s`; // negative = start mid-fall
    col.style.opacity = (0.65 + Math.random() * 0.35).toFixed(2);
    o.append(col);
  }
  return o;
}

/**
 * Two classes, not one, so idle panes can be styled (dimmed) as positively as
 * busy ones — a box that has never reported either state gets neither and just
 * renders normally.
 */
export function setBusyClass(box: HTMLElement, on: boolean) {
  box.classList.toggle("busy", on);
  box.classList.toggle("idle", !on);
}

function el(tag: string, cls: string): HTMLElement {
  const n = document.createElement(tag);
  n.className = cls;
  return n;
}

export function basename(p: string): string {
  const parts = p.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || p;
}
