/**
 * "Ship it" — the top of the Changes panel: commit → push → open a PR, without
 * leaving the session. Server side is server/ship.js (which enforces every
 * safety rule; this module is only the UI):
 *
 *   status    branch (own worktree or not), commits ahead of its base, push
 *             state, the open PR if there is one
 *   overlap   other sessions of the same repo that edited the same files
 *   Commit…   pick files (own worktree: all pre-ticked; shared checkout: only
 *             this session's), a message drafted from the diff + the request,
 *             editable; on the default branch it offers a new branch instead
 *   Push      never the default branch (refused server-side too)
 *   Open PR…  title + body drafted from the branch's commits, editable
 *   Finish    own-branch sessions only: remove the worktree (refused while
 *             anything is uncommitted), delete the branch only if merged, and
 *             close the session
 *
 * All text via textContent; the only link (the PR) must be https.
 */
import { el } from "./chat-steps";
import { iconSvg } from "./icons";
import { overlapsOf } from "./git-status";

type ShipFile = { rel: string; status: string; session: boolean };
type Ship = {
  repo: boolean;
  note?: string;
  root?: string;
  branch?: string | null;
  base?: string | null;
  defaultBranch?: string | null;
  worktree?: boolean;
  onDefault?: boolean;
  upstream?: string | null;
  unpushed?: number | null;
  ahead?: number;
  files?: ShipFile[];
  pr?: { url: string; state: string; number: number } | null;
};
type Result = { ok: boolean; reason?: string; sha?: string; url?: string; branch?: string; branchDeleted?: boolean };

async function post(paneId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`/api/panes/${paneId}/ship`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 404) return { ok: false, reason: "This needs a server restart to work." };
  return res.json().catch(() => ({ ok: false, reason: "Server error" }));
}

function button(label: string, cls: string, on: () => void): HTMLButtonElement {
  const b = el("button", `ship-btn ${cls}`) as HTMLButtonElement;
  b.textContent = label;
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    on();
  });
  return b;
}

/** Branch-name slug from a commit summary, cut at a word boundary (never "…-pan"). */
function slug(s: string) {
  const full = s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (full.length <= 40) return full;
  const cut = full.slice(0, 41);
  return cut.slice(0, cut.lastIndexOf("-") > 10 ? cut.lastIndexOf("-") : 40).replace(/-+$/, "");
}

/**
 * Render the Ship section into `into`. `reload` re-runs the whole Changes
 * panel (after a commit the file lists change too).
 */
