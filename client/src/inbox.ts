/**
 * The fleet inbox: everything waiting on you, across every pane, answerable in
 * place — approve a command in one session, answer a question in another, reply
 * to a third, without opening any of them. Better than one-conversation-at-a-
 * time apps precisely because FleetView runs many.
 *
 * Data: GET /api/inbox (server/index.js inboxItems): chat panes report their
 * open approvals/questions; a terminal pane's prompt is read off its screen
 * (server/term-prompt.js) and answered with the keys you'd press — the server
 * re-reads the screen and refuses if the prompt changed. Actions go to
 * POST /api/inbox/act. Finished / cut-off sessions follow, with a quick reply.
 *
 * It also REPLACED the chip row that used to sit under the top bar: dormant
 * sessions ("Recover") and flagged follow-ups ("Flagged") live here now, fed
 * from main.ts's own state via deps (they're client-side facts, not server
 * inbox items). Recovery stays impossible to miss — the badge shows a dot
 * whenever something is waiting to be recovered, even with nothing needing you.
 *
 * Desktop: a drawer on the right. Phone: a full-screen sheet. Opened from the
 * inbox button in the top bar (badge = how many need you; a dot = only
 * recover/flagged items).
 *
 * All text via textContent; previews reuse chat-steps / chat-question.
 */
import { el, toolLabel, inputPreview } from "./chat-steps";
import { createQuestionCard } from "./chat-question";
import type { AgentEvent } from "./agent-events";

type PermissionEv = Extract<AgentEvent, { t: "permission_request" }>;
type QuestionEv = Extract<AgentEvent, { t: "question" }>;
type TermPrompt = { title: string; detail: string; question: string; options: { index: number; label: string; number: number | null }[]; cursor: number };
type Item = {
  pane: string;
  name: string;
  cwd: string;
  kind: "agent" | "pty";
  lastInput: string;
  type: "permission" | "question" | "term-prompt" | "term-waiting" | "done" | "aborted";
  ev?: PermissionEv | QuestionEv;
  prompt?: TermPrompt;
  lastReply?: string;
};

type LocalPane = { id: string; name: string; cwd: string };
export type InboxDeps = {
  openPane: (id: string) => void;
  dormant: () => (LocalPane & { sessionAlive: boolean })[];
  respawn: (id: string) => void;
  discard: (id: string) => void;
  flagged: () => LocalPane[];
  unflag: (id: string) => void;
};

let deps: InboxDeps;
let panel: HTMLElement | null = null;
let list: HTMLElement;
let refreshTimer: number | undefined;

export function initInbox(d: InboxDeps) {
  deps = d;
}

export function inboxOpen(): boolean {
  return !!panel && !panel.hidden;
}

export function closeInbox() {
  if (panel) panel.hidden = true;
  document.getElementById("inboxBtn")?.classList.remove("active");
}

export function openInbox() {
  if (!panel) build();
  panel!.hidden = false;
  document.getElementById("inboxBtn")?.classList.add("active");
  void load();
}

/** Called on control-socket events; coalesced, and only while the inbox is open. */
export function refreshInbox() {
  if (!inboxOpen()) return;
  if (refreshTimer != null) clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(() => {
    refreshTimer = undefined;
    void load();
  }, 150);
}

function build() {
  panel = el("div", "inbox");
  panel.id = "inbox";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Inbox");
  panel.hidden = true;
  const head = el("div", "inbox-head");
  const title = el("span", "inbox-title");
  title.textContent = "Inbox";
  const done = el("button", "inbox-done") as HTMLButtonElement;
  done.textContent = "Done";
  done.addEventListener("click", closeInbox);
  head.append(title, done);
  list = el("div", "inbox-list");
  panel.append(head, list);
  panel.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      closeInbox();
    }
  });
  document.body.append(panel);
}

async function load() {
  let items: Item[] = [];
  let error = "";
  try {
    const res = await fetch("/api/inbox", { cache: "no-store" });
    if (!res.ok) throw new Error(res.status === 404 ? "The inbox needs a server restart to work." : "Couldn't load the inbox.");
    items = await res.json();
  } catch (e) {
    error = (e as Error).message;
  }
  // Don't wipe a card someone is typing into — only re-render when idle.
  const typing = list.contains(document.activeElement) && /^(TEXTAREA|INPUT)$/.test(document.activeElement!.tagName);
  if (typing) return refreshInbox();
  list.textContent = "";
  if (error) {
    const n = el("div", "inbox-empty");
    n.textContent = error;
    list.append(n);
  }
  const dormant = deps.dormant();
  const flagged = deps.flagged();
  if (!error && !items.length && !dormant.length && !flagged.length) {
    const n = el("div", "inbox-empty");
    n.textContent = "All clear — nothing needs you.";
    list.append(n);
    return;
  }
  const needs = items.filter((i) => i.type !== "done" && i.type !== "aborted");
  const rest = items.filter((i) => i.type === "done" || i.type === "aborted");
  if (needs.length) list.append(section("Needs you", needs));
  if (dormant.length) list.append(recoverSection(dormant));
  if (rest.length) list.append(section("Finished", rest));
  if (flagged.length) list.append(flaggedSection(flagged));
}

