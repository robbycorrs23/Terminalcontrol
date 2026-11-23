/**
 * The Changes panel: what this session has changed, as it is on disk now.
 * Opens over a chat pane (from the + menu, or "N files changed" under a turn).
 * Data comes from GET /api/panes/:id/changes (server/changes.js):
 *
 *   This session      files Claude edited here — current diff vs HEAD, or
 *                     "no changes now" if committed/reverted since
 *   Ship              commit → push → PR, plus overlap warnings (ship-panel.ts)
 *   Other changes     uncommitted changes in the repo this session didn't
 *                     make (collapsed) — including anything edited through
 *                     shell commands, which a transcript can't attribute
 *
 * Review mode (review.ts): tap any diff line to comment; the comments go back
 * to the session as one message from the bar at the bottom.
 *
 * Non-git edit diffs render with the same code the chat's steps use. All text via
 * textContent / chat-steps' renderers — nothing here touches innerHTML.
 */
import { el, renderDiff, inputDiff } from "./chat-steps";
import { renderShip } from "./ship-panel";
import { ReviewStore, renderReviewDiff, reviewBar } from "./review";

type FileChange = {
  path: string;
  rel: string;
  status: string; // M | A | D | R | clean
  add?: number;
  del?: number;
  diff?: string;
  note?: string;
  outside?: boolean;
  edits?: { tool: string; input: unknown }[];
};
type Changes = { repo: { root: string; branch: string } | null; session: FileChange[]; other: FileChange[]; note?: string };

const STATUS_LABEL: Record<string, string> = { M: "M", A: "A", D: "D", R: "R", clean: "✓" };
const STATUS_TITLE: Record<string, string> = {
  M: "Modified",
  A: "New file",
  D: "Deleted",
  R: "Renamed",
  clean: "No changes now — committed or changed back",
};

function fileRow(f: FileChange, store: ReviewStore): HTMLElement {
  const row = el("details", `chg-file ${f.status === "clean" ? "clean" : ""}`) as HTMLDetailsElement;
  const sum = document.createElement("summary");
  const badge = el("span", `chg-badge s-${f.status}`);
  badge.textContent = STATUS_LABEL[f.status] || f.status;
  badge.title = STATUS_TITLE[f.status] || f.status;
  const parts = f.rel.split("/");
  const name = el("span", "chg-name");
  name.textContent = parts.pop() || f.rel;
  const dir = el("span", "chg-dir");
  dir.textContent = f.outside ? "outside this repo" : parts.join("/");
  const text = el("span", "chg-text");
  text.append(name, dir);
  const stat = el("span", "chg-stat");
  if (f.status === "clean") stat.textContent = "no changes now";
  else if (f.add != null || f.del != null) {
    const a = el("span", "add");
    a.textContent = `+${f.add ?? 0}`;
    const d = el("span", "del");
    d.textContent = `−${f.del ?? 0}`;
    stat.append(a, d);
  }
  // How many review comments this file carries (drafts survive a closed panel).
  const rv = el("span", "chg-rv");
  const syncRv = () => {
    const n = store.forFile(f.rel).length;
    rv.hidden = n === 0;
    rv.textContent = String(n);
    rv.title = `${n} review comment${n === 1 ? "" : "s"}`;
  };
  syncRv();
  store.onChange(() => rv.isConnected && syncRv());
  sum.append(badge, text, rv, stat);
  sum.title = f.path;
  row.append(sum);

  // Build the diff only when opened — a big repo can have dozens.
  row.addEventListener("toggle", () => {
    if (!row.open || row.querySelector(".chg-body")) return;
    const body = el("div", "chg-body");
    if (f.diff) body.append(renderReviewDiff(f.diff, f.rel, store, true));
    else if (f.edits?.length) {
      const joined = f.edits
        .map((e) => inputDiff(e.tool, e.input))
        .filter(Boolean)
        .join("\n…\n");
      if (joined) body.append(renderReviewDiff(joined, f.rel, store, false));
      const n = el("div", "chg-note");
      n.textContent = "The edits this session made (not compared with the file on disk).";
      body.append(n);
    } else {
      const n = el("div", "chg-note");
      n.textContent = f.note || (f.status === "clean" ? STATUS_TITLE.clean : "Nothing to show.");
      body.append(n);
    }
    row.append(body);
  });
  if (store.forFile(f.rel).length) row.open = true; // show the drafts where they were left
  return row;
}

function totals(list: FileChange[]) {
  let add = 0;
  let del = 0;
  for (const f of list) {
    add += f.add || 0;
    del += f.del || 0;
  }
  return { add, del, files: list.filter((f) => f.status !== "clean").length };
}

