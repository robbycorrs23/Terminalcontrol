import { Terminal as Xterm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { xtermTheme, xtermFontSize } from "./theme";

export interface PaneInfo {
  id: string;
  cwd: string;
  cmd: string;
  attention?: { waiting: boolean; kind: "question" | "done" | null };
  createdAt: number;
}

export interface TermHost {
  onOpen(t: Term): void; // user clicked the box → zoom it
  onClose(t: Term): void; // × → kill it
  onMinimize(t: Term): void; // – → send to tray
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
  }

  private connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/term?pane=${this.id}`);
    ws.onopen = () => this.refit();
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.t === "d") this.term.write(m.d);
    };
    this.ws = ws;
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

  dispose() {
    this.ro.disconnect();
    try {
      this.ws?.close();
    } catch {}
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
