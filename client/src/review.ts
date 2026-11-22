/**
 * Review mode for the Changes panel: comment on diff lines, then send every
 * comment back to the session as ONE message — "fix these three things" —
 * like reviewing a PR, except the author is the agent and it's still here.
 *
 *  - renderReviewDiff() draws a diff as rows with real line numbers (parsed
 *    from the hunk headers; an untracked file's all-added diff has none, so it
 *    counts from 1). Tap/click a row to comment on it.
 *  - Drafts live in localStorage per pane, so closing the panel (or the tab)
 *    loses nothing. Each comment stores the line's text too: if the file moved
 *    on since, it's re-anchored by text, and failing that shown at the end of
 *    the file marked "moved".
 *  - The message quotes file:line and the code line itself, so it reads
 *    correctly even after the lines shift. Sending goes through the chat's own
 *    send path (AgentChat.sendExternal) — mid-turn it queues like typing does.
 *
 * All text via textContent.
 */
import { el } from "./chat-steps";

export type ReviewComment = {
  id: string;
  file: string; // repo-relative path, as the panel shows it
  line: number | null; // number on `side`, null when unknown (non-git edits)
  side: "new" | "old";
  code: string; // the diff line, with its +/-/space marker
  text: string;
};

const key = (paneId: string) => `fleet-review:${paneId}`;

export class ReviewStore {
  private list: ReviewComment[];
  private listeners = new Set<() => void>();
  constructor(private paneId: string) {
    try {
      this.list = JSON.parse(localStorage.getItem(key(paneId)) || "[]");
      if (!Array.isArray(this.list)) this.list = [];
    } catch {
      this.list = [];
    }
  }
  all() {
    return this.list.slice();
  }
  forFile(file: string) {
    return this.list.filter((c) => c.file === file);
  }
  get count() {
    return this.list.length;
  }
  onChange(fn: () => void) {
    this.listeners.add(fn);
  }
  private save() {
    if (this.list.length) localStorage.setItem(key(this.paneId), JSON.stringify(this.list));
    else localStorage.removeItem(key(this.paneId));
    for (const fn of this.listeners) fn();
  }
  add(c: Omit<ReviewComment, "id">) {
    const full = { ...c, id: Math.random().toString(36).slice(2, 10) };
    this.list.push(full);
    this.save();
    return full;
  }
  update(id: string, text: string) {
    const c = this.list.find((x) => x.id === id);
    if (c) c.text = text;
    this.save();
  }
  remove(id: string) {
    this.list = this.list.filter((x) => x.id !== id);
    this.save();
  }
  clear() {
    this.list = [];
    this.save();
  }
}

type Row = { kind: "add" | "del" | "ctx" | "hunk"; code: string; oldLn: number | null; newLn: number | null };

/** Diff text → rows with old/new line numbers. */
export function parseDiffRows(diff: string): Row[] {
  const rows: Row[] = [];
  let o = 1;
  let n = 1;
  for (const line of diff.replace(/\n$/, "").split("\n")) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (h) {
      o = Number(h[1]);
      n = Number(h[2]);
      rows.push({ kind: "hunk", code: line, oldLn: null, newLn: null });
    } else if (line.startsWith("+")) rows.push({ kind: "add", code: line, oldLn: null, newLn: n++ });
    else if (line.startsWith("-")) rows.push({ kind: "del", code: line, oldLn: o++, newLn: null });
    else if (line.startsWith("\\")) rows.push({ kind: "hunk", code: line, oldLn: null, newLn: null }); // "\ No newline at end of file"
    else rows.push({ kind: "ctx", code: line, oldLn: o++, newLn: n++ });
  }
  return rows;
}

function editor(initial: string, onSave: (text: string) => void, onCancel: () => void): HTMLElement {
  const box = el("div", "rv-editor");
  const ta = document.createElement("textarea");
  ta.rows = 3;
  ta.value = initial;
  ta.placeholder = "What should change here?";
  const acts = el("div", "rv-acts");
  const cancel = el("button", "rv-btn ghost") as HTMLButtonElement;
  cancel.textContent = "Cancel";
  const save = el("button", "rv-btn primary") as HTMLButtonElement;
  save.textContent = initial ? "Save" : "Comment";
  const sync = () => (save.disabled = !ta.value.trim());
  ta.addEventListener("input", sync);
  ta.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save.click();
    if (e.key === "Escape") cancel.click();
  });
  cancel.addEventListener("click", (e) => {
    e.stopPropagation();
    onCancel();
  });
  save.addEventListener("click", (e) => {
    e.stopPropagation();
    if (ta.value.trim()) onSave(ta.value.trim());
  });
  acts.append(cancel, save);
  box.append(ta, acts);
  box.addEventListener("click", (e) => e.stopPropagation());
  sync();
  setTimeout(() => ta.focus({ preventScroll: false }), 0);
  return box;
}

function commentCard(c: ReviewComment, store: ReviewStore, moved = false): HTMLElement {
  const card = el("div", "rv-comment");
  card.addEventListener("click", (e) => e.stopPropagation());
  const show = () => {
    card.textContent = "";
    if (moved) {
      const m = el("div", "rv-moved");
      m.textContent = `${c.line != null ? `Line ${c.line} · ` : ""}moved — ${c.code.slice(1).trim().slice(0, 80)}`;
      card.append(m);
    }
    const t = el("div", "rv-text");
    t.textContent = c.text;
    const acts = el("div", "rv-acts");
    const edit = el("button", "rv-btn ghost") as HTMLButtonElement;
    edit.textContent = "Edit";
    edit.addEventListener("click", (e) => {
      e.stopPropagation();
      card.textContent = "";
      card.append(
        editor(
          c.text,
          (text) => {
            store.update(c.id, text);
            c.text = text;
            show();
          },
          show
        )
      );
    });
    const del = el("button", "rv-btn ghost danger") as HTMLButtonElement;
    del.textContent = "Delete";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      store.remove(c.id);
      card.remove();
    });
    acts.append(edit, del);
    card.append(t, acts);
  };
  show();
  return card;
}

