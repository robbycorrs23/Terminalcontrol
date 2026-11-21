/**
 * The approval prompt, docked where the composer is — the way Claude Code
 * (CLI and the app's remote-control view) asks: a preview of exactly what is
 * about to run, then a short numbered list of answers:
 *
 *   1. Yes
 *   2. Yes, and don't ask again this session   (only when the SDK offers a rule)
 *   3. No, and tell Claude what to do differently
 *
 * Option 3 opens a text box; what's typed goes back as the denial reason, so
 * the model can change course instead of just stopping (claude-driver.js).
 *
 * ExitPlanMode gets the CLI's plan-approval answers instead — approve and
 * switch to auto-accepting edits, approve and keep asking, or keep planning.
 *
 * Several prompts can be pending at once (parallel tool calls); they queue and
 * the dock shows "1 of 3". Keys 1-3 answer, Esc backs out of the feedback box.
 */
import type { AgentEvent } from "./agent-events";
import { el, inputPreview, toolLabel } from "./chat-steps";

export type PermissionEvent = Extract<AgentEvent, { t: "permission_request" }>;
export type DockAnswer = { decision: "allow" | "always" | "deny"; message?: string; mode?: string };

/**
 * The sentence the dock asks. The SDK's own title/description is used when it
 * reads like one (Bash's "Run the tests"); for file tools its description is
 * often just the file name, which as a question says nothing — so those get
 * a plain sentence built from the step's verb + target.
 */
function questionFor(ev: PermissionEvent, verb: string, target: string): string {
  if (ev.title) return ev.title;
  const d = (ev.description || "").trim();
  const meaningful = d && d !== target && !/^[\w./~-]+$/.test(d);
  if (meaningful) return d.endsWith("?") ? d : `${d}?`;
  switch (ev.tool) {
    case "Write":
      return `Write to ${target || "this file"}?`;
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return `Make this edit to ${target || "this file"}?`;
    case "Bash":
      return "Run this command?";
    case "WebFetch":
      return `Fetch ${target || "this URL"}?`;
  }
  return `Allow Claude to use ${verb}${target ? ` on ${target}` : ""}?`;
}

type Option = { label: string; answer?: DockAnswer; feedback?: true };

export class ApprovalDock {
  readonly el: HTMLElement;
  private queue: PermissionEvent[] = [];
  private feedbackFor: string | null = null; // requestId whose "No, …" box is open

  constructor(
    private isCodex: boolean,
    private onAnswer: (ev: PermissionEvent, a: DockAnswer) => void,
    private onToggle: (open: boolean) => void
  ) {
    this.el = el("div", "chat-dock");
    this.el.hidden = true;
    this.el.tabIndex = -1; // focusable, so its keys work without the composer
    this.el.addEventListener("keydown", (e) => this.onKey(e));
    // Same drag/zoom exclusion as every other control surface in the box.
    this.el.addEventListener("pointerdown", (e) => e.stopPropagation());
  }

  get open(): boolean {
    return this.queue.length > 0;
  }

  add(ev: PermissionEvent) {
    if (this.queue.some((q) => q.requestId === ev.requestId)) return;
    this.queue.push(ev);
    this.render();
  }

  /** Answered here, in another window, or by the driver — drop it either way. */
  resolve(requestId: string) {
    const before = this.queue.length;
    this.queue = this.queue.filter((q) => q.requestId !== requestId);
    if (this.feedbackFor === requestId) this.feedbackFor = null;
    if (this.queue.length !== before) this.render();
  }

  clear() {
    this.queue = [];
    this.feedbackFor = null;
    this.render();
  }

  focus() {
    if (!this.open) return;
    const box = this.el.querySelector("textarea") as HTMLTextAreaElement | null;
    (box || this.el).focus({ preventScroll: true });
  }

  private options(ev: PermissionEvent): Option[] {
    if (ev.tool === "ExitPlanMode") {
      return [
        { label: "Yes, and auto-accept edits", answer: { decision: "allow", mode: "acceptEdits" } },
        { label: "Yes, and manually approve edits", answer: { decision: "allow", mode: "default" } },
        { label: "No, keep planning", feedback: true },
      ];
    }
    const opts: Option[] = [{ label: "Yes", answer: { decision: "allow" } }];
    // Undefined (codex, older servers) means "assume yes"; only an explicit
    // false — the SDK offered no rule to persist — hides it, since "always"
    // would otherwise silently behave exactly like plain Yes.
    if (ev.canAlways !== false) opts.push({ label: "Yes, and don't ask again this session", answer: { decision: "always" } });
    // Codex can't carry a reason back, so its "No" is a plain No.
    if (this.isCodex) opts.push({ label: "No", answer: { decision: "deny" } });
    else opts.push({ label: "No, and tell Claude what to do differently", feedback: true });
    return opts;
  }