function where(cwd: string) {
  return cwd.split("/").filter(Boolean).slice(-2).join("/");
}

/** A compact row: name + folder on the left, actions on the right. */
function miniRow(p: LocalPane, note: string, actions: HTMLElement[]) {
  const r = el("div", "inbox-mini");
  const who = el("span", "ic-who");
  const name = el("span", "ic-name");
  name.textContent = p.name;
  const sub = el("span", "ic-where");
  sub.textContent = note ? `${note} · ${where(p.cwd)}` : where(p.cwd);
  sub.title = p.cwd;
  who.append(name, sub);
  const acts = el("span", "mini-acts");
  acts.append(...actions);
  r.append(who, acts);
  return r;
}

function recoverSection(list: (LocalPane & { sessionAlive: boolean })[]) {
  const s = el("div", "inbox-sec");
  const h = el("div", "inbox-sec-h");
  h.textContent = `Recover · ${list.length}`;
  if (list.length > 1) {
    const all = btn("Recover all", "ghost sec-act", () => {
      for (const p of list) deps.respawn(p.id);
    });
    h.append(all);
  }
  s.append(h);
  const card = el("div", "inbox-card inbox-minis");
  for (const p of list) {
    card.append(
      miniRow(p, p.sessionAlive ? "Set aside" : "Stopped", [
        btn(p.sessionAlive ? "Restore" : "Respawn", "primary", () => deps.respawn(p.id)),
        btn("Discard", "ghost", () => deps.discard(p.id)),
      ])
    );
  }
  card.title = "Sessions that stopped (sleep, crash) or were set aside by a layout. Set-aside ones come back intact; stopped ones get a fresh shell in the same folder.";
  s.append(card);
  return s;
}

function flaggedSection(list: LocalPane[]) {
  const s = el("div", "inbox-sec");
  const h = el("div", "inbox-sec-h");
  h.textContent = `Flagged · ${list.length}`;
  s.append(h);
  const card = el("div", "inbox-card inbox-minis");
  for (const p of list) {
    card.append(
      miniRow(p, "", [btn("Open", "", () => deps.openPane(p.id)), btn("Unflag", "ghost", () => deps.unflag(p.id))])
    );
  }
  s.append(card);
  return s;
}

function section(label: string, items: Item[]) {
  const s = el("div", "inbox-sec");
  const h = el("div", "inbox-sec-h");
  h.textContent = `${label} · ${items.length}`;
  s.append(h);
  for (const it of items) s.append(card(it));
  return s;
}

async function act(item: Item, action: Record<string, unknown>, cardEl: HTMLElement) {
  cardEl.classList.add("busy");
  cardEl.querySelectorAll("button, textarea, input").forEach((b) => ((b as HTMLButtonElement).disabled = true));
  try {
    const res = await fetch("/api/inbox/act", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pane: item.pane, action }),
    });
    const r = await res.json().catch(() => ({ ok: false, reason: "Server error" }));
    if (!r.ok) throw new Error(r.reason || "Couldn't do that.");
    cardEl.classList.add("done-card");
    setTimeout(() => void load(), 250);
  } catch (e) {
    cardEl.classList.remove("busy");
    cardEl.querySelectorAll("button, textarea, input").forEach((b) => ((b as HTMLButtonElement).disabled = false));
    const err = cardEl.querySelector(".inbox-err") as HTMLElement;
    err.hidden = false;
    err.textContent = (e as Error).message;
  }
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

/** A text box + Send, revealed on demand (reasons, replies). */
function textRow(placeholder: string, sendLabel: string, onSend: (text: string) => void, required = true) {
  const row = el("div", "ib-text");
  const box = document.createElement("textarea");
  box.rows = 2;
  box.placeholder = placeholder;
  const send = btn(sendLabel, "primary", () => {
    if (required && !box.value.trim()) return box.focus();
    onSend(box.value.trim());
  });
  box.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send.click();
    }
  });
  row.append(box, send);
  return { row, box };
}

