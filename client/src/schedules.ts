/**
 * Scheduled sessions (server/scheduler.js): saved prompts that start a fresh
 * chat session on given days at a given time — "every weekday at 7:00, check
 * CI and summarise overnight changes". The result arrives as a "finished"
 * notification with its summary, and on the inbox's Finished list.
 *
 * Opened from Settings → Workspace → Scheduled sessions. Reuses the inbox's
 * drawer/sheet + card styles. All text via textContent.
 */
import { el } from "./chat-steps";

type Job = {
  id: string;
  name: string;
  cwd: string;
  cmd: string;
  prompt: string;
  days: number[];
  time: string;
  enabled: boolean;
  worktree?: boolean;
  lastRunAt: number;
  lastPane: string | null;
  lastError: string | null;
  nextRunAt: number | null;
};
export type ScheduleDeps = {
  openPane: (id: string) => boolean;
  recents: () => Promise<string[]>;
  agents: () => { value: string; label: string }[];
};

const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_FULL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
let deps: ScheduleDeps;
let panel: HTMLElement | null = null;
let body: HTMLElement;
let titleEl: HTMLElement;

export function initSchedules(d: ScheduleDeps) {
  deps = d;
}

export function openSchedules() {
  if (!panel) build();
  panel!.hidden = false;
  void showList();
}

function close() {
  if (panel) panel.hidden = true;
}

function build() {
  panel = el("div", "inbox schedules");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Scheduled sessions");
  panel.hidden = true;
  const head = el("div", "inbox-head");
  titleEl = el("span", "inbox-title");
  titleEl.textContent = "Scheduled";
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

/** "Weekdays at 7:00" / "Every day at 18:30" / "Mon, Wed at 9:00" */
function describe(j: Pick<Job, "days" | "time">) {
  const d = [...j.days].sort().join(",");
  const days = d === "0,1,2,3,4,5,6" ? "Every day" : d === "1,2,3,4,5" ? "Weekdays" : d === "0,6" ? "Weekends" : j.days.map((x) => DAY[x]).join(", ");
  const [h, m] = j.time.split(":").map(Number);
  const t = new Date();
  t.setHours(h || 0, m || 0, 0, 0);
  return `${days} at ${t.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

function when(t: number) {
  const d = new Date(t);
  const today = new Date();
  const tomorrow = new Date();
  tomorrow.setDate(today.getDate() + 1);
  const hm = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === today.toDateString()) return `today ${hm}`;
  if (d.toDateString() === tomorrow.toDateString()) return `tomorrow ${hm}`;
  return `${DAY[d.getDay()]} ${hm}`;
}

async function api(method: string, path: string, data?: unknown) {
  const res = await fetch(path, {
    method,
    headers: data ? { "content-type": "application/json" } : undefined,
    body: data ? JSON.stringify(data) : undefined,
  });
  if (res.status === 404 && path === "/api/schedules") throw new Error("Scheduled sessions need a server restart to work.");
  const j = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((j as { error?: string }).error || `Request failed (${res.status})`);
  return j;
}

async function showList() {
  titleEl.textContent = "Scheduled";
  body.textContent = "";
  let jobs: Job[] = [];
  try {
    jobs = ((await api("GET", "/api/schedules")) as { jobs: Job[] }).jobs;
  } catch (e) {
    const n = el("div", "inbox-empty");
    n.textContent = (e as Error).message;
    body.append(n);
    return;
  }
  const intro = el("div", "sched-intro");
  intro.textContent =
    "A scheduled session starts on its own at the time you pick and runs your prompt. When it's done you get a notification saying what it did. Times are this machine's local time.";
  body.append(intro, btn("New schedule", "primary sched-new", () => void showForm(null)));
  if (!jobs.length) return;
  const sec = el("div", "inbox-sec");
  const h = el("div", "inbox-sec-h");
  h.textContent = `Schedules · ${jobs.length}`;
  sec.append(h);
  for (const j of jobs) sec.append(card(j));
  body.append(sec);
}

function card(j: Job) {
  const c = el("div", `inbox-card sched-card${j.enabled ? "" : " paused"}`);
  const head = el("div", "ic-head");
  const who = el("span", "ic-who");
  const name = el("span", "ic-name");
  name.textContent = j.name;
  const where = el("span", "ic-where");
  where.textContent = `${describe(j)} · ${j.cwd.split("/").filter(Boolean).slice(-2).join("/")}${j.worktree ? " · own branch" : ""}`;
  where.title = j.cwd;
  who.append(name, where);
  head.append(who);
  c.append(head);
  const status = el("div", "ic-snippet");
  status.textContent = !j.enabled ? "Paused" : j.nextRunAt ? `Next run ${when(j.nextRunAt)}` : "Not scheduled";
  c.append(status);
  const p = el("div", "sched-prompt");
  p.textContent = j.prompt;
  c.append(p);
  if (j.lastError) {
    const e = el("div", "inbox-err");
    e.textContent = `Last run failed: ${j.lastError}`;
    c.append(e);
  } else if (j.lastRunAt) {
    const last = el("div", "ic-where sched-last");
    last.textContent = `Last ran ${when(j.lastRunAt)}`;
    c.append(last);
  }
  const acts = el("div", "ic-actions");
  if (j.lastPane && !j.lastError)
    acts.append(
      btn("Open last run", "", () => {
        if (deps.openPane(j.lastPane!)) close();
        else alert("That run's session has been closed.");
      })
    );
  acts.append(
    btn("Run now", "", async () => {
      try {
        const r = (await api("POST", `/api/schedules/${j.id}/run`)) as Job;
        if (r.lastError) alert(`Couldn't start it: ${r.lastError}`);
        await showList();
      } catch (e) {
        alert((e as Error).message);
      }
    }),
    btn(j.enabled ? "Pause" : "Resume", "", async () => {
      await api("POST", `/api/schedules/${j.id}/enabled`, { on: !j.enabled }).catch((e) => alert(e.message));
      await showList();
    }),
    btn("Edit", "", () => void showForm(j)),
    btn("Delete", "danger", async () => {
      if (!confirm(`Delete the schedule "${j.name}"? Sessions it already started stay open.`)) return;
      await api("DELETE", `/api/schedules/${j.id}`).catch((e) => alert(e.message));
      await showList();
    })
  );
  c.append(acts);
  return c;
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

