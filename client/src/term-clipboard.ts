/**
 * Copy and paste for TERMINAL panes on a phone (the soft-key row's Copy /
 * Paste, terminal.ts). A phone has neither ⌘C/⌘V nor a usable text selection
 * in the terminal — tmux owns touches (`mouse on`, see pty-manager) — so:
 *
 *  - Paste: the async clipboard (iOS asks with its own "Paste" bubble). If
 *    that's refused or unavailable, a sheet with a text box you long-press →
 *    Paste into, then "Paste into terminal". Text goes through xterm's
 *    paste(), so a shell or Claude Code in bracketed-paste mode gets it as ONE
 *    paste (newlines don't each press Enter).
 *  - Copy: the pane's recent text, scrollback included (GET
 *    /api/panes/:id/text = tmux capture-pane), as plain selectable lines. Tap
 *    a line to copy it — the usual need is one code/URL/command — or Copy all,
 *    or select freely with the normal iOS handles.
 *
 * Reuses the inbox drawer/sheet styles. All text via textContent.
 */
import { el } from "./chat-steps";

let panel: HTMLElement | null = null;
let titleEl: HTMLElement;
let body: HTMLElement;

function sheet(title: string) {
  if (!panel) {
    panel = el("div", "inbox term-clip");
    panel.setAttribute("role", "dialog");
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
  titleEl.textContent = title;
  panel.setAttribute("aria-label", title);
  body.textContent = "";
  panel.hidden = false;
  return body;
}

function close() {
  if (panel) panel.hidden = true;
}

function flash(btn: HTMLElement, text: string) {
  const was = btn.textContent;
  btn.textContent = text;
  setTimeout(() => (btn.textContent = was), 1200);
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older WebKit: the execCommand fallback (inside the tap, so it's allowed).
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

/** The Copy sheet: recent terminal text, tap a line to copy it. */
export async function openCopySheet(paneId: string, name: string) {
  const b = sheet(`Copy from ${name}`);
  const note = el("div", "sched-intro");
  note.textContent = "Tap a line to copy it, or press and hold to select any text.";
  const all = el("button", "ib primary") as HTMLButtonElement;
  all.textContent = "Copy all";
  const lines = el("div", "term-clip-lines");
  lines.textContent = "Loading…";
  b.append(note, all, lines);
  let text = "";
  try {
    const r = await fetch(`/api/panes/${encodeURIComponent(paneId)}/text?lines=400`);
    if (r.status === 404 && !(r.headers.get("content-type") || "").includes("json")) throw new Error("This needs a server restart to work.");
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || "Couldn't read the terminal.");
    text = String(j.text || "");
  } catch (e) {
    lines.textContent = (e as Error).message;
    return;
  }
  lines.textContent = "";
  for (const line of text.split("\n")) {
    const row = el("div", "term-clip-line");
    row.textContent = line || " ";
    if (line.trim()) {
      row.addEventListener("click", async () => {
        // A tap copies the line; a selection drag shouldn't.
        if (String(window.getSelection() || "").length) return;
        if (await copyText(line.trim())) {
          row.classList.add("copied");
          setTimeout(() => row.classList.remove("copied"), 1000);
        }
      });
    }
    lines.append(row);
  }
  all.addEventListener("click", async () => flash(all, (await copyText(text)) ? "Copied" : "Couldn't copy"));
  // The newest output is at the bottom — start there.
  requestAnimationFrame(() => (b.scrollTop = b.scrollHeight));
}

/**
 * Paste: the clipboard straight in when iOS allows it, else a box to paste
 * into. `paste` hands the text to the terminal (xterm's paste()).
 */
export async function pasteInto(paste: (text: string) => void, name: string) {
  try {
    const text = await navigator.clipboard.readText();
    if (text) {
      paste(text);
      return;
    }
  } catch {}
  const b = sheet(`Paste into ${name}`);
  const note = el("div", "sched-intro");
  note.textContent = "Press and hold in the box, choose Paste, then send it to the terminal.";
  const box = document.createElement("textarea");
  box.className = "term-clip-box";
  box.rows = 6;
  box.setAttribute("autocapitalize", "off");
  box.setAttribute("autocorrect", "off");
  box.spellcheck = false;
  const send = el("button", "ib primary") as HTMLButtonElement;
  send.textContent = "Paste into terminal";
  send.addEventListener("click", () => {
    if (!box.value) return;
    paste(box.value);
    close();
  });
  b.append(note, box, send);
  box.focus();
}
