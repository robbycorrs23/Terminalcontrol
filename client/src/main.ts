import { Term, PaneInfo, PaneView, TermHost, displayName } from "./terminal";
import { AgentChat } from "./agent-chat";
import { play } from "./sound";
import { setTabAttention } from "./tab";
import { initTasks, applyRemoteTasks, closeTasksIfOpen } from "./tasks";
import { getAppearance, setAppearance, xtermTheme, xtermFontSize } from "./theme";

const grid = document.getElementById("grid")!;
const scrim = document.getElementById("scrim")!;
const tray = document.getElementById("tray")!;
const queueEl = document.getElementById("queue")!;
const followupsEl = document.getElementById("followups")!;
const recoveryEl = document.getElementById("recovery")!;
const nextBtn = document.getElementById("nextBtn") as HTMLButtonElement;
const layoutSel = document.getElementById("layoutSel") as HTMLSelectElement;

// This browser window's workspace id. sessionStorage is per-window and survives
// refresh, so a refresh reconnects to the same terminals but a NEW window starts
// its own empty workspace — letting different windows hold different layouts.
// A `?session=` URL param joins an EXISTING workspace instead (e.g. copy the
// address bar from one device to another to see the same live terminals there);
// we also mirror the id back into the URL so any open window's link is always
// copyable, not just ones that arrived via a shared link.
const SESSION = (() => {
  const params = new URLSearchParams(location.search);
  let s = params.get("session") || sessionStorage.getItem("fleet-session");
  if (!s) s = (crypto.randomUUID?.() || String(Math.random()).slice(2)) as string;
  sessionStorage.setItem("fleet-session", s);
  if (params.get("session") !== s) {
    params.set("session", s);
    history.replaceState(null, "", `${location.pathname}?${params}`);
  }
  return s;
})();

const currentEl = document.getElementById("current")!;

type DormantInfo = PaneInfo & { sessionAlive?: boolean };

const panes = new Map<string, PaneView>();
const queue: string[] = []; // pane ids waiting on the user, in arrival order
const minimized = new Set<string>(); // pane ids currently in the tray
const flagged = new Set<string>(); // pane ids marked for follow-up
// Terminals whose tmux session died or was set aside (Replace). Kept here so the
// user can bring them back instead of losing them — they show as recovery chips.
const dormant = new Map<string, DormantInfo>();
let zoomed: PaneView | null = null;
let suppressNextOpen = false; // set after a drag so the trailing click doesn't zoom
let currentLayout: string | null = sessionStorage.getItem("fleet-current-layout");

