import { Terminal as Xterm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { xtermTheme, xtermFontSize } from "./theme";

export interface PaneInfo {
  id: string;
  cwd: string;
  cmd: string;
  attention?: { waiting: boolean; kind: "question" | "done" | null };
  followUp?: boolean;
  createdAt: number;
}

export interface TermHost {
  onOpen(t: Term): void; // user clicked the box → zoom it
  onClose(t: Term): void; // × → kill it
  onMinimize(t: Term): void; // – → send to tray
  onToggleFollowUp(t: Term): void; // 🚩 → toggle the follow-up flag
}

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
  private badgeSlot: HTMLElement;
  private term: Xterm;
  private fit: FitAddon;
  private ws?: WebSocket;
  private ro: ResizeObserver;
  private reconnectTimer?: number;
  private connectedOnce = false; // have we ever had an open socket?
  private disposed = false;

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
      `<button class="ctl img" title="Add image to prompt">🖼</button>` +
      `<button class="ctl flag" title="Mark for follow-up">🚩</button>` +
      `<button class="ctl min" title="Minimize">–</button>` +
      `<button class="ctl close" title="Close">✕</button>`;
    (this.titleBar.querySelector(".path") as HTMLElement).textContent =
      basename(info.cwd);
    (this.titleBar.querySelector(".path") as HTMLElement).title = info.cwd;
    this.badgeSlot = this.titleBar.querySelector(".badge-slot") as HTMLElement;
    this.xtEl = el("div", "xt");
    this.el.append(this.titleBar, this.xtEl);
    this.cell.append(this.el);

    this.term = new Xterm({
      fontFamily: "ui-monospace, Menlo, monospace",
      fontSize: xtermFontSize(),
      cursorBlink: true,
      scrollback: 5000,
      theme: xtermTheme(),
    });
    this.fit = new FitAddon();
    this.term.loadAddon(this.fit);
    this.term.open(this.xtEl);
    this.term.onData((d) => this.send({ t: "d", d }));

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
    // 🖼 opens a file picker — the same path-injection flow as drag-and-drop.
    const fileInput = el("input", "img-input") as HTMLInputElement;
    fileInput.type = "file";
    fileInput.accept = "image/*";
    fileInput.multiple = true;
    fileInput.hidden = true;
    this.el.append(fileInput);
    this.titleBar.querySelector(".img")!.addEventListener("click", (e) => {
      e.stopPropagation();
      fileInput.click();
    });
    fileInput.addEventListener("change", () => {
      const files = Array.from(fileInput.files || []).filter((f) =>
        f.type.startsWith("image/")
      );
      fileInput.value = ""; // let the same file be re-picked next time
      if (files.length) void this.dropImages(files);
    });

    // Click the box (outside the controls) opens/zooms it.
    this.el.addEventListener("click", (e) => {
      const tgt = e.target as HTMLElement;
      if (tgt.closest(".ctl")) return;
      host.onOpen(this);
    });

    this.wireImageDrop();

    this.ro = new ResizeObserver(() => this.refit());
    this.ro.observe(this.xtEl);

    this.connect();
    if (info.attention?.waiting && info.attention.kind) {
      this.setWaiting(true, info.attention.kind);
    }
    if (info.followUp) this.setFollowUp(true);
  }

  private connect() {
    if (this.disposed) return;
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
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.t === "d") this.term.write(m.d);
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
   * Let users drop image files onto the box. We intercept the drop (otherwise the
   * browser just navigates to the image), upload each to the server, and type the
   * returned absolute path into the prompt — the same thing dragging an image into
   * a native terminal does, which is how Claude picks up images.
   */
  private wireImageDrop() {
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
      const files = Array.from(e.dataTransfer?.files || []).filter((f) =>
        f.type.startsWith("image/")
      );
      if (!files.length) return; // not images → let the browser/xterm do its thing
      e.preventDefault();
      e.stopPropagation();
      void this.dropImages(files);
    });
  }

  private async dropImages(files: File[]) {
    const paths: string[] = [];
    for (const f of files) {
      try {
        const dataUrl = await readAsDataURL(f);
        const res = await fetch(`/api/panes/${this.id}/image`, {
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