/**
 * A diff as commentable rows. `numbered` = the diff has real hunk headers /
 * line numbers (git); false for reconstructed edits, where only the text is
 * quoted.
 */
export function renderReviewDiff(diff: string, file: string, store: ReviewStore, numbered = true): HTMLElement {
  const wrap = el("div", "rv-diff");
  const rows = parseDiffRows(diff);
  const rowEls: { row: Row; elx: HTMLElement }[] = [];
  for (const row of rows) {
    const r = el("div", `rv-row ${row.kind}`);
    const ln = el("span", "rv-ln");
    if (numbered) ln.textContent = row.kind === "del" ? String(row.oldLn ?? "") : String(row.newLn ?? "");
    const code = el("span", "rv-code");
    code.textContent = row.code || " ";
    r.append(ln, code);
    if (row.kind !== "hunk") {
      r.title = "Comment on this line";
      r.tabIndex = 0;
      const open = () => {
        const next = r.nextElementSibling;
        if (next?.classList.contains("rv-editor")) return (next.querySelector("textarea") as HTMLTextAreaElement).focus();
        const line = numbered ? (row.kind === "del" ? row.oldLn : row.newLn) : null;
        const ed = editor(
          "",
          (text) => {
            const c = store.add({ file, line, side: row.kind === "del" ? "old" : "new", code: row.code, text });
            ed.replaceWith(commentCard(c, store));
          },
          () => ed.remove()
        );
        r.after(ed);
      };
      r.addEventListener("click", (e) => {
        e.stopPropagation();
        if (window.getSelection()?.toString()) return; // selecting text, not commenting
        open();
      });
      r.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          open();
        }
      });
    }
    wrap.append(r);
    rowEls.push({ row, elx: r });
  }

  // Re-attach saved comments: same line + same text, else same text, else "moved".
  const lastAfter = new Map<HTMLElement, HTMLElement>(); // keep several comments on one line in order
  for (const c of store.forFile(file)) {
    const lnOf = (row: Row) => (c.side === "old" ? row.oldLn : row.newLn);
    const hit =
      rowEls.find(({ row }) => row.kind !== "hunk" && row.code === c.code && (c.line == null || lnOf(row) === c.line)) ||
      rowEls.find(({ row }) => row.kind !== "hunk" && row.code === c.code);
    if (hit) {
      const anchor = lastAfter.get(hit.elx) || hit.elx;
      const card = commentCard(c, store);
      anchor.after(card);
      lastAfter.set(hit.elx, card);
    } else wrap.append(commentCard(c, store, true));
  }
  return wrap;
}

/** The message a review becomes: one numbered item per comment, file:line + the quoted line. */
export function reviewMessage(comments: ReviewComment[], note = ""): string {
  const byFile = new Map<string, ReviewComment[]>();
  for (const c of comments) {
    if (!byFile.has(c.file)) byFile.set(c.file, []);
    byFile.get(c.file)!.push(c);
  }
  const out: string[] = [
    `Review of your changes — please address ${comments.length === 1 ? "this comment" : `these ${comments.length} comments`}:`,
  ];
  if (note.trim()) out.push("", note.trim());
  let i = 0;
  for (const [file, list] of byFile) {
    list.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
    for (const c of list) {
      i++;
      const where = c.line == null ? file : c.side === "old" ? `${file} (removed line ${c.line})` : `${file}:${c.line}`;
      const code = c.code.slice(1).trim();
      out.push("", `${i}. ${where}`);
      if (code) out.push(`   \`${code.replace(/`/g, "'").slice(0, 200)}\``);
      out.push(...c.text.split("\n").map((l) => `   ${l}`));
    }
  }
  return out.join("\n");
}

/** The bar at the bottom of the panel: count, optional overall note, Discard, Send review. */
export function reviewBar(store: ReviewStore, send: (text: string) => void, onDone: (sent: boolean) => void): HTMLElement {
  const bar = el("div", "rv-bar");
  const top = el("div", "rv-bar-row");
  const count = el("span", "rv-count");
  const discard = el("button", "rv-btn ghost") as HTMLButtonElement;
  discard.textContent = "Discard";
  const go = el("button", "rv-btn primary") as HTMLButtonElement;
  go.textContent = "Send review";
  const note = document.createElement("textarea");
  note.className = "rv-note";
  note.rows = 1;
  note.placeholder = "Overall note (optional)";
  note.addEventListener("keydown", (e) => e.stopPropagation());
  top.append(count, discard, go);
  bar.append(note, top);
  const sync = () => {
    const n = store.count;
    bar.hidden = n === 0;
    count.textContent = `${n} comment${n === 1 ? "" : "s"}`;
  };
  discard.addEventListener("click", () => {
    if (!confirm(`Discard ${store.count} review comment${store.count === 1 ? "" : "s"}?`)) return;
    store.clear();
    note.value = "";
    onDone(false); // re-render without them
  });
  go.addEventListener("click", () => {
    if (!store.count) return;
    send(reviewMessage(store.all(), note.value));
    store.clear();
    note.value = "";
    onDone(true);
  });
  store.onChange(sync);
  sync();
  return bar;
}
