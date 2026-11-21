/**
 * Phone: move between panes without going back (moved out of main.ts).
 *
 * On a phone an open pane fills the screen, and getting to the next one used
 * to mean ‹ back to the list, find it, tap. Two ways round that, both only
 * while a pane is open on a phone:
 *   · swipe left/right on the pane → next/previous pane;
 *   · the "3/12 ⌄" button in its title → a sheet of every session, the ones
 *     that need you first, one tap to switch.
 * Swipe order is the GRID order, deliberately not the list's attention order:
 * opening a pane clears its attention, which would re-sort the list under
 * your thumb mid-swipe.
 *
 * main.ts owns the state (which pane is open, the grid, the attention queue)
 * and hands it over through initPhoneNav(); everything here reads it through
 * `d`, so there is one source of truth.
 */
import type { PaneView } from "./terminal";
import { displayName } from "./terminal";

export type PhoneNavDeps = {
  grid: HTMLElement;
  panes: Map<string, PaneView>;
  minimized: Set<string>;
  queue: string[];
  mobileQuery: MediaQueryList;
  zoomed: () => PaneView | null;
  setZoomed: (t: PaneView) => void;
  zoom: (t: PaneView) => void;
  unzoom: () => void;
  restore: (id: string) => void;
  clearAttention: (id: string) => void;
  setRect: (el: HTMLElement, r: { left: number; top: number; width: number; height: number }) => void;
  centerRect: () => DOMRect;
  syncBarHeightVar: () => void;
};

let d!: PhoneNavDeps;

/** Wire it up — call once, before any pane is added. */
export function initPhoneNav(deps: PhoneNavDeps) {
  d = deps;
  wireSwipe();
}

/** body.pane-open hides #bar on phones (CSS); keep --bar-h and friends in step. */
export function setPaneOpen(on: boolean) {
  document.body.classList.toggle("pane-open", on);
  d.syncBarHeightVar();
}

/** Panes you can swipe between: everything on the grid (not minimized), in grid order. */
function swipeOrder(): PaneView[] {
  return [...d.grid.children]
    .map((c) => d.panes.get((c as HTMLElement).dataset.id || ""))
    .filter((t): t is PaneView => !!t && !d.minimized.has(t.id));
}

/** Swap the open pane for another, with a short slide in the swipe's direction. */
export function switchTo(t: PaneView, dir: 1 | -1 | 0): void {
  const old = d.zoomed();
  if (!old) return d.zoom(t);
  if (old === t) return;
  closePaneSheet();
  if (d.minimized.has(t.id)) d.restore(t.id);
  old.el.style.transition = "none";
  old.el.classList.remove("zoomed", "slide-l", "slide-r");
  old.el.removeAttribute("style");
  old.refit();
  d.setZoomed(t);
  d.clearAttention(t.id);
  const el = t.el;
  el.style.transition = "none";
  el.classList.add("zoomed");
  d.setRect(el, d.centerRect());
  el.classList.remove("slide-l", "slide-r");
  if (dir) {
    void el.offsetWidth; // restart the animation
    el.classList.add(dir > 0 ? "slide-l" : "slide-r");
  }
  t.refit();
  updateSwitchers();
}

function stepPane(dir: 1 | -1) {
  const zoomed = d.zoomed();
  if (!zoomed) return;
  const list = swipeOrder();
  const i = list.indexOf(zoomed);
  const next = list[i + dir];
  if (next) switchTo(next, dir);
  else zoomed.el.animate([{ transform: "translateX(0)" }, { transform: `translateX(${-dir * 18}px)` }, { transform: "translateX(0)" }], { duration: 220 });
}

/** True if the touch began inside something that scrolls sideways (code, tables, chips). */
function inHorizontalScroller(node: Element | null, stop: Element): boolean {
  for (let n = node; n && n !== stop; n = n.parentElement) {
    if (n.scrollWidth > n.clientWidth + 2) {
      const ox = getComputedStyle(n).overflowX;
      if (ox === "auto" || ox === "scroll") return true;
    }
  }
  return false;
}

let swipe: { x: number; y: number; t: number } | null = null;
function wireSwipe() {
document.addEventListener(
  "touchstart",
  (e) => {
    swipe = null;
    const zoomed = d.zoomed();
    if (!zoomed || !d.mobileQuery.matches || e.touches.length !== 1) return;
    const target = e.target as Element;
    if (!zoomed.el.contains(target)) return;
    if (target.closest("textarea, input, select, .chat-dock, .cmd-menu, .plus-menu, .spop, .lightbox")) return;
    // A terminal box's body is xterm/tmux's own touch surface; there the
    // swipe only works on the title strip above it.
    if (target.closest(".xt") || inHorizontalScroller(target, zoomed.el)) return;
    swipe = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() };
  },
  { passive: true }
);
document.addEventListener(
  "touchend",
  (e) => {
    const s = swipe;
    swipe = null;
    if (!s || !d.zoomed() || !e.changedTouches.length) return;
    const dx = e.changedTouches[0].clientX - s.x;
    const dy = e.changedTouches[0].clientY - s.y;
    if (Date.now() - s.t > 700 || Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.8) return;
    if (window.getSelection()?.toString()) return; // they were selecting text
    stepPane(dx < 0 ? 1 : -1);
  },
  { passive: true }
);
}

