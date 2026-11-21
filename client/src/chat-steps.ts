/**
 * Pure helpers for rendering an agent's tool calls ("steps") the way the
 * Claude app's remote-control view does: a short verb + target per row, a
 * readable body per tool (a terminal block for Bash, a diff for edits, a
 * checklist for todos, the plan for ExitPlanMode) instead of a JSON dump.
 *
 * No state lives here — agent-chat.ts owns the DOM bookkeeping; chat-dock.ts
 * reuses the same previews for approval prompts so a step looks the same
 * whether it is being approved or has already run.
 *
 * Everything model-controlled goes in via textContent or renderMarkdown
 * (which escapes first — see markdown.ts). Never innerHTML raw input here.
 */
import { basename } from "./terminal";
import { renderMarkdown } from "./markdown";

export function el(tag: string, cls: string): HTMLElement {
  const n = document.createElement(tag);
  n.className = cls;
  return n;
}

export function formatToolInput(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

// The one field that says what a call actually DID. Ordered most- to
// least-specific; any provider's tools work here (codex-driver.js maps its
// own items onto the same `{name,input}` shape).
const TOOL_DETAIL_KEYS = ["command", "file_path", "path", "pattern", "url", "query", "prompt"];
export function toolDetail(input: unknown): string {
  if (typeof input === "string") return input;
  if (!input || typeof input !== "object") return "";
  const rec = input as Record<string, unknown>;
  for (const key of TOOL_DETAIL_KEYS) {
    const v = rec[key];
    if (typeof v === "string" && v.trim()) return v.trim().replace(/\s+/g, " ");
  }
  return "";
}

function rec(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" ? (input as Record<string, unknown>) : {};
}
function str(input: unknown, k: string): string {
  const v = rec(input)[k];
  return typeof v === "string" ? v.trim() : "";
}
function filePath(input: unknown): string {
  return str(input, "file_path") || str(input, "path") || str(input, "notebook_path");
}

/**
 * "Read agent-chat.ts", "Bash npm run build", "Search TODO". File targets are
 * shortened to the basename — the full path stays in the tooltip and the
 * expanded body. Unknown tools fall back to name + toolDetail.
 */
export function toolLabel(name: string, input: unknown): { verb: string; target: string } {
  switch (name) {
    case "Read":
      return { verb: "Read", target: basename(filePath(input)) };
    case "Write":
      return { verb: "Write", target: basename(filePath(input)) };
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit": {
      const paths = rec(input).paths;
      if (Array.isArray(paths) && paths.length)
        return { verb: "Edit", target: paths.filter((p) => typeof p === "string").map((p) => basename(p)).join(", ") };
      return { verb: "Edit", target: basename(filePath(input)) };
    }
    case "Bash":
      return { verb: "Bash", target: toolDetail(input) };
    case "Grep":
      return { verb: "Search", target: str(input, "pattern") };
    case "Glob":
      return { verb: "Find", target: str(input, "pattern") };
    case "WebFetch": {
      const u = str(input, "url");
      try {
        return { verb: "Fetch", target: u ? new URL(u).host : "" };
      } catch {
        return { verb: "Fetch", target: u };
      }
    }
    case "WebSearch":
      return { verb: "Web search", target: str(input, "query") };
    case "Task":
    case "Agent":
      return { verb: "Agent", target: str(input, "description") || str(input, "subagent_type") };
    case "TodoWrite":
      return { verb: "Update todos", target: "" };
    case "ExitPlanMode":
      return { verb: "Plan", target: "" };
    case "tool result":
      return { verb: "Tool", target: "" };
  }
  // MCP tools arrive as mcp__<server>__<tool>; the tool half is the readable part.
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp) return { verb: mcp[2].replace(/_/g, " "), target: mcp[1].replace(/^claude_ai_/, "").replace(/_/g, " ") };
  return { verb: name, target: toolDetail(input) };
}

export type Todo = { content: string; status: string; activeForm?: string };
export function todosOf(input: unknown): Todo[] | null {
  const list = rec(input).todos;
  if (!Array.isArray(list)) return null;
  return list.filter((t): t is Todo => !!t && typeof (t as Todo).content === "string");
}

export function renderTodos(todos: Todo[]): HTMLElement {
  const list = el("ul", "todo-list");
  for (const t of todos) {
    const li = el("li", `todo ${t.status}`);
    const box = el("span", "todo-box");
    const txt = el("span", "todo-text");
    txt.textContent = t.status === "in_progress" && t.activeForm ? t.activeForm : t.content;
    li.append(box, txt);
    list.append(li);
  }
  return list;
}

/** `+N −M` for a diff, ignoring `+++`/`---` file headers. */
export function diffStat(diff: string): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) add++;
    else if (line.startsWith("-") && !line.startsWith("---")) del++;
  }
  return { add, del };
}

const CONTEXT = 2; // unchanged lines kept around a hunk
const MAX_DIFF_LINES = 400;

