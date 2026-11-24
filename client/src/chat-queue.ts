/**
 * Messages typed while a turn runs: shown above the composer — tap to edit,
 * "Send now" to hand it to Claude mid-turn, ✕ to drop.
 *
 * The queue itself lives on the SERVER (agent-manager.js queueAdd/queueTake),
 * persisted with the pane and sent by the server when the turn ends — so
 * closing the app (or the phone killing it) can't lose a queued message, and
 * every window shows the same queue. This class only renders what the server
 * reports (`setItems`), plus anything typed while the socket was down
 * (`pending`), which agent-chat.ts hands to the server on reconnect.
 */
import { el } from "./chat-steps";

export type QueuedItem = { id: string; text: string };
export type QueueCallbacks = {
  renderText: (into: HTMLElement, text: string) => void;
  /** Tap to edit: take it back (server) into the composer. */
  onEdit: (item: QueuedItem) => void;
  onSendNow: (item: QueuedItem) => void;
  onDrop: (item: QueuedItem) => void;
};

export class MessageQueue {
  readonly el: HTMLElement;
  private items: QueuedItem[] = [];
  /** Typed while disconnected — not on the server yet. */
  private pending: string[] = [];

  constructor(private cb: QueueCallbacks) {
    this.el = el("div", "chat-queue");
    this.el.hidden = true;
  }

  get length() {
    return this.items.length + this.pending.length;
  }

  get ids() {
    return this.items.map((i) => i.id);
  }

  /** The server's queue, as it is now. */
  setItems(items: QueuedItem[]) {
    this.items = items.filter((i) => i && typeof i.id === "string" && typeof i.text === "string");
    this.render();
  }

  addPending(text: string) {
    this.pending.push(text);
    this.render();
  }

  /** Everything typed offline, oldest first — and none is pending afterwards. */
  takePending(): string[] {
    const all = this.pending;
    this.pending = [];
    this.render();
    return all;
  }

  private render() {
    this.el.textContent = "";
    this.el.hidden = !this.length;
    const row = (text: string, label: string, acts: { edit: () => void; now?: () => void; drop: () => void }) => {
      const r = el("div", "queued");
      const l = el("span", "queued-label");
      l.textContent = label;
      const body = el("div", "queued-text");
      this.cb.renderText(body, text);
      body.title = "Edit";
      body.addEventListener("click", (e) => {
        e.stopPropagation();
        acts.edit();
      });
      r.append(l, body);
      if (acts.now) {
        const now = el("button", "queued-now") as HTMLButtonElement;
        now.textContent = "Send now";
        now.title = "Send it now — Claude picks it up mid-turn";
        now.addEventListener("click", (e) => {
          e.stopPropagation();
          acts.now!();
        });
        r.append(now);
      }
      const x = el("button", "queued-x") as HTMLButtonElement;
      x.textContent = "✕";
      x.title = "Remove";
      x.setAttribute("aria-label", "Remove queued message");
      x.addEventListener("click", (e) => {
        e.stopPropagation();
        acts.drop();
      });
      r.append(x);
      this.el.append(r);
    };
    for (const item of this.items)
      row(item.text, "Queued", {
        edit: () => this.cb.onEdit(item),
        now: () => this.cb.onSendNow(item),
        drop: () => this.cb.onDrop(item),
      });
    this.pending.forEach((text, i) => {
      const gone = () => {
        this.pending.splice(i, 1);
        this.render();
      };
      row(text, "Waiting for connection", {
        edit: () => {
          gone();
          this.cb.onEdit({ id: "", text });
        },
        drop: gone,
      });
    });
  }
}