/** Open the panel over `host` (the pane's .chat element) for pane `paneId`. */
export function openChanges(host: HTMLElement, paneId: string, send?: (text: string) => void) {
  const store = new ReviewStore(paneId);
  host.querySelector(".chg-panel")?.remove();
  const panel = el("div", "chg-panel");
  panel.addEventListener("click", (e) => e.stopPropagation()); // not a click-to-zoom
  const head = el("div", "chg-head");
  const back = el("button", "chg-back") as HTMLButtonElement;
  back.textContent = "‹";
  back.title = "Back to the chat";
  back.setAttribute("aria-label", "Back to the chat");
  back.addEventListener("click", () => panel.remove());
  const titles = el("div", "chg-titles");
  const title = el("div", "chg-title");
  title.textContent = "Changes";
  const sub = el("div", "chg-sub");
  sub.textContent = "Loading…";
  titles.append(title, sub);
  const refresh = el("button", "chg-refresh") as HTMLButtonElement;
  refresh.textContent = "↻";
  refresh.title = "Refresh";
  refresh.setAttribute("aria-label", "Refresh");
  head.append(back, titles, refresh);
  const body = el("div", "chg-list");
  panel.append(head, body);
  if (send) {
    panel.append(
      reviewBar(store, send, (sent) => {
        if (sent) panel.remove(); // back to the chat, where the review just landed
        else void load();
      })
    );
  }
  host.append(panel);

  const keyClose = (e: KeyboardEvent) => {
    if (e.key === "Escape" && panel.isConnected) {
      e.stopPropagation();
      panel.remove();
    }
  };
  panel.tabIndex = -1;
  panel.addEventListener("keydown", keyClose);
  panel.focus({ preventScroll: true });

  const load = async () => {
    body.textContent = "";
    sub.textContent = "Loading…";
    refresh.disabled = true;
    // Ship section first; it loads on its own (it asks gh about PRs, which can be slow).
    const shipSlot = el("div", "ship-slot");
    body.append(shipSlot);
    void renderShip(shipSlot, paneId, () => void load());
    let data: Changes;
    try {
      const res = await fetch(`/api/panes/${paneId}/changes`);
      if (res.status === 404) throw new Error("This needs a server restart to work.");
      data = await res.json();
      if (!res.ok) throw new Error((data as unknown as { error?: string }).error || "Couldn't load changes");
    } catch (e) {
      sub.textContent = "";
      const n = el("div", "chg-empty");
      n.textContent = (e as Error).message || "Couldn't load changes";
      body.append(n);
      refresh.disabled = false;
      return;
    }
    refresh.disabled = false;
    const t = totals(data.session);
    sub.textContent = [
      data.repo?.branch,
      `${t.files} file${t.files === 1 ? "" : "s"} changed`,
      t.add || t.del ? `+${t.add} −${t.del}` : "",
    ]
      .filter(Boolean)
      .join(" · ");

    if (data.note) {
      const n = el("div", "chg-banner");
      n.textContent = data.note;
      body.append(n);
    }

    // A second opinion: a fresh Claude session reviews everything uncommitted
    // here (server/index.js /api/panes/:id/review) and can send its findings back.
    if (data.repo && (data.session.length || data.other.length)) {
      const ask = el("div", "chg-ask-review");
      const b = el("button", "ship-btn primary") as HTMLButtonElement;
      b.textContent = "Review with Claude";
      const note = el("span", "chg-ask-note");
      note.textContent = "A second Claude reads these changes for bugs and gaps, without editing. Send its findings back here when it's done.";
      b.addEventListener("click", async () => {
        b.disabled = true;
        b.textContent = "Starting…";
        const r = await fetch(`/api/panes/${paneId}/review`, { method: "POST" }).catch(() => null);
        const j = r ? await r.json().catch(() => ({})) : {};
        if (r?.ok && j.id) {
          panel.remove();
          window.dispatchEvent(new CustomEvent("fleet:open-pane", { detail: j.id }));
        } else {
          b.disabled = false;
          b.textContent = "Review with Claude";
          alert(j.error || (r?.status === 404 ? "This needs a server restart to work." : "Couldn't start a review."));
        }
      });
      ask.append(b, note);
      body.append(ask);
    }

    const h1 = el("div", "chg-section");
    h1.textContent = "This session";
    body.append(h1);
    if (data.session.length) {
      const card = el("div", "chg-card");
      for (const f of data.session) card.append(fileRow(f, store));
      body.append(card);
    } else {
      const n = el("div", "chg-empty");
      n.textContent = "No file edits in this session yet.";
      body.append(n);
    }

    if (data.other.length) {
      const o = totals(data.other);
      const wrap = el("details", "chg-other") as HTMLDetailsElement;
      const s = document.createElement("summary");
      s.className = "chg-section";
      s.textContent = `Other uncommitted changes · ${data.other.length}`;
      s.title = `+${o.add} −${o.del}`;
      const card = el("div", "chg-card");
      for (const f of data.other) card.append(fileRow(f, store));
      wrap.append(s, card);
      body.append(wrap);
    }
    if (data.repo) {
      const foot = el("div", "chg-foot");
      foot.textContent =
        (send ? "Tap any line to comment on it — your comments go back to the session as one review. " : "") +
        "\"This session\" is what Claude edited with its file tools, compared with the last commit. Changes made through shell commands, by another session or by you appear under Other.";
      body.append(foot);
    }
  };
  refresh.addEventListener("click", () => void load());
  void load();
}