// ---- Host callbacks for each Term -------------------------------------
const host: TermHost = {
  onOpen: (t) => {
    if (suppressNextOpen) return;
    zoom(t);
  },
  onBack: (t) => {
    if (zoomed === t) unzoom();
  },
  onClose: (t) => {
    // The ✕ on the focused (zoomed) box closes the modal view, not the terminal —
    // killing a shell you just zoomed into is rarely what you meant. From the grid
    // the same ✕ still closes (kills) the terminal.
    if (zoomed === t) {
      unzoom();
      return;
    }
    closeTerm(t.id);
  },
  onMinimize: (t) => minimize(t),
  onToggleFollowUp: (t) => {
    const on = !t.isFlagged();
    t.setFollowUp(on); // optimistic; server broadcast confirms
    setFlagged(t.id, on);
    fetch(`/api/panes/${t.id}/followup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ on }),
    });
  },
  onSetColor: (t, color) => {
    // The box already applied the tint optimistically; persist + sync to others.
    fetch(`/api/panes/${t.id}/color`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ color }),
    });
  },
  onRename: (t, name) => {
    // The box already shows the new name optimistically; refresh the chips that
    // show it too, then persist + sync to other windows.
    renderTray();
    renderQueue();
    renderFollowups();
    fetch(`/api/panes/${t.id}/name`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
  },
};

// ---- Grid -------------------------------------------------------------
function addTerm(info: PaneInfo): PaneView {
  const existing = panes.get(info.id);
  if (existing) return existing;
  const t = info.kind === "agent" ? new AgentChat(info, host) : new Term(info, host);
  panes.set(info.id, t);
  t.cell.dataset.id = info.id; // lets us read grid order for layout autosave
  grid.append(t.cell);
  enableDrag(t);
  reflow();
  if (info.attention?.waiting) enqueue(info.id, info.attention.kind || "question");
  if (info.followUp) setFlagged(info.id, true);
  return t;
}

function removeTerm(id: string) {
  const t = panes.get(id);
  if (!t) return;
  if (zoomed === t) unzoom();
  t.dispose();
  panes.delete(id);
  minimized.delete(id);
  flagged.delete(id);
  renderFollowups();
  dequeue(id);
  renderTray();
  reflow();
}

async function closeTerm(id: string) {
  await fetch(`/api/panes/${id}`, { method: "DELETE" });
  removeTerm(id);
}

// Square-ish auto grid based on how many cells are actually in the grid
// (minimized ones are pulled out, so they don't count). On narrow screens we
// switch to one full-height terminal per "page" (scroll for the next) instead
// — see the (max-width: 640px) rules in styles.css for the row sizing.
const mobileQuery = matchMedia("(max-width: 640px)");
function reflow() {
  const n = Math.max(grid.children.length, 1);
  const cols = mobileQuery.matches ? 1 : Math.ceil(Math.sqrt(n));
  grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  for (const t of panes.values()) if (!minimized.has(t.id)) t.refit();
  reflowMobileOrder();
}

// Mobile-only visual ordering: terminals needing you float to the top of the
// scroll stack (question > done > idle), stable otherwise. Pure presentation —
// doesn't touch the underlying grid order that drag-to-reorder persists, so
// desktop layouts and saved layouts are unaffected.
function reflowMobileOrder() {
  for (const t of panes.values()) {
    t.cell.style.order = mobileQuery.matches
      ? String(t.isWaiting() ? (t.waitingKind() === "done" ? 1 : 0) : 2)
      : "";
  }
}
mobileQuery.addEventListener("change", reflow);

// ---- Minimize / tray --------------------------------------------------
function minimize(t: PaneView) {
  if (zoomed === t) unzoom();
  if (minimized.has(t.id)) return;
  t.cell.remove();
  minimized.add(t.id);
  renderTray();
  reflow();
}

function restore(id: string) {
  const t = panes.get(id);
  if (!t || !minimized.has(id)) return;
  minimized.delete(id);
  grid.append(t.cell);
  renderTray();
  reflow();
  persistOrder();
  t.refit();
}

// Tell the server this window's current grid order (grid first, then minimized),
// so a refresh — which rebuilds from the server snapshot — keeps the arrangement.
function persistOrder() {
  const ordered = [...grid.children].map((c) => (c as HTMLElement).dataset.id!).filter(Boolean);
  const rest = [...minimized].filter((id) => !ordered.includes(id));
  fetch("/api/order", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session: SESSION, ids: [...ordered, ...rest] }),
  });
}

function renderTray() {
  tray.innerHTML = "";
  if (minimized.size === 0) {
    tray.hidden = true;
    return;
  }
  tray.hidden = false;
  const label = document.createElement("span");
  label.className = "tray-label";
  label.textContent = "Minimized:";
  tray.append(label);
  for (const id of minimized) {
    const t = panes.get(id);
    if (!t) continue;
    const chip = document.createElement("div");
    chip.className =
      "tchip" + (t.isWaiting() ? " waiting" + (t.waitingKind() === "done" ? " done" : "") : "");
    chip.innerHTML = `<span class="tname"></span><span class="tclose" title="Close">✕</span>`;
    (chip.querySelector(".tname") as HTMLElement).textContent = displayName(t.info);
    chip.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).classList.contains("tclose")) {
        e.stopPropagation();
        closeTerm(id);
      } else {
        restore(id);
      }
    });
    tray.append(chip);
  }
}

// ---- Zoom to center (animated) ----------------------------------------
function zoom(t: PaneView) {
  if (minimized.has(t.id)) restore(t.id);
  if (zoomed === t) return;
  if (zoomed) unzoom();
  zoomed = t;
  clearAttention(t.id);

  const el = t.el;
  const start = t.cell.getBoundingClientRect();

  el.style.transition = "none";
  el.classList.add("zoomed");
  setRect(el, start);
  scrim.hidden = false;
  void el.getBoundingClientRect(); // force reflow so the next change animates

  el.style.transition =
    "top .28s cubic-bezier(.2,.8,.2,1), left .28s cubic-bezier(.2,.8,.2,1)," +
    " width .28s cubic-bezier(.2,.8,.2,1), height .28s cubic-bezier(.2,.8,.2,1)";
  setRect(el, centerRect());
  onceTransitionEnd(el, () => {
    t.refit();
    t.focusTerm();
  });
}

function unzoom() {
  const t = zoomed;
  if (!t) return;
  zoomed = null;
  const el = t.el;
  setRect(el, t.cell.getBoundingClientRect());
  scrim.hidden = true;
  onceTransitionEnd(el, () => {
    el.classList.remove("zoomed");
    el.removeAttribute("style"); // back to CSS-driven inset:0 in its cell
    t.refit();
  });
}

// `visualViewport` (not innerWidth/innerHeight) is what actually shrinks when
// the on-screen keyboard opens on mobile — innerHeight stays the full-screen
// value, so sizing off it would let the keyboard cover the bottom of a zoomed
// terminal (including the prompt you're typing into). On mobile we also skip
// the floating-card margins entirely and go edge-to-edge: a phone screen is
// too small to spare for a decorative border.
// Keeps --bar-h in sync with #bar's real rendered height, for CSS (#tasks'
// `top`) that can't use `top: 100%` the way #barMenu does because #tasks is
// `position: fixed`, not a child of #bar. #bar's height isn't a fixed 40px —
// env(safe-area-inset-top) (notch/Dynamic Island) and the mobile touch-target
// button sizing both add to it — so a static px in CSS drifts out of sync per
// device/orientation the same way centerRect()'s barH read below has to be
// live rather than a constant.
function syncBarHeightVar() {
  const barH = document.getElementById("bar")?.offsetHeight ?? 40;
  document.documentElement.style.setProperty("--bar-h", `${barH}px`);
}
syncBarHeightVar();

function centerRect(): DOMRect {
  const vv = window.visualViewport;
  const vw = vv?.width ?? innerWidth;
  const vh = vv?.height ?? innerHeight;
  const vx = vv?.offsetLeft ?? 0;
  const vy = vv?.offsetTop ?? 0;
  if (mobileQuery.matches) {
    // "Edge-to-edge" means filling everything below FleetView's own #bar, not
    // literally y:0 — #bar is a normal in-flow element (not fixed) with a
    // higher z-index than a zoomed terminal, so a rect starting at y:0 would
    // render the terminal's own title bar hidden underneath it.
    const barH = document.getElementById("bar")?.offsetHeight ?? 0;
    return new DOMRect(vx, vy + barH, vw, vh - barH);
  }
  // No fixed max width: on a normal laptop 92% is already under any sane cap,
  // but a hardcoded px cap (there used to be one at 1200) means a zoomed
  // terminal stays pinned to that same width regardless of screen size — on
  // a wide/HiDPI monitor that reads as "stuck in a small fraction of the
  // screen." A terminal benefits from width (wide diffs, long lines, tables)
  // the way prose doesn't, so there's no readability reason to cap it either.
  const w = vw * 0.92;
  const h = vh * 0.86;
  return new DOMRect(vx + (vw - w) / 2, vy + (vh - h) / 2 + 20, w, h);
}
function setRect(el: HTMLElement, r: { left: number; top: number; width: number; height: number }) {
  el.style.left = r.left + "px";
  el.style.top = r.top + "px";
  el.style.width = r.width + "px";
  el.style.height = r.height + "px";
}
function onceTransitionEnd(el: HTMLElement, fn: () => void) {
  let done = false;
  const run = (e?: TransitionEvent) => {
    if (e && e.target !== el) return;
    if (done) return;
    done = true;
    el.removeEventListener("transitionend", run as EventListener);
    fn();
  };
  el.addEventListener("transitionend", run as EventListener);
  setTimeout(run, 360);
}

scrim.addEventListener("click", unzoom);
addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  const om = document.getElementById("openmode") as HTMLElement;
  if (!picker.hidden) closePicker();
  else if (om && !om.hidden) om.hidden = true;
  else if (closeTasksIfOpen()) {
    /* closed the task sidebar */
  } else if (zoomed) unzoom();
});
addEventListener("resize", () => {
  syncBarHeightVar();
  if (zoomed) setRect(zoomed.el, centerRect());
  reflow();
});
// Mobile Safari fires visualViewport resize (not always window resize) when the
// on-screen keyboard opens/closes, shrinking the usable area without changing
// innerHeight — without this, a zoomed terminal's fit()/rect can end up wrong
// (partly hidden behind the keyboard) until something else forces a reflow.
function onVisualViewportChange() {
  if (zoomed) {
    setRect(zoomed.el, centerRect());
    zoomed.refit();
  }
  reflow();
}
// `resize` catches the keyboard opening/closing (height change); `scroll`
// catches iOS panning the page to keep the focused input above the keyboard
// (can fire without a resize) — both need the zoomed rect recomputed.
window.visualViewport?.addEventListener("resize", onVisualViewportChange);
window.visualViewport?.addEventListener("scroll", onVisualViewportChange);

// ---- Drag to reorder --------------------------------------------------
let dropTarget: HTMLElement | null = null;
let dropAfter = false; // insert after (vs before) the drop target

function enableDrag(t: PaneView) {
  t.titleBar.addEventListener("pointerdown", (e) => {
    if ((e.target as HTMLElement).closest(".ctl")) return; // controls aren't a handle
    // On mobile a title bar IS a row in the list — a touch-drag there is meant
    // to scroll the list, not reorder it (and reflowMobileOrder() already
    // handles needs-you ordering automatically), so don't hijack the gesture.
    if (mobileQuery.matches) return;
    if (e.button !== 0 || zoomed) return;
    const startX = e.clientX;
    const startY = e.clientY;
    let dragging = false;
    let offX = 0;
    let offY = 0;

    const onMove = (ev: PointerEvent) => {
      if (!dragging) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 6) return;
        dragging = true;
        const r = t.cell.getBoundingClientRect();
        offX = startX - r.left;
        offY = startY - r.top;
        t.el.classList.add("dragging");
        setRect(t.el, r);
      }
      setRect(t.el, {
        left: ev.clientX - offX,
        top: ev.clientY - offY,
        width: t.el.offsetWidth,
        height: t.el.offsetHeight,
      });
      setDropTarget(dropSlot(ev, t));
    };

    const onUp = (ev: PointerEvent) => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      if (!dragging) return;
      const target = dropTarget;
      const after = dropAfter;
      setDropTarget(null);
      t.el.classList.remove("dragging");
      t.el.removeAttribute("style");
      if (target && target !== t.cell) {
        if (after) target.after(t.cell);
        else target.before(t.cell);
        reflow();
        persistOrder(); // remember the order for this window across refreshes
        autosaveLayout(); // and, if this window is a layout, save it there too
      }
      t.refit();
      suppressNextOpen = true;
      setTimeout(() => (suppressNextOpen = false), 0);
    };

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  });
}

// The cell to drop next to: the one whose center is nearest the cursor. Nearest-
// cell (rather than requiring the cursor to land exactly on a cell via
// elementFromPoint) makes dragging across rows reliable — gaps and the floating
// drag box no longer block the drop. Also sets `dropAfter` (left/right of center).
function dropSlot(ev: PointerEvent, t: PaneView): HTMLElement | null {
  let best: HTMLElement | null = null;
  let bestDist = Infinity;
  for (const child of grid.children) {
    const cell = child as HTMLElement;
    if (cell === t.cell) continue;
    const r = cell.getBoundingClientRect();
    const dx = ev.clientX - (r.left + r.width / 2);
    const dy = ev.clientY - (r.top + r.height / 2);
    const dist = Math.hypot(dx, dy);
    if (dist < bestDist) {
      bestDist = dist;
      best = cell;
    }
  }
  if (best) {
    const r = best.getBoundingClientRect();
    dropAfter = ev.clientX > r.left + r.width / 2;
  }
  return best;
}

function setDropTarget(cell: HTMLElement | null) {
  if (dropTarget === cell) return;
  dropTarget?.classList.remove("drop-target");
  dropTarget = cell;
  dropTarget?.classList.add("drop-target");
}

// ---- Attention queue --------------------------------------------------
function onAttention(id: string, kind: "question" | "done") {
  const t = panes.get(id);
  if (!t) return;
  if (zoomed === t) return; // you're already looking at it
  t.setWaiting(true, kind);
  if (minimized.has(id)) renderTray();
  enqueue(id, kind);
  play(kind);
}

function enqueue(id: string, _kind: "question" | "done") {
  if (!queue.includes(id)) queue.push(id);
  renderQueue();
}
function dequeue(id: string) {
  const i = queue.indexOf(id);
  if (i >= 0) queue.splice(i, 1);
  renderQueue();
}
function setCleared(id: string) {
  panes.get(id)?.setWaiting(false);
  if (minimized.has(id)) renderTray();
  dequeue(id);
}
function clearAttention(id: string) {
  const t = panes.get(id);
  if (!t || !t.isWaiting()) return;
  fetch(`/api/panes/${id}/clear`, { method: "POST" });
  setCleared(id);
}
function renderQueue() {
  reflowMobileOrder();
  queueEl.innerHTML = "";
  for (const id of queue) {
    const t = panes.get(id);
    const chip = document.createElement("span");
    const kind = t?.waitingKind() === "done" ? "done" : "question";
    chip.className = "qchip" + (kind === "done" ? " done" : "");
    chip.textContent = t ? displayName(t.info) : id;
    chip.onclick = () => t && zoom(t);
    queueEl.append(chip);
  }
  nextBtn.hidden = queue.length === 0;

  // Mirror the waiting state in the browser tab (title + favicon dot) so it's
  // visible even when FleetView isn't the focused tab. queue[0] is the oldest
  // waiter — the same one "Jump to next" goes to.
  const head = queue[0] ? panes.get(queue[0]) : undefined;
  setTabAttention(
    queue.length,
    head ? displayName(head.info) : "",
    head ? head.waitingKind() : null
  );
}
nextBtn.onclick = () => {
  const t = queue[0] && panes.get(queue[0]);
  if (t) zoom(t);
};

function setFlagged(id: string, on: boolean) {
  if (on) flagged.add(id);
  else flagged.delete(id);
  renderFollowups();
}

function renderFollowups() {
  followupsEl.innerHTML = "";
  for (const id of flagged) {
    const t = panes.get(id);
    if (!t) continue;
    const chip = document.createElement("span");
    chip.className = "fchip";
    chip.textContent = displayName(t.info);
    chip.title = "Follow-up — click to jump";
    chip.onclick = () => zoom(t);
    followupsEl.append(chip);
  }
}

// ---- Recovery (dormant terminals) -------------------------------------
// A pane becomes dormant when its tmux session dies (crash / long system sleep)
// or when a layout "Replace" sets it aside. We never silently drop it: it shows
// as a recovery chip so its terminal can be brought back. Chips that were merely
// set aside (sessionAlive) restore the live Claude session intact; ones whose
// session died respawn a fresh shell in the same folder.
function markDormant(info: DormantInfo) {
  if (panes.has(info.id)) removeTerm(info.id); // it was on screen — take it off
  dormant.set(info.id, info);
  renderRecovery();
}
function undormant(id: string) {
  if (dormant.delete(id)) renderRecovery();
}
async function respawnPane(id: string) {
  const info = dormant.get(id);
  if (!info) return;
  undormant(id); // optimistic; the server's "created" broadcast adds the box back
  await fetch(`/api/panes/${id}/respawn`, { method: "POST" });
}
async function respawnAll() {
  for (const id of [...dormant.keys()]) await respawnPane(id);
}
async function discardPane(id: string) {
  undormant(id);
  await fetch(`/api/dormant/${id}`, { method: "DELETE" });
}
function renderRecovery() {
  recoveryEl.innerHTML = "";
  if (dormant.size === 0) return;
  const label = document.createElement("span");
  label.className = "rec-label";
  label.textContent = "⏎ recover:";
  recoveryEl.append(label);
  for (const info of dormant.values()) {
    const chip = document.createElement("span");
    chip.className = "rchip recover" + (info.sessionAlive ? " alive" : "");
    chip.title = info.sessionAlive
      ? `${info.cwd} — set aside, click to restore (session intact)`
      : `${info.cwd} — terminal died, click to respawn a fresh shell here`;
    const name = document.createElement("span");
    name.className = "rname";
    name.textContent = displayName(info);
    name.onclick = () => respawnPane(info.id);
    const x = document.createElement("span");
    x.className = "rx";
    x.title = "Discard — don't recover this terminal";
    x.textContent = "✕";
    x.onclick = (e) => {
      e.stopPropagation();
      discardPane(info.id);
    };
    chip.append(name, x);
    recoveryEl.append(chip);
  }
  if (dormant.size > 1) {
    const all = document.createElement("button");
    all.className = "rec-all";
    all.textContent = `Recover all (${dormant.size})`;
    all.onclick = () => respawnAll();
    recoveryEl.append(all);
  }
}

// ---- Folder picker ----------------------------------------------------
const picker = document.getElementById("picker") as HTMLElement;
const crumbsEl = document.getElementById("crumbs")!;
const plistEl = document.getElementById("plist")!;
const precentEl = document.getElementById("precent")!;
const agentSelect = document.getElementById("agentSelect") as HTMLSelectElement;
const chatViewEl = document.getElementById("chatView") as HTMLInputElement;
const searchEl = document.getElementById("psearch") as HTMLInputElement;
const sortEl = document.getElementById("psort") as HTMLSelectElement;
const mkdirBtn = document.getElementById("pmkdir")!;
const starBtn = document.getElementById("pstar")!;

type Entry = { name: string; path: string; mtime: number; btime: number };
let pickEntries: Entry[] = [];
let pickPath: string | null = null;
let pickParent: string | null = null;
let pickHome = "";
let prefs: { defaultDir: string | null; sort: string } = { defaultDir: null, sort: "name" };

async function loadPrefs() {
  prefs = await fetch("/api/prefs").then((r) => r.json());
  sortEl.value = prefs.sort || "name";
}

// Chat view (see agent-chat.ts) is available for all four claude/codex agent
// options (backed by claude-driver.js / codex-driver.js — see the plan).
// Mobile defaults new agent boxes to it (confirmed with the user — it's what
// actually fixes mobile terminal pain); desktop defaults to the classic
// terminal either way. Existing boxes are unaffected — this only decides
// what a NEWLY created box becomes.
function chatViewAvailable(cmd: string): boolean {
  return cmd === "claude" || cmd === "claude-work" || cmd === "codex" || cmd === "codex-work";
}
function updateChatViewAvailability() {
  const available = chatViewAvailable(agentSelect.value);
  chatViewEl.disabled = !available;
  if (!available) chatViewEl.checked = false;
}
agentSelect.addEventListener("change", updateChatViewAvailability);

async function openPicker() {
  picker.hidden = false;
  updateChatViewAvailability();
  if (chatViewAvailable(agentSelect.value)) chatViewEl.checked = mobileQuery.matches;
  // Resume where we left off; on first open use the saved default (or home).
  await navigate(pickPath ?? prefs.defaultDir);
  loadPickerRecents();
  searchEl.focus();
}
function closePicker() {
  picker.hidden = true;
}

async function navigate(path: string | null) {
  const data = await fetch(
    "/api/dirs?path=" + encodeURIComponent(path ?? "")
  ).then((r) => r.json());
  if (data.error) {
    plistEl.innerHTML = `<div class="prow empty">⚠ ${data.error}</div>`;
    return;
  }
  pickPath = data.path;
  pickParent = data.parent;
  pickHome = data.home;
  pickEntries = data.entries;
  searchEl.value = "";
  renderCrumbs();
  renderList();
  updateStar();
}

function renderCrumbs() {
  crumbsEl.innerHTML = "";
  const path = pickPath!;
  const underHome = path === pickHome || path.startsWith(pickHome + "/");
  const rest = underHome ? path.slice(pickHome.length).split("/").filter(Boolean) : path.split("/").filter(Boolean);
  const labels = underHome ? ["~", ...rest] : ["/", ...rest];

  labels.forEach((label, i) => {
    if (i > 0) {
      const sep = document.createElement("span");
      sep.className = "sep";
      sep.textContent = "/";
      crumbsEl.append(sep);
    }
    const crumb = document.createElement("span");
    crumb.className = "crumb";
    crumb.textContent = label;
    let target: string;
    if (underHome) target = i === 0 ? pickHome : pickHome + "/" + rest.slice(0, i).join("/");
    else target = i === 0 ? "/" : "/" + rest.slice(0, i).join("/");
    crumb.onclick = () => navigate(target);
    crumbsEl.append(crumb);
  });
}

function renderList() {
  plistEl.innerHTML = "";
  const q = searchEl.value.trim().toLowerCase();
  const mode = sortEl.value;
  let items = pickEntries.slice();
  if (q) items = items.filter((e) => e.name.toLowerCase().includes(q));
  items.sort((a, b) =>
    mode === "edited" ? b.mtime - a.mtime : mode === "created" ? b.btime - a.btime : a.name.localeCompare(b.name)
  );

  if (pickParent && !q) {
    const up = document.createElement("div");
    up.className = "prow up";
    up.innerHTML = `<span class="ico">⤴</span><span>..</span>`;
    up.onclick = () => navigate(pickParent);
    plistEl.append(up);
  }
  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "prow empty";
    empty.textContent = q ? "no folders match" : "no sub-folders here — use “Open here”";
    plistEl.append(empty);
  }
  for (const e of items) {
    const row = document.createElement("div");
    row.className = "prow";
    row.innerHTML = `<span class="ico">📁</span><span class="nm"></span>`;
    (row.querySelector(".nm") as HTMLElement).textContent = e.name;
    if (mode !== "name") {
      const meta = document.createElement("span");
      meta.className = "meta";
      const t = mode === "created" ? e.btime : e.mtime;
      meta.textContent = new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "2-digit" });
      row.append(meta);
    }
    row.onclick = () => navigate(e.path);
    plistEl.append(row);
  }
}

function updateStar() {
  const active = !!pickPath && prefs.defaultDir === pickPath;
  starBtn.classList.toggle("active", active);
  starBtn.textContent = active ? "★ Start" : "☆ Start";
  starBtn.title = active ? "This is the default start folder (click to unset)" : "Open the picker here by default";
}

searchEl.addEventListener("input", renderList);
sortEl.addEventListener("change", async () => {
  renderList();
  prefs = await putPrefs({ sort: sortEl.value });
});
mkdirBtn.addEventListener("click", async () => {
  const name = prompt("New folder name (created in " + prettyPath(pickPath!) + "):");
  if (!name) return;
  const r = await fetch("/api/mkdir", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: pickPath, name }),
  }).then((r) => r.json());
  if (r.error) {
    alert("Couldn't create folder: " + r.error);
    return;
  }
  await navigate(pickPath); // refresh listing; the new folder appears
});
starBtn.addEventListener("click", async () => {
  const next = prefs.defaultDir === pickPath ? null : pickPath;
  prefs = await putPrefs({ defaultDir: next });
  updateStar();
});
async function putPrefs(patch: object) {
  return fetch("/api/prefs", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  }).then((r) => r.json());
}

async function loadPickerRecents() {
  const recents: string[] = await fetch("/api/recents").then((r) => r.json());
  precentEl.innerHTML = "";
  if (!recents.length) {
    precentEl.hidden = true;
    return;
  }
  precentEl.hidden = false;
  const label = document.createElement("span");
  label.textContent = "Recent:";
  precentEl.append(label);
  for (const p of recents.slice(0, 6)) {
    const chip = document.createElement("span");
    chip.className = "rchip";
    chip.textContent = prettyPath(p);
    chip.title = p;
    chip.onclick = () => choose(p);
    precentEl.append(chip);
  }
}

function choose(path: string) {
  const kind = chatViewAvailable(agentSelect.value) && chatViewEl.checked ? "agent" : "pty";
  openTermAt(path, agentSelect.value, kind);
  closePicker();
}
async function openTermAt(cwd: string, cmd: string, kind: "pty" | "agent" = "pty") {
  await fetch("/api/panes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd, cmd, session: SESSION, kind }),
  });
}
function prettyPath(p: string): string {
  if (pickHome && (p === pickHome || p.startsWith(pickHome + "/")))
    return "~" + p.slice(pickHome.length);
  return p;
}

document.getElementById("addBtn")!.addEventListener("click", openPicker);
document.getElementById("pcancel")!.addEventListener("click", closePicker);

// ---- Mobile menu (narrow screens collapse secondary bar controls here) ----
const barMenu = document.getElementById("barMenu")!;
const menuBtn = document.getElementById("menuBtn")!;
menuBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  barMenu.classList.toggle("open");
});
barMenu.addEventListener("click", (e) => {
  // Let the click's own handler (theme toggle, open layout, etc.) run first,
  // then close — except selects, which need to stay open through the choice.
  if ((e.target as HTMLElement).tagName !== "SELECT") barMenu.classList.remove("open");
});
document.addEventListener("click", (e) => {
  if (!barMenu.classList.contains("open")) return;
  if (e.target === menuBtn || barMenu.contains(e.target as Node)) return;
  barMenu.classList.remove("open");
});
document.getElementById("popen")!.addEventListener("click", () => pickPath && choose(pickPath));
picker.addEventListener("click", (e) => {
  if (e.target === picker) closePicker(); // click backdrop to dismiss
});

// ---- Control socket (grid-level events) -------------------------------
let controlWs: WebSocket | null = null;
function connectControl() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/control?session=${encodeURIComponent(SESSION)}`);
  controlWs = ws;
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    switch (m.t) {
      case "panes": {
        // Authoritative snapshot of this window's live terminals (sent on every
        // connect). Add new ones and drop any box the server no longer has —
        // e.g. a terminal closed while we were asleep.
        const live = new Set((m.panes as PaneInfo[]).map((p) => p.id));
        for (const info of m.panes as PaneInfo[]) addTerm(info);
        for (const id of [...panes.keys()]) if (!live.has(id)) removeTerm(id);
        break;
      }
      case "created":
        undormant(m.pane.id); // a respawn lands here — drop its recovery chip
        addTerm(m.pane);
        break;
      case "closed":
        removeTerm(m.pane);
        break;
      case "dormant":
        for (const info of m.dormant as DormantInfo[]) markDormant(info);
        break;
      case "died":
        markDormant(m.pane as DormantInfo);
        break;
      case "discarded":
        undormant(m.pane);
        break;
      case "input":
        panes.get(m.pane)?.setLastInput(m.text);
        break;
      case "tasks":
        applyRemoteTasks(m.tasks);
        break;
      case "color":
        panes.get(m.pane)?.setColor(m.color);
        break;
      case "renamed": {
        panes.get(m.pane)?.setName(m.name);
        const d = dormant.get(m.pane);
        if (d) {
          d.name = m.name;
          renderRecovery();
        }
        // Chips (tray / attention / follow-up) show the name too — redraw them.
        renderTray();
        renderQueue();
        renderFollowups();
        break;
      }
      case "attention":
        onAttention(m.pane, m.kind);
        break;
      case "cleared":
        setCleared(m.pane);
        break;
      case "followup": {
        const t = panes.get(m.pane);
        if (t) t.setFollowUp(m.on);
        setFlagged(m.pane, m.on);
        break;
      }
      case "layouts":
        loadLayouts(); // a layout was saved/removed in some window
        break;
    }
  };
  ws.onclose = () => {
    if (controlWs === ws) {
      controlWs = null;
      setTimeout(connectControl, 1500);
    }
  };
}

