/**
 * The phone's "new session" sheet — what "+" opens on a phone instead of the
 * desktop folder browser. Three choices and a message, like starting a
 * conversation in the Claude app:
 *
 *   Folder   — your recent folders, one tap (or "Browse…" for the full picker)
 *   Agent    — the accounts this machine offers, or a plain shell
 *   View     — Chat or Terminal (remembered between uses)
 *   Branch   — "Own branch": a new git branch in its own worktree, so this
 *              session can't trample another one on the same repo (only
 *              offered when the folder is a git repo; remembered)
 *   Message  — optional; a chat session starts working on it immediately
 *
 * main.ts supplies the data and the actions; this module only builds the UI.
 * All text goes in via textContent.
 */

export type NewSessionDeps = {
  recents: () => Promise<string[]>;
  agents: { value: string; label: string; chat: boolean }[];
  browse: () => void;
  gitInfo: (path: string) => Promise<{ repo?: boolean; root?: string; branch?: string; worktree?: boolean } | null>;
  /** true = created; a string = the server's reason it couldn't be. */
  create: (o: { cwd: string; agent: string; kind: "agent" | "pty"; prompt: string; worktree: boolean }) => Promise<boolean | string>;
};

const KIND_KEY = "fleet-new-kind";
const AGENT_KEY = "fleet-new-agent";
const BRANCH_KEY = "fleet-new-own-branch";

