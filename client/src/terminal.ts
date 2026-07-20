import { Terminal as Xterm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { installFileLinks } from "./links";
import "@xterm/xterm/css/xterm.css";
import { xtermTheme, xtermFontSize } from "./theme";

export interface PaneInfo {
  id: string;
  cwd: string;
  cmd: string;
  attention?: { waiting: boolean; kind: "question" | "done" | null };
  followUp?: boolean;
  lastInput?: string;
  color?: string;
  name?: string; // user-chosen display name; ""/absent = show the cwd basename
  createdAt: number;
}

/** What to call this pane everywhere it's shown: custom name, else folder name. */
export function displayName(info: { name?: string; cwd: string }): string {
  return info.name || basename(info.cwd);
}

export interface TermHost {
  onOpen(t: Term): void; // user clicked the box → zoom it
  onClose(t: Term): void; // × → kill it
  onMinimize(t: Term): void; // – → send to tray
  onToggleFollowUp(t: Term): void; // 🚩 → toggle the follow-up flag
  onSetColor(t: Term, color: string): void; // ● → tint the border ("" = clear)
  onRename(t: Term, name: string): void; // title text edited ("" = revert to folder)
}

// The five border tints offered in the color popover.
export const TINT_COLORS = ["#f85149", "#e3b341", "#3fb950", "#58a6ff", "#bc8cff"];

/**
 * One terminal box: a DOM cell + an xterm bound to a WebSocket to its PTY.
 * Knows nothing about the grid, zoom, tray, or drag — it just renders, forwards
 * bytes, and exposes `cell`, `el`, and `titleBar` for the orchestrator to drive.
 */
export class Term {
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

  constructor(info: PaneInfo, host: TermHost) {
    this.id = info.id;
    this.info = info;

    this.cell = el("div", "cell");
    this.el = el("div", "term");
    this.titleBar = el("div", "title");
    this.titleBar.innerHTML =
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
    this.pinnedEl = el("div", "pinned");
    this.pinnedEl.hidden = true;
    this.xtEl = el("div", "xt");
    this.el.append(this.titleBar, this.pinnedEl, this.xtEl);
    this.cell.append(this.el);

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
    installFileLinks(this.term, (path, line) => this.openFile(path, line));
    this.term.onData((d) => {
      if (this.muteInput) return; // replay-triggered query answers, not the user
      this.send({ t: "d", d });
    });

    // Window controls. (Drag-to-reorder is wired by the orchestrator on titleBar.)
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
    const fileInput = el("input", "file-input") as HTMLInputElement;
    fileInput.type = "file";
    fileInput.multiple = true;
    fileInput.hidden = true;
    this.el.append(fileInput);
    this.titleBar.querySelector(".attach")!.addEventListener("click", (e) => {
      e.stopPropagation();
      fileInput.click();
    });
    fileInput.addEventListener("change", () => {
      const files = Array.from(fileInput.files || []);
      fileInput.value = ""; // let the same file be re-picked next time
      if (files.length) void this.dropFiles(files);
    });

    // Click the box (outside the controls) opens/zooms it.
    this.el.addEventListener("click", (e) => {
      const tgt = e.target as HTMLElement;
      if (tgt.closest(".ctl")) return;
      host.onOpen(this);
    });

    this.wireFileDrop();

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
   * Let users drop files onto the box. We intercept the drop (otherwise the
   * browser just navigates to the file), upload each to the server, and type the
   * returned absolute path into the prompt — the same thing dragging a file into
   * a native terminal does, which is how Claude picks up images and documents.
   */
  private wireFileDrop() {
    const target = this.el;
    let depth = 0; // dragenter/leave fire per child; count to know when we truly left

    const hasFiles = (e: DragEvent) =>
      Array.from(e.dataTransfer?.types || []).includes("Files");

    target.addEventListener("dragenter", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      target.classList.add("dropping");
    });
    target.addEventListener("dragover", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    });
    target.addEventListener("dragleave", (e) => {
      if (!hasFiles(e)) return;
      if (--depth <= 0) {
        depth = 0;
        target.classList.remove("dropping");
      }
    });
    target.addEventListener("drop", (e) => {
      depth = 0;
      target.classList.remove("dropping");
      const items = Array.from(e.dataTransfer?.items || []).filter(
        (it) => it.kind === "file"
      );
      if (!items.length) return; // not a file drop → let the browser/xterm do its thing
      e.preventDefault(); // even a folders-only drop must not navigate the page
      e.stopPropagation();
      const files: File[] = [];
      for (const it of items) {
        // Folders arrive as zero-byte phantom "files" — detect and skip them
        // rather than upload garbage. (Folder upload is deliberately unsupported.)
        if (it.webkitGetAsEntry?.()?.isDirectory) continue;
        const f = it.getAsFile();
        if (f) files.push(f);
      }
      if (files.length) void this.dropFiles(files);
    });
  }

  private async dropFiles(files: File[]) {
    const paths: string[] = [];
    for (const f of files) {
      // Base64-over-JSON transport caps out ~20MB real bytes (30MB body limit);
      // bigger files would 413 anyway, so skip them up front.
      if (f.size > 20 * 1024 * 1024) {
        console.error(`file too large to attach (>20MB): ${f.name}`);
        continue;
      }
      try {
        const dataUrl = await readAsDataURL(f);
        const res = await fetch(`/api/panes/${this.id}/file`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: f.name, dataUrl }),
        });
        if (!res.ok) {
          console.error("image upload failed", await res.text());
          continue;
        }
        const { path } = await res.json();
        if (path) paths.push(path);
      } catch (err) {
        console.error("image upload failed", err);
      }
    }
    if (!paths.length) return;
    // Type the path(s) into the prompt with a trailing space, but don't submit —
    // the user adds their message and hits Enter.
    this.send({ t: "d", d: paths.join(" ") + " " });
    this.focusTerm();
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

function readAsDataURL(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

function el(tag: string, cls: string): HTMLElement {
  const n = document.createElement(tag);
  n.className = cls;
  return n;
}

function basename(p: string): string {
  const parts = p.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || p;
}