function reconnectControl() {
  const old = controlWs;
  if (old) {
    old.onclose = null; // reconnecting ourselves; don't double-schedule
    try {
      old.close();
    } catch {}
  }
  controlWs = null;
  connectControl();
}

// Laptop sleep silently freezes every WebSocket; on wake they can be dead
// "zombies" (still readyState OPEN) so the page looks live but nothing flows
// until a manual refresh. Re-establish the control socket and every terminal.
function recoverConnections() {
  reconnectControl();
  for (const t of panes.values()) t.reconnectNow();
}

// Detect a wake via a heartbeat: if the interval didn't fire for far longer than
// its period, the machine was suspended (lid closed). This only triggers on a
// real sleep, not ordinary tab switches, so it won't cause needless reconnect
// flicker. `online`/`pageshow` are extra nudges for network blips / bfcache.
let lastHeartbeat = Date.now();
setInterval(() => {
  const now = Date.now();
  if (now - lastHeartbeat > 15000) recoverConnections();
  lastHeartbeat = now;
}, 5000);
addEventListener("online", () => recoverConnections());
addEventListener("pageshow", (e) => {
  if ((e as PageTransitionEvent).persisted) recoverConnections();
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (controlWs?.readyState !== WebSocket.OPEN) {
    recoverConnections();
    return;
  }
  // The socket survived, but browsers throttle/pause ResizeObserver and layout
  // work in background tabs — a grid resize that happened while this tab
  // wasn't visible (another terminal opened/closed, window moved to a
  // different-size display) can get measured wrong or missed entirely, and
  // nothing since would have re-checked it. Cheap and idempotent, so just
  // always re-verify every terminal's fit on regaining focus rather than
  // trying to detect whether a resize was actually missed.
  reflow();
});