export async function renderShip(into: HTMLElement, paneId: string, reload: () => void) {
  let st: Ship;
  try {
    const res = await fetch(`/api/panes/${paneId}/ship`, { cache: "no-store" });
    if (!res.ok) return; // older server, or a pane that's gone — the rest of the panel still works
    st = await res.json();
  } catch {
    return;
  }
  if (!st.repo || (!st.branch && !st.files?.length)) return;

  const card = el("div", "ship-card");
  into.append(card);

  // ---- Status ----
  const head = el("div", "ship-head");
  const br = el("span", "ship-branch");
  br.innerHTML = iconSvg("branch");
  const brName = el("span", "ship-branch-name");
  brName.textContent = st.branch || "detached HEAD";
  br.append(brName);
  head.append(br);
  if (st.worktree) {
    const tag = el("span", "ship-tag");
    tag.textContent = "own branch";
    tag.title = "This session works in its own git worktree — other sessions can't touch its files.";
    head.append(tag);
  }
  card.append(head);

  const meta: string[] = [];
  if (st.branch && st.base && st.base !== st.branch) meta.push(`${st.ahead || 0} commit${st.ahead === 1 ? "" : "s"} ahead of ${st.base}`);
  if (st.onDefault) meta.push("default branch");
  if (st.branch && !st.onDefault) {
    if (!st.upstream) meta.push(st.ahead ? "not pushed" : "");
    else meta.push(st.unpushed ? `${st.unpushed} to push` : "pushed");
  }
  const metaEl = el("div", "ship-meta");
  metaEl.textContent = meta.filter(Boolean).join(" · ");
  if (st.pr && /^https:\/\//.test(st.pr.url)) {
    const a = document.createElement("a");
    a.className = "ship-pr";
    a.href = st.pr.url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = `PR #${st.pr.number} · ${st.pr.state.toLowerCase()}`;
    metaEl.append(a);
  }
  card.append(metaEl);

  // ---- Overlaps ----
  const ov = overlapsOf(paneId);
  if (ov.length) {
    const w = el("div", "ship-overlap");
    w.innerHTML = iconSvg("alert");
    const t = el("div", "ship-overlap-text");
    for (const o of ov) {
      const line = el("div", "");
      const who = el("b", "");
      who.textContent = o.name;
      line.append("Also edited in ", who, `: ${o.files.slice(0, 6).join(", ")}${o.files.length > 6 ? ` +${o.files.length - 6}` : ""}`);
      t.append(line);
    }
    w.append(t);
    w.title = "These files were edited by another session of the same repository — expect a merge conflict if both land.";
    card.append(w);
  }

  // ---- Actions ----
  const msg = el("div", "ship-msg");
  msg.hidden = true;
  const say = (text: string, kind: "ok" | "err" | "" = "") => {
    msg.hidden = !text;
    msg.className = `ship-msg ${kind}`;
    msg.textContent = text;
  };
  const form = el("div", "ship-form");
  form.hidden = true;
  const actions = el("div", "ship-actions");
  const files = st.files || [];
  const busy = (b: HTMLButtonElement, on: boolean, label?: string) => {
    actions.querySelectorAll("button").forEach((x) => ((x as HTMLButtonElement).disabled = on || x.dataset.off === "1"));
    if (label) b.textContent = label;
  };

  const commitBtn = button(files.length ? `Commit… (${files.length})` : "Commit…", "primary", () => openCommit());
  if (!files.length) {
    commitBtn.dataset.off = "1";
    commitBtn.title = "Nothing uncommitted";
  }
  const canPush = !!st.branch && !st.onDefault && (st.upstream ? !!st.unpushed : !!st.ahead);
  const pushBtn = button(st.upstream ? "Push" : "Push branch", "", async () => {
    busy(pushBtn, true, "Pushing…");
    say("");
    const r = (await post(paneId, { action: "push" })) as Result;
    if (r.ok) {
      say(`Pushed ${r.branch}.`, "ok");
      setTimeout(reload, 700);
    } else {
      busy(pushBtn, false, st.upstream ? "Push" : "Push branch");
      say(r.reason || "Push failed.", "err");
    }
  });
  if (!canPush) {
    pushBtn.dataset.off = "1";
    pushBtn.title = st.onDefault
      ? `Pushing ${st.branch} from here is disabled — commit to a new branch.`
      : "Nothing to push";
  }
  const canPr = !!st.upstream && !st.pr && !st.onDefault && !!st.ahead;
  const prBtn = button("Open PR…", "", () => openPr());
  if (!canPr) {
    prBtn.dataset.off = "1";
    prBtn.title = st.pr ? "There's already a PR for this branch" : !st.upstream ? "Push the branch first" : "No commits to propose";
  }
  actions.append(commitBtn, pushBtn, prBtn);
  if (st.worktree) {
    const finishBtn = button("Finish branch", "ghost", async () => {
      const ok = confirm(
        `Finish "${st.branch}"?\n\nThis removes the session's worktree folder and closes the session. ` +
          `The branch is deleted only if it's already merged into ${st.base || "its base"} — otherwise it's kept.\n\n` +
          `Refused if anything is uncommitted.`
      );
      if (!ok) return;
      busy(finishBtn, true, "Finishing…");
      const r = (await post(paneId, { action: "finish" })) as Result;
      if (!r.ok) {
        busy(finishBtn, false, "Finish branch");
        say(r.reason || "Couldn't finish.", "err");
      }
      // On success the server closes the pane; the panel goes with it.
    });
    finishBtn.title = "Remove this session's worktree and close it (the branch is kept unless merged)";
    actions.append(finishBtn);
  }
  for (const b of actions.querySelectorAll("button")) (b as HTMLButtonElement).disabled = (b as HTMLElement).dataset.off === "1";
  card.append(actions, form, msg);

  // ---- Commit form ----
  function openCommit() {
    if (!form.hidden && form.dataset.kind === "commit") return closeForm();
    form.dataset.kind = "commit";
    form.textContent = "";
    form.hidden = false;
    say("");
    const list = el("div", "ship-files");
    const boxes: { f: ShipFile; box: HTMLInputElement }[] = [];
    const addGroup = (label: string, group: ShipFile[], checked: boolean) => {
      if (!group.length) return;
      const h = el("div", "ship-files-h");
      h.textContent = label;
      list.append(h);
      for (const f of group) {
        const row = el("label", "ship-file");
        const box = document.createElement("input");
        box.type = "checkbox";
        box.checked = checked;
        const s = el("span", `chg-badge s-${f.status}`);
        s.textContent = f.status;
        const name = el("span", "ship-file-name");
        name.textContent = f.rel;
        row.append(box, s, name);
        list.append(row);
        boxes.push({ f, box });
      }
    };
    const mine = files.filter((f) => f.session);
    const other = files.filter((f) => !f.session);
    if (st.worktree) addGroup("Files", files, true);
    else {
      addGroup("This session", mine, true);
      addGroup("Other changes", other, false); // never pre-tick work this session didn't do
    }
    form.append(list);

    // On the default branch: commit to a new branch instead (on by default).
    let newBranch: HTMLInputElement | null = null;
    let useNew: HTMLInputElement | null = null;
    let branchEdited = false;
    if (st.onDefault) {
      const row = el("label", "ship-newbranch");
      useNew = document.createElement("input");
      useNew.type = "checkbox";
      useNew.checked = true;
      const txt = el("span", "");
      txt.textContent = "Commit to a new branch";
      newBranch = document.createElement("input");
      newBranch.type = "text";
      newBranch.className = "ship-input";
      newBranch.value = "fleet/changes";
      newBranch.spellcheck = false;
      newBranch.addEventListener("input", () => (branchEdited = true));
      useNew.addEventListener("change", () => (newBranch!.disabled = !useNew!.checked));
      row.append(useNew, txt);
      form.append(row, newBranch);
    }

    const message = document.createElement("textarea");
    message.className = "ship-text";
    message.rows = 4;
    message.placeholder = "Drafting a commit message…";
    message.addEventListener("keydown", (e) => e.stopPropagation());
    form.append(message);

    const row = el("div", "ship-form-actions");
    const redraft = button("Redraft", "ghost", () => void draft());
    const go = button("Commit", "primary", async () => {
      const chosen = boxes.filter((b) => b.box.checked).map((b) => b.f.rel);
      if (!chosen.length) return say("Choose at least one file.", "err");
      if (!message.value.trim()) return message.focus();
      const nb = useNew?.checked ? newBranch!.value.trim() : null;
      go.disabled = true;
      go.textContent = "Committing…";
      const r = (await post(paneId, { action: "commit", files: chosen, message: message.value, newBranch: nb })) as Result;
      if (r.ok) {
        say(`Committed ${r.sha}${nb ? ` on ${r.branch}` : ""}.`, "ok");
        setTimeout(reload, 700);
      } else {
        go.disabled = false;
        go.textContent = "Commit";
        say(r.reason || "Commit failed.", "err");
      }
    });
    row.append(redraft, button("Cancel", "ghost", closeForm), go);
    form.append(row);

    let drafting = 0;
    async function draft() {
      const chosen = boxes.filter((b) => b.box.checked).map((b) => b.f.rel);
      if (!chosen.length) return;
      const n = ++drafting;
      message.value = "";
      message.placeholder = "Drafting a commit message…";
      redraft.disabled = true;
      const r = (await post(paneId, { action: "draft-commit", files: chosen })) as { message?: string };
      if (n !== drafting) return;
      redraft.disabled = false;
      message.placeholder = "Commit message";
      if (!message.value) message.value = r.message || "";
      if (newBranch && !branchEdited && r.message) newBranch.value = `fleet/${slug(r.message.split("\n")[0]) || "changes"}`;
    }
    void draft();
  }

  // ---- PR form ----
  function openPr() {
    if (!form.hidden && form.dataset.kind === "pr") return closeForm();
    form.dataset.kind = "pr";
    form.textContent = "";
    form.hidden = false;
    say("");
    const title = document.createElement("input");
    title.type = "text";
    title.className = "ship-input";
    title.placeholder = "Drafting a title…";
    const body = document.createElement("textarea");
    body.className = "ship-text";
    body.rows = 8;
    body.placeholder = "Drafting a description…";
    for (const x of [title, body]) x.addEventListener("keydown", (e) => e.stopPropagation());
    const into = el("div", "ship-meta");
    into.textContent = `${st.branch} → ${st.base}`;
    const row = el("div", "ship-form-actions");
    const go = button("Create pull request", "primary", async () => {
      if (!title.value.trim()) return title.focus();
      go.disabled = true;
      go.textContent = "Creating…";
      const r = (await post(paneId, { action: "pr", title: title.value, body: body.value })) as Result;
      if (r.ok) {
        say(`Opened ${r.url}`, "ok");
        setTimeout(reload, 900);
      } else {
        go.disabled = false;
        go.textContent = "Create pull request";
        say(r.reason || "Couldn't open the PR.", "err");
      }
    });
    row.append(button("Cancel", "ghost", closeForm), go);
    form.append(into, title, body, row);
    void post(paneId, { action: "draft-pr" }).then((r) => {
      title.placeholder = "Title";
      body.placeholder = "Description";
      if (!title.value) title.value = String(r.title || "");
      if (!body.value) body.value = String(r.body || "");
    });
  }

  function closeForm() {
    form.hidden = true;
    form.textContent = "";
    delete form.dataset.kind;
  }
}