function el(tag: string, cls: string, text?: string): HTMLElement {
  const n = document.createElement(tag);
  n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

let sheet: HTMLElement | null = null;

export function closeNewSession() {
  if (sheet) sheet.hidden = true;
}

export async function openNewSession(deps: NewSessionDeps) {
  if (!sheet) {
    sheet = el("div", "ns-sheet");
    sheet.id = "newSession";
    sheet.addEventListener("click", (e) => {
      if (e.target === sheet) closeNewSession();
    });
    document.body.append(sheet);
  }
  const root = sheet;
  root.textContent = "";
  const panel = el("div", "ns-panel");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "New session");

  // State
  let cwd = "";
  let agent = localStorage.getItem(AGENT_KEY) || deps.agents[0]?.value || "";
  if (!deps.agents.some((a) => a.value === agent)) agent = deps.agents[0]?.value || "";
  let kind: "agent" | "pty" = localStorage.getItem(KIND_KEY) === "pty" ? "pty" : "agent";
  let ownBranch = localStorage.getItem(BRANCH_KEY) === "1";
  let repo: { root: string; branch: string } | null = null; // the chosen folder's git facts, if a repo

  // Header
  const head = el("div", "ns-head");
  const cancel = el("button", "ns-cancel", "Cancel") as HTMLButtonElement;
  cancel.addEventListener("click", closeNewSession);
  const title = el("span", "ns-title", "New session");
  const start = el("button", "ns-start", "Start") as HTMLButtonElement;
  head.append(cancel, title, start);
  panel.append(head);

  const body = el("div", "ns-body");
  panel.append(body);

  // Folder
  body.append(el("div", "ns-label", "Folder"));
  const folders = el("div", "ns-card ns-folders");
  body.append(folders);
  const recents = (await deps.recents().catch(() => [])).slice(0, 8);
  const selectFolder = (path: string) => {
    cwd = path;
    folders.querySelectorAll(".ns-folder").forEach((r) => r.classList.toggle("on", (r as HTMLElement).dataset.path === path));
    repo = null;
    sync();
    void deps.gitInfo(path).then((g) => {
      if (cwd !== path) return;
      // Already inside a worktree: it IS its own branch — don't nest another.
      repo = g && g.repo !== false && g.root && !g.worktree ? { root: g.root, branch: g.branch || "" } : null;
      sync();
    });
  };
  for (const path of recents) {
    const row = el("button", "ns-folder") as HTMLButtonElement;
    row.dataset.path = path;
    const parts = path.split("/").filter(Boolean);
    const name = el("span", "ns-folder-name", parts[parts.length - 1] || path);
    const where = el("span", "ns-folder-path", parts.length > 1 ? parts.slice(-3, -1).join("/") : "/");
    const text = el("span", "ns-folder-text");
    text.append(name, where);
    row.append(text, el("span", "ns-check", "✓"));
    row.addEventListener("click", () => selectFolder(path));
    folders.append(row);
  }
  const browse = el("button", "ns-folder ns-browse") as HTMLButtonElement;
  browse.append(el("span", "ns-folder-name", "Browse or create a folder…"));
  browse.addEventListener("click", () => {
    closeNewSession();
    deps.browse();
  });
  folders.append(browse);

  // Agent + view
  const seg = (label: string, opts: { v: string; t: string }[], get: () => string, set: (v: string) => void) => {
    const row = el("div", "ns-row");
    row.append(el("span", "ns-row-label", label));
    const s = el("div", "ns-seg");
    for (const o of opts) {
      const b = el("button", "", o.t) as HTMLButtonElement;
      b.dataset.v = o.v;
      b.addEventListener("click", () => {
        set(o.v);
        sync();
      });
      s.append(b);
    }
    row.append(s);
    return row;
  };
  const settingsCard = el("div", "ns-card");
  body.append(el("div", "ns-label", "Session"));
  body.append(settingsCard);
  const agentRow = seg(
    "Agent",
    deps.agents.map((a) => ({ v: a.value, t: a.label })),
    () => agent,
    (v) => (agent = v)
  );
  const kindRow = seg(
    "View",
    [
      { v: "agent", t: "Chat" },
      { v: "pty", t: "Terminal" },
    ],
    () => kind,
    (v) => (kind = v === "pty" ? "pty" : "agent")
  );
  const branchRow = seg(
    "Branch",
    [
      { v: "shared", t: "Current" },
      { v: "own", t: "Own branch" },
    ],
    () => (ownBranch ? "own" : "shared"),
    (v) => (ownBranch = v === "own")
  );
  const branchNote = el("div", "ns-note");
  settingsCard.append(agentRow, kindRow, branchRow, branchNote);
  const err = el("div", "ns-err");
  err.hidden = true;

  // First message (chat only)
  const msgLabel = el("div", "ns-label", "First message");
  const msg = document.createElement("textarea");
  msg.className = "ns-msg";
  msg.rows = 3;
  msg.placeholder = "What should it work on? (optional)";
  msg.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      start.click();
    }
  });
  body.append(msgLabel, msg, err);

  function sync() {
    const a = deps.agents.find((x) => x.value === agent);
    const chatOk = !!a?.chat;
    if (!chatOk) kind = "pty"; // a plain shell has no chat view
    agentRow.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.v === agent));
    kindRow.querySelectorAll("button").forEach((b) => {
      b.classList.toggle("on", b.dataset.v === kind);
      (b as HTMLButtonElement).disabled = b.dataset.v === "agent" && !chatOk;
    });
    branchRow.hidden = !repo;
    branchNote.hidden = !repo;
    branchRow.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.v === (ownBranch ? "own" : "shared")));
    if (repo) {
      const name = repo.root.split("/").pop();
      branchNote.textContent = ownBranch
        ? `A new branch of ${name} from ${repo.branch}, in its own folder — other sessions can't touch its files. .env files are copied in.`
        : `Works directly in ${name} on ${repo.branch}, alongside any other session there.`;
    }
    const showMsg = kind === "agent";
    msgLabel.hidden = !showMsg;
    msg.hidden = !showMsg;
    start.disabled = !cwd;
    start.textContent = kind === "agent" && msg.value.trim() ? "Send" : "Start";
  }
  msg.addEventListener("input", sync);

  start.addEventListener("click", async () => {
    if (!cwd || start.disabled) return;
    start.disabled = true;
    localStorage.setItem(KIND_KEY, kind);
    localStorage.setItem(AGENT_KEY, agent);
    if (repo) localStorage.setItem(BRANCH_KEY, ownBranch ? "1" : "0");
    err.hidden = true;
    const ok = await deps.create({ cwd, agent, kind, prompt: kind === "agent" ? msg.value.trim() : "", worktree: !!repo && ownBranch });
    if (ok === true) closeNewSession();
    else {
      start.disabled = false;
      start.textContent = "Try again";
      if (typeof ok === "string") {
        err.textContent = ok;
        err.hidden = false;
      }
    }
  });

  if (recents[0]) selectFolder(recents[0]);
  sync();
  root.append(panel);
  root.hidden = false;
}