// ---- Current layout + autosave ----------------------------------------
function setCurrentLayout(name: string | null) {
  currentLayout = name;
  if (name) sessionStorage.setItem("fleet-current-layout", name);
  else sessionStorage.removeItem("fleet-current-layout");
  currentEl.hidden = !name;
  currentEl.textContent = name ? "▣ " + name : "";
  if (name) layoutSel.value = name;
}
function flashSaved() {
  currentEl.classList.add("saved");
  setTimeout(() => currentEl.classList.remove("saved"), 900);
}
// Slots for the current window, in order: grid order first, then minimized.
function currentSlots() {
  const ordered = [...grid.children].map((c) => (c as HTMLElement).dataset.id!).filter(Boolean);
  const rest = [...minimized].filter((id) => !ordered.includes(id));
  return [...ordered, ...rest]
    .map((id) => panes.get(id))
    .filter(Boolean)
    .map((t) => ({ cwd: t!.info.cwd, cmd: t!.info.cmd }));
}
async function saveLayout(name: string) {
  await fetch("/api/layouts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, slots: currentSlots() }),
  });
}
function autosaveLayout() {
  if (!currentLayout) return;
  saveLayout(currentLayout);
  flashSaved();
}

// ---- Layout actions ---------------------------------------------------
document.getElementById("saveBtn")!.addEventListener("click", async () => {
  const name = prompt("Save this window as layout named:", currentLayout || "");
  if (!name) return;
  await saveLayout(name);
  setCurrentLayout(name);
  await loadLayouts();
});

