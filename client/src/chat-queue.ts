/**
 * Messages typed while a turn runs (moved out of agent-chat.ts unchanged):
 * shown above the composer — tap to edit, "Send now" to hand it to Claude
 * mid-turn, ✕ to drop. agent-chat.ts takes them all when the turn ends.
 */
import { el } from "./chat-steps";

export type QueueCallbacks = {
  renderText: (into: HTMLElement, text: string) => void;
  onEdit: (text: string) => void;
  onSendNow: (text: string) => void;
};

export class MessageQueue {
  readonly el: HTMLElement;
  private items: string[] = [];

  constructor(private cb: QueueCallbacks) {
    this.el = el("div", "chat-queue");
    this.el.hidden = true;
  }

  get length() {
    return this.items.length;
  }

  push(text: string) {
    this.items.push(text);
    this.render();
  }

  /** Everything queued, oldest first — and the queue is empty afterwards. */
  takeAll(): string[] {
    const all = this.items;
    this.items = [];
    this.render();
    return all;
  }

  private render() {
    this.el.textContent = "";
    this.el.hidden = !this.items.length;
    this.items.forEach((text, i) => {
      const row = el("div", "queued");
      const label = el("span", "queued-label");
      label.textContent = "Queued";
      const body = el("div", "queued-text");
      this.cb.renderText(body, text);
      body.title = "Edit";
      body.addEventListener("click", (e) => {
        // Tap to edit: back into the composer.
        e.stopPropagation();
        this.items.splice(i, 1);
        this.render();
        this.cb.onEdit(text);
      });
      const now = el("button", "queued-now") as HTMLButtonElement;
      now.textContent = "Send now";
      now.title = "Send it now — Claude picks it up mid-turn";
      now.addEventListener("click", (e) => {
        e.stopPropagation();
        this.items.splice(i, 1);
        this.render();
        this.cb.onSendNow(text);
      });
      const x = el("button", "queued-x") as HTMLButtonElement;
      x.textContent = "✕";
      x.title = "Remove";
      x.setAttribute("aria-label", "Remove queued message");
      x.addEventListener("click", (e) => {
        e.stopPropagation();
        this.items.splice(i, 1);
        this.render();
      });
      row.append(label, body, now, x);
      this.el.append(row);
    });
  }
}
