/**
 * Prompt templates (server/templates.js): saved first messages with optional
 * folder / agent / view / own-branch defaults.
 *
 *  - listTemplates() / saveTemplate(): used by the new-session sheet (chips that
 *    fill the form + "Save as template") and the chat composer's + → Templates.
 *  - openTemplates(): the Settings → Prompt templates sheet to create, edit and
 *    delete them. Reuses the inbox drawer + card styles, like schedules.ts.
 * All text via textContent.
 */
import { el } from "./chat-steps";

export type Template = {
  id: string;
  name: string;
  prompt: string;
  cwd: string;
  cmd: string;
  kind: "" | "agent" | "pty";
  worktree: boolean;
};

export async function listTemplates(): Promise<Template[]> {
  const res = await fetch("/api/templates", { cache: "no-store" });
  if (!res.ok) return []; // an older server: no templates, nothing breaks
  return ((await res.json()) as { templates: Template[] }).templates || [];
}

export async function saveTemplate(t: Partial<Template> & { name: string; prompt: string }): Promise<Template> {
  const res = await fetch("/api/templates", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(t),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((j as { error?: string }).error || (res.status === 404 ? "Templates need a server restart to work." : "Couldn't save it."));
  return j as Template;
}

// ---- The manage sheet ------------------------------------------------------------

export type TemplatesDeps = {
  recents: () => Promise<string[]>;
  agents: () => { value: string; label: string; chat: boolean }[];
};
let deps: TemplatesDeps;
let panel: HTMLElement | null = null;
let body: HTMLElement;
let titleEl: HTMLElement;

export function initTemplates(d: TemplatesDeps) {
  deps = d;
}

export function openTemplates() {
  if (!panel) build();
  panel!.hidden = false;
  void showList();
}

function close() {
  if (panel) panel.hidden = true;
}

function build() {
  panel = el("div", "inbox templates");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Prompt templates");
  panel.hidden = true;
  const head = el("div", "inbox-head");
  titleEl = el("span", "inbox-title");
  const done = el("button", "inbox-done") as HTMLButtonElement;
  done.textContent = "Done";
  done.addEventListener("click", close);
  head.append(titleEl, done);
  body = el("div", "inbox-list");
  panel.append(head, body);
  panel.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  });
  document.body.append(panel);
}

function btn(label: string, cls: string, on: () => void) {
  const b = el("button", `ib ${cls}`) as HTMLButtonElement;
  b.textContent = label;
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    on();
  });
  return b;
}

const shortPath = (p: string) => p.split("/").filter(Boolean).slice(-2).join("/");