const openmode = document.getElementById("openmode") as HTMLElement;
const omMsg = document.getElementById("omMsg")!;
let pendingOpen: string | null = null;

document.getElementById("openBtn")!.addEventListener("click", () => {
  const name = layoutSel.value;
  if (!name) return;
  if (panes.size === 0) {
    doOpen(name, "overwrite"); // empty window — nothing to merge, just adopt it
    return;
  }
  pendingOpen = name;
  const n = panes.size;
  const live = [...panes.values()].filter((t) => /\b(claude|codex)\b/.test(t.info.cmd || "")).length;
  const livePart = live ? ` (${live} running an agent)` : "";
  omMsg.innerHTML =
    `Open <b>${name}</b> — <b>Add</b> its terminals alongside the ${n} here, ` +
    `or <b>Replace</b>?<br><span class="omnote">Replace sets aside the current ` +
    `${n} terminal${n === 1 ? "" : "s"}${livePart}; they keep running and stay ` +
    `recoverable from the <b>⏎ recover</b> bar, so this won't lose your work.</span>`;
  openmode.hidden = false;
});
document.getElementById("omCancel")!.addEventListener("click", () => {
  openmode.hidden = true;
  pendingOpen = null;
});
document.getElementById("omAdd")!.addEventListener("click", () => {
  if (pendingOpen) doOpen(pendingOpen, "add");
  openmode.hidden = true;
});
document.getElementById("omReplace")!.addEventListener("click", () => {
  if (pendingOpen) doOpen(pendingOpen, "overwrite");
  openmode.hidden = true;
});
openmode.addEventListener("click", (e) => {
  if (e.target === openmode) {
    openmode.hidden = true;
    pendingOpen = null;
  }
});