async function showForm(j: Job | null) {
  titleEl.textContent = j ? "Edit schedule" : "New schedule";
  body.textContent = "";
  const form = el("div", "inbox-card sched-form");

  const name = document.createElement("input");
  name.type = "text";
  name.placeholder = "Morning CI check";
  name.value = j?.name || "";

  // Folder: recent folders, or type any path.
  const folder = document.createElement("input");
  folder.type = "text";
  folder.placeholder = "~/software/my-app";
  folder.value = j?.cwd || "";
  folder.setAttribute("list", "sched-recents");
  folder.autocapitalize = "off";
  folder.spellcheck = false;
  const dl = document.createElement("datalist");
  dl.id = "sched-recents";
  const recents = await deps.recents().catch(() => [] as string[]);
  for (const r of recents.slice(0, 12)) {
    const o = document.createElement("option");
    o.value = r;
    dl.append(o);
  }
  if (!folder.value && recents[0]) folder.value = recents[0];

  const agent = document.createElement("select");
  for (const a of deps.agents()) {
    const o = document.createElement("option");
    o.value = a.value;
    o.textContent = a.label;
    agent.append(o);
  }
  if (j?.cmd) agent.value = j.cmd;

  const prompt = document.createElement("textarea");
  prompt.rows = 4;
  prompt.placeholder = "Check CI on main and summarise what changed overnight. Tell me if anything needs my attention.";
  prompt.value = j?.prompt || "";

  // Days: seven toggles + shortcuts.
  let days = new Set<number>(j?.days || [1, 2, 3, 4, 5]);
  const dayRow = el("div", "sched-days");
  const dayBtns: HTMLButtonElement[] = [];
  const syncDays = () =>
    dayBtns.forEach((b, i) => {
      b.classList.toggle("on", days.has(i));
      b.setAttribute("aria-pressed", String(days.has(i)));
    });
  for (const i of [1, 2, 3, 4, 5, 6, 0]) {
    const b = el("button", "sched-day") as HTMLButtonElement;
    b.type = "button";
    b.textContent = DAY[i].slice(0, 2);
    b.setAttribute("aria-label", DAY_FULL[i]);
    b.setAttribute("aria-pressed", "false");
    b.addEventListener("click", () => {
      days.has(i) ? days.delete(i) : days.add(i);
      syncDays();
    });
    dayBtns[i] = b;
    dayRow.append(b);
  }
  const presets = el("div", "sched-presets");
  presets.append(
    btn("Weekdays", "ghost", () => ((days = new Set([1, 2, 3, 4, 5])), syncDays())),
    btn("Every day", "ghost", () => ((days = new Set([0, 1, 2, 3, 4, 5, 6])), syncDays()))
  );
  syncDays();

  const time = document.createElement("input");
  time.type = "time";
  time.value = j?.time || "07:00";

  // Own branch: each run in its own git worktree (server/worktrees.js).
  const own = document.createElement("input");
  own.type = "checkbox";
  own.checked = !!j?.worktree;
  const ownRow = el("label", "sched-check");
  const ownText = el("span", "");
  ownText.textContent = "Run on its own branch";
  ownRow.append(own, ownText);

  const err = el("div", "inbox-err");
  err.hidden = true;
  const acts = el("div", "ic-actions");
  const save = btn(j ? "Save" : "Create schedule", "primary", async () => {
    err.hidden = true;
    save.disabled = true;
    try {
      await api("POST", "/api/schedules", {
        id: j?.id,
        name: name.value,
        cwd: folder.value,
        cmd: agent.value,
        prompt: prompt.value,
        days: [...days],
        time: time.value,
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

  for (const x of [name, folder, prompt]) x.addEventListener("keydown", (e) => e.stopPropagation());
  // A fixed field shouldn't keep shouting its old error.
  form.addEventListener("input", () => (err.hidden = true));
  form.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest(".sched-day, .sched-presets")) err.hidden = true;
  });
  form.append(
    field("Name", name),
    field("Folder", folder, "Where the session runs (on this machine)."),
    dl,
    field("Agent", agent),
    field("Prompt", prompt, "What it should do each time. It starts fresh every run."),
    field("Days", dayRow),
    presets,
    field("Time", time, "This machine's local time."),
    ownRow,
    (() => {
      const h = el("span", "sched-hint");
      h.textContent =
        "Each run works on a new branch in its own folder, so it never touches the checkout you're working in. A run that changed nothing is cleaned up by the next one; anything it did is kept. Needs a git repo.";
      return h;
    })(),
    err,
    acts
  );
  body.append(form);
  name.focus();
}