/**
 * Two-line title for the phone header: the name, and under it where the
 * session lives — prefixed by its state ("Working · ", "Needs you · ") purely
 * in CSS off the box's own .busy/.waiting classes, so nothing has to keep it
 * in sync. Desktop hides the second line.
 */
export function addTitleSubline(t: PaneView) {
  const path = t.titleBar.querySelector(".path");
  if (!path || path.parentElement?.classList.contains("title-text")) return;
  const wrap = document.createElement("span");
  wrap.className = "title-text";
  path.before(wrap);
  const sub = document.createElement("span");
  sub.className = "pane-sub";
  const parts = (t.info.cwd || "").split("/").filter(Boolean);
  sub.textContent = parts.length > 2 ? parts.slice(-2).join("/") : t.info.cwd || "";
  sub.title = t.info.cwd || "";
  wrap.append(path, sub);
}

/** The "3/12 ⌄" control, added to every box's title bar; CSS shows it only on an open pane on a phone. */
export function addSwitcherButton(t: PaneView) {
  const b = document.createElement("button");
  b.className = "ctl pane-switch";
  b.title = "Switch session";
  b.setAttribute("aria-label", "Switch session");
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    openPaneSheet();
  });
  b.addEventListener("pointerdown", (e) => e.stopPropagation());
  const anchor = t.titleBar.querySelector(".spacer");
  if (anchor) anchor.before(b);
  else t.titleBar.append(b);
}

export function updateSwitchers() {
  const zoomed = d.zoomed();
  if (!zoomed) return;
  const list = swipeOrder();
  const i = list.indexOf(zoomed);
  const b = zoomed.titleBar.querySelector(".pane-switch") as HTMLElement | null;
  if (!b) return;
  const open = zoomed;
  const waiting = d.queue.filter((id) => id !== open.id).length;
  b.textContent = "";
  const n = document.createElement("span");
  n.textContent = i >= 0 ? `${i + 1}/${list.length}` : `${list.length}`;
  b.append(n);
  if (waiting) {
    const w = document.createElement("span");
    w.className = "pane-switch-waiting";
    w.textContent = String(waiting);
    w.title = `${waiting} other session${waiting === 1 ? "" : "s"} waiting for a look`;
    b.append(w);
  }
  b.insertAdjacentHTML("beforeend", `<svg class="ico-svg" viewBox="0 0 24 24" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>`);
}

let paneSheet: HTMLElement | null = null;
export function closePaneSheet() {
  if (paneSheet) paneSheet.hidden = true;
}
/** The session switcher: every pane, needs-you first, then working, then the rest (grid order within each). */
function openPaneSheet() {
  if (!paneSheet) {
    paneSheet = document.createElement("div");
    paneSheet.id = "paneSheet";
    paneSheet.addEventListener("click", (e) => {
      if (e.target === paneSheet) closePaneSheet();
    });
    document.body.append(paneSheet);
  }
  const sheet = paneSheet;
  sheet.textContent = "";
  const panel = document.createElement("div");
  panel.className = "sheet-panel";
  const head = document.createElement("div");
  head.className = "sheet-head";
  const title = document.createElement("span");
  title.textContent = "Sessions";
  const all = document.createElement("button");
  all.className = "sheet-all";
  all.textContent = "All boxes";
  all.addEventListener("click", () => d.unzoom());
  head.append(title, all);
  panel.append(head);

  const rank = (t: PaneView) =>
    t.isWaiting() ? { question: 0, aborted: 1, done: 2 }[t.waitingKind()] : t.el.classList.contains("busy") ? 3 : 4;
  const list = swipeOrder()
    .map((t, i) => ({ t, i }))
    .sort((a, b) => rank(a.t) - rank(b.t) || a.i - b.i)
    .map((x) => x.t);
  const rows = document.createElement("div");
  rows.className = "sheet-rows";
  for (const t of list) {
    const row = document.createElement("button");
    const state = t.isWaiting() ? t.waitingKind() : t.el.classList.contains("busy") ? "busy" : "idle";
    row.className = `sheet-row ${state}` + (t === d.zoomed() ? " current" : "");
    const dot = document.createElement("span");
    dot.className = "sheet-dot";
    const text = document.createElement("span");
    text.className = "sheet-text";
    const name = document.createElement("span");
    name.className = "sheet-name";
    name.textContent = displayName(t.info);
    const sub = document.createElement("span");
    sub.className = "sheet-sub";
    sub.textContent =
      state === "question" ? "Needs you" : state === "aborted" ? "Cut off" : state === "done" ? "Done" : state === "busy" ? "Working…" : (t.info.lastInput || "").replace(/\s+/g, " ").trim() || t.info.cwd;
    text.append(name, sub);
    const kind = document.createElement("span");
    kind.className = "sheet-kind";
    kind.textContent = t.info.kind === "agent" ? "chat" : "terminal";
    row.append(dot, text, kind);
    row.addEventListener("click", () => {
      closePaneSheet();
      if (d.zoomed()) switchTo(t, 0);
      else d.zoom(t);
    });
    rows.append(row);
  }
  panel.append(rows);
  sheet.append(panel);
  sheet.hidden = false;
}

