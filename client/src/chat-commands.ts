/**
 * The composer's "/" menu: type "/" and the session's slash commands (skills,
 * /compact, /review, project commands, …) pop up above the input, filtered as
 * you type — the same affordance the CLI and the Claude app give you.
 *
 * The list comes from the SDK (claude-driver.js → `commands` event), already
 * stripped of terminal-only commands. Picking one inserts "/name " for you to
 * finish; the SDK runs slash commands sent as ordinary prompt text.
 */
import type { SlashCommand } from "./agent-events";
import { el } from "./chat-steps";

const MAX_ROWS = 8;

export class CommandMenu {
  readonly el: HTMLElement;
  private commands: SlashCommand[] = [];
  private matches: SlashCommand[] = [];
  private active = 0;

  constructor(private input: HTMLTextAreaElement, private onPick: () => void) {
    this.el = el("div", "cmd-menu");
    this.el.hidden = true;
    this.el.setAttribute("role", "listbox");
    // mousedown, not click: keep focus in the textarea while picking.
    this.el.addEventListener("mousedown", (e) => e.preventDefault());
  }

  setCommands(list: SlashCommand[]) {
    const seen = new Set<string>();
    this.commands = list.filter((c) => !seen.has(c.name) && seen.add(c.name));
    this.update();
  }

  get open(): boolean {
    return !this.el.hidden;
  }

  /** Re-filter against the input. Only a leading "/word" with no space yet opens it. */
  update() {
    const m = /^\/(\S*)$/.exec(this.input.value);
    if (!m || !this.commands.length) return this.close();
    const q = m[1].toLowerCase();
    const starts = this.commands.filter((c) => c.name.toLowerCase().startsWith(q));
    const contains = this.commands.filter((c) => !c.name.toLowerCase().startsWith(q) && c.name.toLowerCase().includes(q));
    this.matches = [...starts, ...contains].slice(0, MAX_ROWS);
    if (!this.matches.length) return this.close();
    this.active = Math.min(this.active, this.matches.length - 1);
    this.render();
    this.el.hidden = false;
  }

  close() {
    this.el.hidden = true;
    this.active = 0;
  }

  /** Arrow/Enter/Tab/Esc while open. Returns true when the key was consumed. */
  handleKey(e: KeyboardEvent): boolean {
    if (!this.open) return false;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const d = e.key === "ArrowDown" ? 1 : -1;
      this.active = (this.active + d + this.matches.length) % this.matches.length;
      this.render();
      return true;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      this.pick(this.matches[this.active]);
      return true;
    }
    if (e.key === "Escape") {
      this.close();
      return true;
    }
    return false;
  }

  private pick(c: SlashCommand | undefined) {
    if (!c) return;
    this.input.value = `/${c.name} `;
    this.close();
    this.onPick();
  }

  private render() {
    this.el.textContent = "";
    this.matches.forEach((c, i) => {
      const row = el("div", "cmd-row" + (i === this.active ? " active" : ""));
      row.setAttribute("role", "option");
      const name = el("span", "cmd-name");
      name.textContent = "/" + c.name;
      row.append(name);
      if (c.argumentHint) {
        const hint = el("span", "cmd-hint");
        hint.textContent = c.argumentHint;
        row.append(hint);
      }
      if (c.description) {
        const d = el("span", "cmd-desc");
        d.textContent = c.description;
        row.append(d);
      }
      row.addEventListener("click", (e) => {
        e.stopPropagation();
        this.pick(c);
      });
      row.addEventListener("mouseenter", () => {
        this.active = i;
        this.el.querySelectorAll(".cmd-row").forEach((r, j) => r.classList.toggle("active", j === i));
      });
      this.el.append(row);
    });
    (this.el.children[this.active] as HTMLElement | undefined)?.scrollIntoView({ block: "nearest" });
  }
}