function snippet(text: string, n = 220) {
  const t = text.replace(/```[\s\S]*?```/g, "[code]").replace(/[#*_`>|]/g, "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

function card(it: Item): HTMLElement {
  const c = el("div", `inbox-card t-${it.type}`);
  const head = el("div", "ic-head");
  const dot = el("span", "ic-dot");
  const who = el("span", "ic-who");
  const name = el("span", "ic-name");
  name.textContent = it.name;
  const where = el("span", "ic-where");
  where.textContent = `${it.kind === "agent" ? "chat" : "terminal"} · ${it.cwd.split("/").filter(Boolean).slice(-2).join("/")}`;
  who.append(name, where);
  const open = btn("Open", "ghost", () => deps.openPane(it.pane));
  head.append(dot, who, open);
  c.append(head);
  const body = el("div", "ic-body");
  const actions = el("div", "ic-actions");
  const err = el("div", "inbox-err");
  err.hidden = true;

  if (it.type === "permission" && it.ev?.t === "permission_request") {
    const ev = it.ev;
    const { verb, target } = toolLabel(ev.tool, ev.input);
    const q = el("div", "ic-q");
    q.textContent = ev.tool === "ExitPlanMode" ? "Claude has a plan ready." : ev.title || ev.description || `Allow ${verb}${target ? " " + target : ""}?`;
    body.append(q);
    const prev = inputPreview(ev.tool, ev.input, { quiet: true });
    if (prev) {
      const w = el("div", "ic-preview");
      w.append(prev);
      body.append(w);
    }
    const reason = textRow(ev.tool === "ExitPlanMode" ? "What should change in the plan?" : "Tell Claude what to do instead (optional)", "Send", (text) =>
      act(it, { type: "approve", requestId: ev.requestId, decision: "deny", text }, c), false);
    reason.row.hidden = true;
    if (ev.tool === "ExitPlanMode") {
      actions.append(
        btn("Approve · auto-accept edits", "primary", () => act(it, { type: "approve", requestId: ev.requestId, decision: "allow", mode: "acceptEdits" }, c)),
        btn("Approve · ask for edits", "", () => act(it, { type: "approve", requestId: ev.requestId, decision: "allow", mode: "default" }, c)),
        btn("Keep planning…", "", () => {
          reason.row.hidden = false;
          reason.box.focus();
        })
      );
    } else {
      actions.append(btn("Allow", "primary", () => act(it, { type: "approve", requestId: ev.requestId, decision: "allow" }, c)));
      if (ev.canAlways !== false) actions.append(btn("Always allow", "", () => act(it, { type: "approve", requestId: ev.requestId, decision: "always" }, c)));
      actions.append(
        btn("Deny…", "danger", () => {
          reason.row.hidden = false;
          reason.box.focus();
        })
      );
    }
    c.append(body, actions, reason.row, err);
    return c;
  }

  if (it.type === "question" && it.ev?.t === "question") {
    const ev = it.ev;
    body.append(createQuestionCard(ev, (answers) => act(it, { type: "answer", requestId: ev.requestId, answers }, c)));
    c.append(body, err);
    return c;
  }

  if (it.type === "term-prompt" && it.prompt) {
    const p = it.prompt;
    const t = el("div", "ic-title");
    t.textContent = p.title;
    body.append(t);
    if (p.detail) {
      const d = el("pre", "ic-detail");
      d.textContent = p.detail;
      body.append(d);
    }
    const q = el("div", "ic-q");
    q.textContent = p.question;
    body.append(q);
    // "No" can carry what Claude should do instead — typed as the next message
    // after the prompt closes. The row sends for whichever "No" opened it.
    let pendingNo: ((text: string) => void) | null = null;
    const reason = textRow("Tell Claude what to do instead (optional)", "Send", (text) => pendingNo?.(text), false);
    reason.row.hidden = true;
    const opts = el("div", "ic-options");
    for (const o of p.options) {
      const isNo = /^no\b/i.test(o.label);
      const choose = (text = "") => act(it, { type: "choose", index: o.index, label: o.label, question: p.question, text }, c);
      opts.append(
        btn(o.label, o.index === 0 ? "primary option" : isNo ? "danger option" : "option", () => {
          if (!isNo) return void choose();
          pendingNo = (text) => void choose(text);
          reason.row.hidden = false;
          reason.box.focus();
        })
      );
    }
    c.append(body, opts, reason.row, err);
    return c;
  }

  // Waiting / finished / cut off: last word + quick reply.
  const status = el("div", "ic-q");
  status.textContent =
    it.type === "term-waiting" ? "Waiting for your reply" : it.type === "aborted" ? "Cut off before finishing" : "Finished";
  body.append(status);
  const said = it.lastReply ? snippet(it.lastReply) : it.lastInput ? `You: ${snippet(it.lastInput, 140)}` : "";
  if (said) {
    const s = el("div", "ic-snippet");
    s.textContent = said;
    body.append(s);
  }
  const reply = textRow(it.type === "aborted" ? "Continue…" : "Reply…", "Send", (text) => act(it, { type: "reply", text }, c));
  if (it.type !== "term-waiting") actions.append(btn("Dismiss", "ghost", () => act(it, { type: "dismiss" }, c)));
  c.append(body, reply.row, actions, err);
  return c;
}
