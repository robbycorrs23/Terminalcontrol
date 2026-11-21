/**
 * The background-task tray (moved out of agent-chat.ts unchanged): subagents
 * and background shells, each with its own ■ — the turn's Stop leaves them
 * running (perTaskStopAffordance in the driver). Finished ones linger a moment
 * so you see how they ended, then go. Only backgrounded work is listed; a
 * foreground subagent is already visible as its Agent step.
 */
import type { AgentTask } from "./agent-events";
import { el, fmtDuration } from "./chat-steps";
import { setIcon } from "./icons";

export const isLiveTask = (t: AgentTask) => t.status === "running" || t.status === "pending" || t.status === "paused";

export class TaskTray {
  readonly el: HTMLElement;
  private tasks = new Map<string, AgentTask>();

  constructor(private onStop: (id: string) => void) {
    this.el = el("div", "task-tray");
    this.el.hidden = true;
  }

  /** Record a task update and redraw. */
  update(task: AgentTask) {
    this.tasks.set(task.id, task);
    if (!isLiveTask(task))
      setTimeout(() => {
        if (this.tasks.get(task.id) === task) {
          this.tasks.delete(task.id);
          this.render();
        }
      }, 5000);
    this.render();
  }

  clear() {
    this.tasks.clear();
    this.render();
  }

  private render() {
    this.el.textContent = "";
    // Only backgrounded work belongs here; a foreground subagent is already
    // visible as its Agent step and stops with the turn.
    const list = [...this.tasks.values()].filter((t) => t.backgrounded);
    this.el.hidden = !list.length;
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
          this.onStop(t.id);
        });
        row.append(stop);
      }
      this.el.append(row);
    }
  }
}