/** "claude · chat · software/app · own branch" — only what the template pins. */
export function templateFacts(t: Template, agentLabel?: (v: string) => string): string {
  return [
    t.cmd ? (agentLabel?.(t.cmd) ?? t.cmd) : "",
    t.kind === "pty" ? "terminal" : t.kind === "agent" ? "chat" : "",
    t.cwd ? shortPath(t.cwd) : "",
    t.worktree ? "own branch" : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

async function showList() {
  titleEl.textContent = "Prompt templates";
  body.textContent = "";
  const intro = el("div", "sched-intro");
  intro.textContent =
    "Saved prompts for things you start often. Pick one in New session to fill it in (folder, agent and branch too, if you set them), or insert one into any chat from + → Templates.";
  body.append(intro, btn("New template", "primary sched-new", () => void showForm(null)));
  const items = await listTemplates().catch(() => [] as Template[]);
  if (!items.length) return;
  const sec = el("div", "inbox-sec");
  const h = el("div", "inbox-sec-h");
  h.textContent = `Templates · ${items.length}`;
  sec.append(h);
  const label = (v: string) => deps.agents().find((a) => a.value === v)?.label || v;
  for (const t of items) {
    const c = el("div", "inbox-card sched-card");
    const name = el("div", "ic-name");
    name.textContent = t.name;
    const facts = el("div", "ic-where");
    facts.textContent = templateFacts(t, label) || "Any folder · any agent";
    const p = el("div", "sched-prompt");
    p.textContent = t.prompt;
    const acts = el("div", "ic-actions");
    acts.append(
      btn("Edit", "", () => void showForm(t)),
      btn("Delete", "danger", async () => {
        if (!confirm(`Delete the template "${t.name}"?`)) return;
        await fetch(`/api/templates/${t.id}`, { method: "DELETE" });
        await showList();
      })
    );
    c.append(name, facts, p, acts);
    sec.append(c);
  }
  body.append(sec);
}

function field(label: string, control: HTMLElement, hint?: string) {
  const w = el("label", "sched-field");
  const l = el("span", "sched-label");
  l.textContent = label;
  w.append(l, control);
  if (hint) {
    const h = el("span", "sched-hint");
    h.textContent = hint;
    w.append(h);
  }
  return w;
}

function select(options: [string, string][], value: string) {
  const s = document.createElement("select");
  for (const [v, t] of options) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = t;
    s.append(o);
  }
  s.value = value;
  return s;
}

/** The edit form — also used by the new-session sheet's "Save as template" (prefilled, no id). */
export async function showForm(t: Partial<Template> | null) {
  if (!panel) build();
  panel!.hidden = false;
  titleEl.textContent = t?.id ? "Edit template" : "New template";
  body.textContent = "";
  const form = el("div", "inbox-card sched-form");

  const name = document.createElement("input");
  name.type = "text";
  name.placeholder = "Review the open PR";
  name.value = t?.name || "";
  const prompt = document.createElement("textarea");
  prompt.rows = 5;
  prompt.placeholder = "Review the current branch's changes for bugs and anything risky. List issues by severity.";
  prompt.value = t?.prompt || "";

  const folder = document.createElement("input");
  folder.type = "text";
  folder.placeholder = "Any folder (pick when starting)";
  folder.value = t?.cwd || "";
  folder.setAttribute("list", "tpl-recents");
  folder.autocapitalize = "off";
  folder.spellcheck = false;
  const dl = document.createElement("datalist");
  dl.id = "tpl-recents";
  for (const r of (await deps.recents().catch(() => [] as string[])).slice(0, 12)) {
    const o = document.createElement("option");
    o.value = r;
    dl.append(o);
  }
  const agent = select([["", "Any agent"], ...deps.agents().map((a): [string, string] => [a.value || "shell", a.label])], t?.cmd || "");
  const kind = select(
    [
      ["", "Either"],
      ["agent", "Chat"],
      ["pty", "Terminal (prompt not sent for you)"],
    ],
    t?.kind || ""
  );
  const own = document.createElement("input");
  own.type = "checkbox";
  own.checked = !!t?.worktree;
  const ownRow = el("label", "sched-check");
  const ownText = el("span", "");
  ownText.textContent = "Start on its own branch";
  ownRow.append(own, ownText);

  const err = el("div", "inbox-err");
  err.hidden = true;
  form.addEventListener("input", () => (err.hidden = true));
  for (const x of [name, prompt, folder]) x.addEventListener("keydown", (e) => e.stopPropagation());

  const acts = el("div", "ic-actions");
  const save = btn(t?.id ? "Save" : "Create template", "primary", async () => {
    save.disabled = true;
    try {
      await saveTemplate({
        id: t?.id,
        name: name.value,
        prompt: prompt.value,
        cwd: folder.value,
        cmd: agent.value,
        kind: kind.value as Template["kind"],
        worktree: own.checked,
      });
      await showList();
    } catch (e) {
      err.textContent = (e as Error).message;
      err.hidden = false;
      save.disabled = false;
    }
  });
  acts.append(btn("Cancel", "ghost", () => void showList()), save);
  form.append(
    field("Name", name),
    field("Prompt", prompt),
    field("Folder", folder, "Optional — leave empty to choose each time."),
    dl,
    field("Agent", agent),
    field("View", kind),
    ownRow,
    err,
    acts
  );
  body.append(form);
  (t?.prompt ? name : prompt).focus();
}