  private answer(ev: PermissionEvent, a: DockAnswer) {
    this.feedbackFor = null;
    this.el.classList.add("sending");
    this.el.querySelectorAll("button, textarea").forEach((b) => ((b as HTMLButtonElement).disabled = true));
    this.onAnswer(ev, a);
  }

  private choose(ev: PermissionEvent, o: Option) {
    if (o.feedback) {
      this.feedbackFor = ev.requestId;
      this.render();
      this.focus();
    } else if (o.answer) {
      this.answer(ev, o.answer);
    }
  }

  private onKey(e: KeyboardEvent) {
    const ev = this.queue[0];
    if (!ev) return;
    e.stopPropagation(); // keep app-level shortcuts (Esc = unzoom) out of it
    if ((e.target as HTMLElement).tagName === "TEXTAREA") {
      if (e.key === "Escape") {
        e.preventDefault();
        this.feedbackFor = null;
        this.render();
        this.focus();
      }
      return;
    }
    const n = Number(e.key);
    const opts = this.options(ev);
    if (n >= 1 && n <= opts.length) {
      e.preventDefault();
      this.choose(ev, opts[n - 1]);
    }
  }

  private render() {
    const ev = this.queue[0];
    const wasOpen = !this.el.hidden;
    this.el.textContent = "";
    this.el.classList.remove("sending");
    this.el.hidden = !ev;
    if (wasOpen !== !!ev) this.onToggle(!!ev);
    if (!ev) return;
    this.el.classList.toggle("plan", ev.tool === "ExitPlanMode");

    const head = el("div", "dock-head");
    const { verb, target } = toolLabel(ev.tool, ev.input);
    const v = el("span", "dock-verb");
    v.textContent = ev.tool === "ExitPlanMode" ? "Ready to code?" : verb;
    head.append(v);
    if (target) {
      const t = el("span", "dock-target");
      t.textContent = target;
      head.append(t);
    }
    if (this.queue.length > 1) {
      const n = el("span", "dock-count");
      n.textContent = `1 of ${this.queue.length}`;
      head.append(n);
    }
    this.el.append(head);

    const question = el("div", "dock-question");
    question.textContent = ev.tool === "ExitPlanMode" ? "Claude has written up a plan (above). Would you like to proceed?" : questionFor(ev, verb, target);
    this.el.append(question);

    // The plan itself is already in the log right above (as a full card), so
    // the dock doesn't repeat it; every other tool shows what will run.
    const preview = ev.tool === "ExitPlanMode" ? null : inputPreview(ev.tool, ev.input, { quiet: true });
    if (preview) {
      const wrap = el("div", "dock-preview");
      wrap.append(preview);
      this.el.append(wrap);
    }
    if (ev.blockedPath) {
      const note = el("div", "dock-note");
      note.textContent = `Outside the working folder: ${ev.blockedPath}`;
      this.el.append(note);
    }

    const list = el("div", "dock-opts");
    this.options(ev).forEach((o, i) => {
      const b = el("button", "dock-opt") as HTMLButtonElement;
      if (o.feedback && this.feedbackFor === ev.requestId) b.classList.add("selected");
      const k = el("kbd", "dock-key");
      k.textContent = String(i + 1);
      const l = el("span", "dock-label");
      l.textContent = o.label;
      b.append(k, l);
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        this.choose(ev, o);
      });
      list.append(b);
    });
    this.el.append(list);

    if (this.feedbackFor === ev.requestId) {
      const row = el("div", "dock-feedback");
      const box = document.createElement("textarea");
      box.rows = 2;
      box.placeholder =
        ev.tool === "ExitPlanMode" ? "What should Claude change about the plan?" : "Tell Claude what to do instead…";
      const send = el("button", "dock-send") as HTMLButtonElement;
      send.textContent = "Send";
      const submit = () => this.answer(ev, { decision: "deny", message: box.value.trim() || undefined });
      box.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          e.stopPropagation();
          submit();
        }
      });
      box.addEventListener("click", (e) => e.stopPropagation());
      send.addEventListener("click", (e) => {
        e.stopPropagation();
        submit();
      });
      row.append(box, send);
      this.el.append(row);
    }
  }
}
