/**
 * Files waiting in the composer as thumbnails (moved out of agent-chat.ts
 * unchanged). On send, agent-chat.ts appends their paths to the message, one
 * per line — the same text protocol the driver always had, so Claude reads them
 * with its Read tool, images included.
 */
import { el } from "./chat-steps";
import { basename } from "./terminal";
import { mediaSrc } from "./markdown";
import { uploadFiles } from "./attach";

type Attachment = { path: string; name: string; uploading?: boolean };

export class AttachmentTray {
  readonly el: HTMLElement;
  private items: Attachment[] = [];

  constructor(private paneId: string, private onChange: () => void) {
    this.el = el("div", "attach-row");
    this.el.hidden = true;
  }

  get count() {
    return this.items.length;
  }
  get uploading() {
    return this.items.some((a) => a.uploading);
  }
  paths(): string[] {
    return this.items.map((a) => a.path);
  }
  clear() {
    this.items = [];
    this.render();
  }

  /** Upload, then hold each file as a chip (a placeholder shows while it uploads). */
  async add(files: File[]) {
    if (!files.length) return;
    const placeholders: Attachment[] = files.map((f) => ({ path: "", name: f.name || "image", uploading: true }));
    this.items.push(...placeholders);
    this.render();
    const paths = await uploadFiles(this.paneId, files);
    this.items = this.items.filter((a) => !placeholders.includes(a));
    for (const path of paths) this.items.push({ path, name: basename(path) });
    this.render();
  }

  private render() {
    this.el.textContent = "";
    this.el.hidden = !this.items.length;
    for (const a of this.items) {
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
          this.items = this.items.filter((b) => b !== a);
          this.render();
        });
        chip.append(x);
      }
      this.el.append(chip);
    }
    this.onChange();
  }
}