async function doOpen(name: string, mode: "add" | "overwrite") {
  pendingOpen = null;
  await fetch(`/api/layouts/${encodeURIComponent(name)}/open`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session: SESSION, mode }),
  });
  // Overwrite => this window now *is* that layout (autosave on move targets it).
  // Add => the window holds a mix, so it maps to no single layout.
  setCurrentLayout(mode === "overwrite" ? name : null);
}

async function loadLayouts() {
  const keep = layoutSel.value;
  const layouts = await fetch("/api/layouts").then((r) => r.json());
  layoutSel.innerHTML = `<option value="">layouts…</option>`;
  for (const l of layouts) {
    const o = document.createElement("option");
    o.value = l.name;
    o.textContent = `${l.name} (${l.slots?.length ?? 0})`;
    layoutSel.append(o);
  }
  // Preserve the user's selection (or pin to the current layout) across refreshes.
  layoutSel.value = currentLayout || keep || "";
}

// ---- Appearance (light/dark + large text) -----------------------------
const themeBtn = document.getElementById("themeBtn")!;
const textBtn = document.getElementById("textBtn")!;
function applyAppearance() {
  const a = getAppearance();
  document.body.classList.toggle("light", a.light);
  document.body.classList.toggle("big", a.big);
  const theme = xtermTheme(a.light);
  const fs = xtermFontSize(a.big);
  for (const t of panes.values()) t.setAppearance(theme, fs);
  themeBtn.textContent = a.light ? "☾" : "☀";
  themeBtn.title = a.light ? "Switch to dark" : "Switch to light";
  textBtn.textContent = a.big ? "A−" : "A⁺";
  textBtn.title = a.big ? "Switch to normal text" : "Switch to large text";
}
themeBtn.addEventListener("click", () => {
  const a = getAppearance();
  setAppearance({ ...a, light: !a.light });
  applyAppearance();
});
textBtn.addEventListener("click", () => {
  const a = getAppearance();
  setAppearance({ ...a, big: !a.big });
  applyAppearance();
});

// ---- Boot -------------------------------------------------------------
applyAppearance();
connectControl();
loadLayouts();
loadPrefs();
setCurrentLayout(currentLayout); // restore the indicator after a refresh
renderQueue(); // draw the idle favicon / base title before any attention arrives
initTasks(); // task-list sidebar (tree arrives via the control socket)