/** One old→new replacement as diff lines: shared head/tail trimmed to a little context. */
function hunk(oldText: string, newText: string): string[] {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const out: string[] = [];
  for (const l of a.slice(Math.max(0, p - CONTEXT), p)) out.push(" " + l);
  for (const l of a.slice(p, a.length - s)) out.push("-" + l);
  for (const l of b.slice(p, b.length - s)) out.push("+" + l);
  for (const l of a.slice(a.length - s, a.length - s + CONTEXT)) out.push(" " + l);
  return out;
}

/**
 * A diff built from an edit tool's INPUT, so the change is visible the moment
 * the step appears (and inside an approval prompt, before it runs) — the
 * Claude driver sends no diff of its own. Null for tools that aren't edits.
 */
export function inputDiff(name: string, input: unknown): string | null {
  const r = rec(input);
  let lines: string[] | null = null;
  if (name === "Edit" && typeof r.old_string === "string" && typeof r.new_string === "string") {
    lines = hunk(r.old_string, r.new_string);
  } else if (name === "MultiEdit" && Array.isArray(r.edits)) {
    lines = [];
    for (const e of r.edits as { old_string?: unknown; new_string?: unknown }[]) {
      if (typeof e?.old_string !== "string" || typeof e?.new_string !== "string") continue;
      if (lines.length) lines.push("…");
      lines.push(...hunk(e.old_string, e.new_string));
    }
  } else if (name === "Write" && typeof r.content === "string") {
    lines = r.content.split("\n").map((l) => "+" + l);
  } else if (name === "NotebookEdit" && typeof r.new_source === "string") {
    lines = r.new_source.split("\n").map((l) => "+" + l);
  }
  if (!lines || !lines.length) return null;
  if (lines.length > MAX_DIFF_LINES) {
    const more = lines.length - MAX_DIFF_LINES;
    lines = lines.slice(0, MAX_DIFF_LINES);
    lines.push(`… ${more} more line${more === 1 ? "" : "s"}`);
  }
  return lines.join("\n");
}

/** A diff as a coloured block, with an optional file-name header. */
export function renderDiff(diff: string, file?: string): HTMLElement {
  const wrap = el("div", "diff-block");
  if (file) {
    const head = el("div", "diff-file");
    // Shorten from the FRONT (keep the file name): "…/src/greet.js".
    const parts = file.split("/").filter(Boolean);
    head.textContent = parts.length > 3 ? "…/" + parts.slice(-3).join("/") : file;
    head.title = file;
    wrap.append(head);
  }
  const pre = el("pre", "tool-diff");
  for (const [i, line] of diff.split("\n").entries()) {
    if (i) pre.append("\n");
    const span = document.createElement("span");
    span.className = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx";
    span.textContent = line;
    pre.append(span);
  }
  wrap.append(pre);
  return wrap;
}

/** Command output often carries colour codes; a <pre> would show them as junk. */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
}

/** A terminal-style block: `$ command`, then (later) its output. */
export function renderCommand(command: string, description?: string): HTMLElement {
  const pre = el("pre", "term-block");
  if (description) {
    const d = el("span", "term-desc");
    d.textContent = "# " + description + "\n";
    pre.append(d);
  }
  const p = el("span", "term-prompt");
  p.textContent = "$ ";
  pre.append(p, command);
  return pre;
}

export function renderPlan(plan: string): HTMLElement {
  const box = el("div", "plan-body msg assistant");
  box.innerHTML = renderMarkdown(plan);
  return box;
}

/**
 * The best human preview of a call's input — shared by the step body and the
 * approval dock. Falls back to pretty JSON for tools we don't know.
 */
export function inputPreview(name: string, input: unknown, opts: { quiet?: boolean } = {}): HTMLElement | null {
  if (name === "Bash") {
    const cmd = str(input, "command");
    // `quiet`: the approval dock already states the description as its question.
    if (cmd) return renderCommand(cmd, opts.quiet ? undefined : str(input, "description") || undefined);
  }
  if (name === "Task" || name === "Agent") {
    // What the subagent was asked to do, as prose — not its JSON envelope.
    const prompt = str(input, "prompt");
    if (prompt) {
      const box = el("div", "agent-prompt");
      box.textContent = prompt;
      return box;
    }
  }
  if (name === "ExitPlanMode") {
    const plan = str(input, "plan");
    if (plan) return renderPlan(plan);
  }
  const todos = name === "TodoWrite" ? todosOf(input) : null;
  if (todos) return renderTodos(todos);
  const diff = inputDiff(name, input);
  if (diff) return renderDiff(diff, filePath(input) || undefined);
  if ((name === "Read" || name === "Glob" || name === "Grep" || name === "WebFetch" || name === "WebSearch") && input) {
    // One-liners: the label already says it; show the full arguments compactly.
    const r = rec(input);
    const pre = el("pre", "tool-input kv");
    pre.textContent = Object.entries(r)
      .filter(([, v]) => v !== undefined && v !== "" && v !== false)
      .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join("\n");
    return pre;
  }
  const text = formatToolInput(input);
  if (!text) return null;
  const pre = el("pre", "tool-input");
  pre.textContent = text;
  return pre;
}

/** "8s", "1m 12s", "1h 3m". */
export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Non-empty line count — for "120 lines" / "8 results" stats. */
export function lineCount(s: string): number {
  return s.split("\n").filter((l) => l.trim()).length;
}
