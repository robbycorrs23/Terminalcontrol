import { Term, PaneInfo, PaneView, TermHost, UsageRow, displayName } from "./terminal";
import { AgentChat } from "./agent-chat";
import { play } from "./sound";
import { setTabAttention, setAppLabel } from "./tab";
import { initTasks, applyRemoteTasks, closeTasksIfOpen } from "./tasks";
import { getSettings, patchSettings, loadSettings, putPrefs, xtermTheme, xtermFontSize, FX_ORDER, Settings } from "./settings";
import { initPush, enablePush, disablePush, pushActive, setBadge } from "./push";
import { iconSvg } from "./icons";

const grid = document.getElementById("grid")!;
const brandEl = document.querySelector<HTMLElement>(".brand")!;
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
  // NOTE: this id no longer decides which panes you see — the server shows every
  // client the same fleet ("one workspace per machine", see pane-registry.js).
  // It's still generated and sent because the server keys ephemeral-secret
  // release on the window that authorised the secret, and because reorder/
  // layout calls carry it. A cold-launched PWA minting a fresh id is therefore
  // harmless: it still lands on the full fleet.
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

// ---- Ephemeral secrets: optional WebAuthn step-up ----------------------
// The ⚿ popover (terminal.ts) wants a fresh passkey confirmation right
// before releasing a secret, on top of whatever the passkey gate
// (server/gate.js) already does with session cookies. That's only possible
// when THIS page is actually being served through the gate — gate.js mounts
// its own `/gate` router in front of the FleetView proxy, so a same-origin
// probe of `/gate/status` tells us that without hardcoding a port: reached
// through the gate, it answers; reached directly on FleetView's own port
// (also fully supported — see CLAUDE.md's security model), it 404s.
let webauthnBrowserLoaded: Promise<void> | null = null;
function loadWebAuthnBrowser(): Promise<void> {
  if (!webauthnBrowserLoaded) {
    webauthnBrowserLoaded = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "/gate/webauthn-browser.js";
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("could not load the gate's WebAuthn helper"));
      document.head.append(s);
    });
  }
  return webauthnBrowserLoaded;
}
async function gateApi(path: string, body?: unknown) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${path} failed (${res.status})`);
  return data;
}
/**
 * Best-effort: resolves to a step-up token when the gate is present, signed
 * in, and the passkey prompt succeeds — otherwise null. A null result never
 * blocks the secret-inject flow; the server treats an absent token as "no
 * step-up available", not an error (see server/index.js's /api/panes/:id/secret).
 */
async function tryStepUp(scope: string): Promise<string | null> {
  try {
    const statusRes = await fetch("/gate/status");
    if (!statusRes.ok) return null;
    const status = await statusRes.json();
    if (!status.loggedIn) return null; // behind the gate but not signed in here — don't force a detour
    await loadWebAuthnBrowser();
    const options = await gateApi("/gate/stepup/start", { scope });
    const response = await (window as unknown as { SimpleWebAuthnBrowser: any }).SimpleWebAuthnBrowser.startAuthentication({
      optionsJSON: options,
    });
    const { token } = await gateApi("/gate/stepup/finish", response);
    return (token as string) || null;
  } catch {
    return null;
  }
}

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
    // Opt-in guard (Settings → Safety). Off by default: ✕ from the grid has
    // always been immediate, and a confirm on every close would annoy anyone
    // who didn't ask for it.
    if (
      getSettings().confirmClose &&
      !confirm(`Close "${displayName(t.info)}"?\n\nWhatever is running in it stops.`)
    )
      return;
    closeTerm(t.id);
  },
  onMinimize: (t) => minimize(t),
  onFlipView: (t) => {
    void flipView(t);
  },
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
  onInjectSecret: async (t, opts) => {
    const stepUpToken = await tryStepUp(`secret:${t.id}`);
    const res = await fetch(`/api/panes/${t.id}/secret`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...opts, session: SESSION, stepUpToken }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `inject failed (${res.status})`);
    return data;
  },
  onRevokeSecret: (t, name) => {
    fetch(`/api/panes/${t.id}/secret/${encodeURIComponent(name)}`, { method: "DELETE" });
  },
  secretStatus: async (t) => {
    const res = await fetch(`/api/panes/${t.id}/secret-status`);
    return res.json();
  },
};

// ---- Grid -------------------------------------------------------------
/**
 * `at` is the grid slot to drop the box into, used when one pane REPLACES
 * another in place — a view flip destroys the pane and builds a new one with a
 * new id, and appending that to the end would make a box visibly jump to the
 * bottom of the grid for what is supposed to look like the same box changing
 * clothes. Everything else (a genuinely new terminal, a respawn) appends.
 */
function addTerm(info: PaneInfo, at?: number): PaneView {
  const existing = panes.get(info.id);
  if (existing) return existing;
  const t = info.kind === "agent" ? new AgentChat(info, host) : new Term(info, host);
  panes.set(info.id, t);
  t.cell.dataset.id = info.id; // lets us read grid order for layout autosave
  if (at !== undefined && at >= 0 && at < grid.children.length) {
    grid.insertBefore(t.cell, grid.children[at]);
  } else {
    grid.append(t.cell);
  }
  enableDrag(t);
  t.setUsage(usageFor(t)); // a box created after the last usage broadcast
  reflow();
  if (info.attention?.waiting) enqueue(info.id, info.attention.kind || "question");
  if (info.followUp) setFlagged(info.id, true);
  return t;
}

// Where a just-removed box was sitting, so a pane that REPLACES it (a view
// flip) can be dropped into the same slot. Only ever read by the very next
// `created`, so one entry is all it needs to hold.
let vacated: { id: string; at: number } | null = null;

function removeTerm(id: string) {
  const t = panes.get(id);
  if (!t) return;
  const at = [...grid.children].indexOf(t.cell);
  if (at !== -1) vacated = { id, at };
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
/** A pane's account row is keyed by its `cmd` ("claude-work" / "codex-work"). */
function usageFor(t: PaneView): UsageRow | null {
  return usageRows.find((r) => r.id === t.info.cmd) ?? null;
}

function pushUsageToPanes() {
  for (const t of panes.values()) t.setUsage(usageFor(t));
}

function reflow() {
  const n = Math.max(grid.children.length, 1);
  const cols = mobileQuery.matches ? 1 : Math.ceil(Math.sqrt(n));
  grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  for (const t of panes.values()) if (!minimized.has(t.id)) t.refit();
  reflowMobileOrder();
}



// ---- Per-machine settings (server/machine-config.js) ---------------------
// Accounts, badge image and machine identity. Applied through a CSS custom
// property rather than per-pane plumbing, so changing the badge updates every
// box at once — including ones created before the fetch resolved.
const mcLabel = document.getElementById("mcLabel") as HTMLInputElement;
const mcColor = document.getElementById("mcColor") as HTMLSelectElement;
const mcAccounts = document.getElementById("mcAccounts")!;
const mcLogoPick = document.getElementById("mcLogoPick") as HTMLButtonElement;
const mcLogoClear = document.getElementById("mcLogoClear") as HTMLButtonElement;
const mcLogoFile = document.getElementById("mcLogoFile") as HTMLInputElement;
const mcLogoPreview = document.getElementById("mcLogoPreview")!;
const mcNote = document.getElementById("mcNote")!;

/** Rebuild both picker selects from this machine's accounts. */
function renderAgentOptions() {
  const keepMain = agentSelect.value;
  const keepSsh = sshAgentSelect.value;

  // Remove only the direct <option> children — the SSH <optgroup> is a live
  // node that renderSshOptions() fills, so it has to survive.
  for (const o of [...agentSelect.children]) if (o.tagName === "OPTION") o.remove();
  const frag = document.createDocumentFragment();
  for (const id of machine.accounts) {
    const o = document.createElement("option");
    o.value = id;
    o.textContent = profileLabel(id);
    frag.append(o);
  }
  const shell = document.createElement("option");
  shell.value = "";
  shell.textContent = "plain shell";
  frag.append(shell);
  agentSelect.prepend(frag); // accounts, plain shell, then the SSH optgroup

  sshAgentSelect.innerHTML = "";
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "plain shell";
  sshAgentSelect.append(none);
  for (const id of machine.accounts) {
    const o = document.createElement("option");
    o.value = id;
    o.textContent = profileLabel(id);
    sshAgentSelect.append(o);
  }

  agentSelect.value = keepMain;
  if (!agentSelect.value) agentSelect.value = machine.accounts[0] || "";
  sshAgentSelect.value = keepSsh;
  updateChatViewAvailability();
}

/** The badge image, as a custom property so every pane picks it up at once. */
function applyMachineBadge() {
  const url = machine.logoUrl;
  document.documentElement.style.setProperty("--work-logo", url ? `url("${url}")` : "none");
  document.body.classList.toggle("has-logo", !!url);
  mcLogoPreview.hidden = !url;
  mcLogoClear.hidden = !url;
}

function renderMachineSettings() {
  mcLabel.value = machine.label || "";
  mcLabel.placeholder = brandEl.textContent?.replace(/^▦\s*/, "") || "hostname";

  mcColor.innerHTML = "";
  const auto = document.createElement("option");
  auto.value = "";
  auto.textContent = "automatic";
  mcColor.append(auto);
  for (const c of machine.iconColors) {
    const o = document.createElement("option");
    o.value = c;
    o.textContent = c;
    mcColor.append(o);
  }
  mcColor.value = machine.iconColor || "";

  mcAccounts.innerHTML = "";
  for (const p of machine.profiles) {
    const lbl = document.createElement("label");
    lbl.className = "set-check";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = p.id;
    cb.checked = machine.accounts.includes(p.id);
    lbl.append(cb, document.createTextNode(" " + p.label));
    if (!machine.installed.includes(p.id)) {
      const warn = document.createElement("span");
      warn.className = "mc-missing";
      warn.textContent = "not signed in here";
      lbl.append(warn);
    }
    cb.addEventListener("change", () => {
      const picked = [...mcAccounts.querySelectorAll("input:checked")].map(
        (i) => (i as HTMLInputElement).value
      );
      void saveMachine({ accounts: picked });
    });
    mcAccounts.append(lbl);
  }

  mcNote.textContent = machine.seeded
    ? "Seeded from the logins found here — change it and it stays changed."
    : "";
  applyMachineBadge();
}

async function saveMachine(patch: Record<string, unknown>) {
  try {
    const res = await fetch("/api/machine", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    const cfg = await res.json();
    machine = { ...machine, ...cfg, seeded: false };
    renderAgentOptions();
    renderMachineSettings();
  } catch {
    mcNote.textContent = "Couldn't save — is the server still up?";
  }
}

async function loadMachine() {
  try {
    const res = await fetch("/api/machine");
    if (!res.ok) throw new Error(String(res.status));
    machine = await res.json();
  } catch {
    // Older server (no /api/machine yet), or it's down. Fall back to whatever
    // the static markup offers so the picker keeps working instead of
    // collapsing to "plain shell" — this is the stale-bundle-vs-old-server
    // case that bites constantly in this project.
    machine = {
      ...machine,
      accounts: [...agentSelect.querySelectorAll("option")]
        .map((o) => (o as HTMLOptionElement).value)
        .filter(Boolean),
      profiles: [],
    };
    return;
  }
  renderAgentOptions();
  renderMachineSettings();
}

mcLabel.addEventListener("change", () => void saveMachine({ label: mcLabel.value.trim() || null }));
mcColor.addEventListener("change", () => void saveMachine({ iconColor: mcColor.value || null }));
mcLogoPick.addEventListener("click", () => mcLogoFile.click());
mcLogoFile.addEventListener("change", () => {
  const f = mcLogoFile.files?.[0];
  mcLogoFile.value = "";
  if (!f) return;
  const reader = new FileReader();
  reader.onload = async () => {
    const res = await fetch("/api/machine/logo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dataUrl: reader.result }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      mcNote.textContent = body.error || "Couldn't use that image.";
      return;
    }
    mcNote.textContent = "";
    machine.logoUrl = body.logoUrl;
    applyMachineBadge();
  };
  reader.readAsDataURL(f);
});
mcLogoClear.addEventListener("click", async () => {
  await fetch("/api/machine/logo", { method: "DELETE" });
  machine.logoUrl = null;
  applyMachineBadge();
});

// ---- Per-pane view flip (terminal ⇄ chat) -------------------------------
// The ❝ / ▤ button in each box's title bar. The picker's "❝ Chat view"
// checkbox only decides what a NEW box becomes; this switches a box already on
// the grid, which is a genuinely different operation: a chat pane is an
// in-process SDK driver with no terminal behind it, and a terminal pane is a
// tmux shell with no event stream. So the server tears the pane down and
// re-creates it in the other kind, and what makes that a view switch rather
// than a restart is that both halves resume the SAME Claude conversation by
// session id, at the SAME permission mode (server/pane-registry.js `flip`).
//
// Which means it can legitimately fail, and saying why beats doing nothing
// visible — the server returns a reason and this puts it in the top bar.
const viewNote = document.getElementById("viewNote")!;
let viewNoteTimer: number | undefined;

const FLIP_REASON: Record<string, string> = {
  busy: "it's mid-turn",
  "not an agent pane": "it isn't running an agent",
  "remote pane": "its agent runs on another host",
  // The one users will actually hit: a terminal pane only learns its Claude
  // session id when the agent inside fires a hook, so a box that hasn't been
  // prompted yet has nothing to resume from.
  "no conversation captured yet": "no conversation yet — send it a prompt first",
  gone: "the box is gone",
};

function showViewNote(text: string) {
  viewNote.textContent = "⇄ " + text;
  viewNote.hidden = false;
  clearTimeout(viewNoteTimer);
  viewNoteTimer = setTimeout(() => (viewNote.hidden = true), 6000);
}

async function flipView(t: PaneView) {
  const label = displayName(t.info);
  // Terminal panes keep this in the title bar; chat panes moved it to the
  // tools row above the composer — so search the whole box, not the title bar.
  const btn = t.el.querySelector(".view") as HTMLButtonElement | null;
  if (btn) btn.disabled = true;
  try {
    const res = await fetch(`/api/panes/${t.info.id}/flip`, { method: "POST" });
    // A 404 here means the ROUTE is missing, not the pane: the server is still
    // running code older than this bundle. Worth calling out by name — the
    // server serving a new bundle while itself running old code is this
    // project's most recurring trap, and "couldn't switch" sends you hunting
    // for a bug that isn't there.
    if (res.status === 404) {
      showViewNote(`${label}: server is running older code — restart it`);
      return;
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.ok) {
      showViewNote(`${label}: ${FLIP_REASON[body.reason] || body.reason || "couldn't switch"}`);
      return;
    }
    // The box itself is replaced by the closed/created pair on the control
    // socket, so there is nothing to re-render here.
    if (body.resumed === false) showViewNote(`${label}: switched — started a fresh session`);
  } catch {
    showViewNote(`${label}: couldn't reach the server`);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// Mobile-only visual ordering: terminals needing you float to the top of the
// scroll stack (question > aborted > done > idle), stable otherwise. Pure
// presentation — doesn't touch the underlying grid order that drag-to-reorder
// persists, so desktop layouts and saved layouts are unaffected.
function reflowMobileOrder() {
  const rank = { question: 0, aborted: 1, done: 2 } as const;
  for (const t of panes.values()) {
    t.cell.style.order = mobileQuery.matches ? String(t.isWaiting() ? rank[t.waitingKind()] : 3) : "";
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
    const wKind = t.isWaiting() ? t.waitingKind() : null;
    chip.className = "tchip" + (wKind ? " waiting" + (wKind === "question" ? "" : " " + wKind) : "");
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
// `top`) that can't use `top: 100%` the way #settings does because #tasks is
// `position: fixed`, not a child of #bar. #bar's height isn't a fixed 40px —
// env(safe-area-inset-top) (notch/Dynamic Island) and the mobile touch-target
// button sizing both add to it — so a static px in CSS drifts out of sync per
// device/orientation the same way centerRect()'s barH read below has to be
// live rather than a constant.
// Callers: startup, `resize`, visualViewport changes — and every chip render,
// because #bar now has a second row (#barChips) that appears and disappears with
// the attention chips. That changes #bar's height WITHOUT any window resize
// firing, and a stale --bar-h leaves #tasks (position: fixed, top: var(--bar-h))
// either overlapping the bar or floating below it.
function syncBarHeightVar() {
  const barH = document.getElementById("bar")?.offsetHeight ?? 40;
  document.documentElement.style.setProperty("--bar-h", `${barH}px`);
}

// Drives body's height (see the --app-h note in styles.css). The point is that
// the app is never one pixel taller than what's actually visible: on iOS a body
// taller than the visible area is pannable, and panning tucks #bar — safe-area
// padding and all — under the status bar / Dynamic Island, which is what makes
// its buttons untappable. `dvh` handles the URL bar but NOT the keyboard;
// visualViewport.height handles both, so it wins when we have it.
function syncAppHeightVar() {
  const vv = window.visualViewport;
  // While pinch-zoomed, visualViewport.height is the magnified slice of the
  // page, not the window — writing that to --app-h would shrink the whole app
  // to the zoom window. Leave the last good value; the next scale-1 event
  // (resize, or the zoom being released) refreshes it.
  if (!vv || vv.scale > 1.01) return;
  document.documentElement.style.setProperty("--app-h", `${vv.height}px`);
}
// Height first, then the bar measurement — #bar's offsetHeight is read out of a
// layout that the height change can invalidate.
syncAppHeightVar();
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
  const sshEditEl = document.getElementById("sshEdit") as HTMLElement;
  const sshManagerEl = document.getElementById("sshManager") as HTMLElement;
  if (!picker.hidden) closePicker();
  else if (om && !om.hidden) om.hidden = true;
  else if (sshEditEl && !sshEditEl.hidden) sshEditEl.hidden = true;
  else if (sshManagerEl && !sshManagerEl.hidden) sshManagerEl.hidden = true;
  else if (settingsPanel.classList.contains("open")) closeSettings();
  else if (closeTasksIfOpen()) {
    /* closed the task sidebar */
  } else if (zoomed) unzoom();
});
addEventListener("resize", () => {
  syncAppHeightVar();
  syncBarHeightVar();
  if (zoomed) setRect(zoomed.el, centerRect());
  reflow();
});
// Mobile Safari fires visualViewport resize (not always window resize) when the
// on-screen keyboard opens/closes, shrinking the usable area without changing
// innerHeight — without this, a zoomed terminal's fit()/rect can end up wrong
// (partly hidden behind the keyboard) until something else forces a reflow.
function onVisualViewportChange() {
  syncAppHeightVar();
  syncBarHeightVar();
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
function onAttention(id: string, kind: "question" | "done" | "aborted") {
  const t = panes.get(id);
  if (!t) return;
  if (zoomed === t) return; // you're already looking at it
  t.setWaiting(true, kind);
  if (minimized.has(id)) renderTray();
  enqueue(id, kind);
  const s = getSettings();
  if (s.sound) play(kind, s.volume / 100);
  notifyAttention(t, kind);
}

/**
 * OS-level notification for a pane that needs you, for when FleetView isn't the
 * tab you're looking at. Deliberately only fires when the tab is hidden — if
 * you're staring at the grid, the glow, the chip and the tone already told you.
 *
 * `tag: id` means a pane that pings twice replaces its own notification instead
 * of stacking a second one.
 */
function notifyAttention(t: PaneView, kind: "question" | "done" | "aborted") {
  // Exactly one notifier per device. If this device holds a push subscription,
  // the service worker will raise the notification (and can do it with the app
  // fully closed, which this path cannot) — so stand down rather than showing a
  // second, duplicate banner for the same event.
  if (pushActive()) return;
  if (!getSettings().notify || !document.hidden) return;
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  try {
    const name = displayName(t.info);
    const title = kind === "done" ? `${name} finished` : kind === "aborted" ? `${name} was cut off` : `${name} needs you`;
    const body =
      kind === "done"
        ? "The agent ended its turn."
        : kind === "aborted"
          ? "The turn was interrupted before finishing — the response may be incomplete."
          : "Waiting on an approval or an answer.";
    const n = new Notification(title, { body, tag: t.id, icon: "/favicon.svg" });
    n.onclick = () => {
      window.focus();
      const live = panes.get(t.id);
      if (live) zoom(live);
      n.close();
    };
  } catch {
    /* some browsers throw on construction outside a service worker — ignore */
  }
}

function enqueue(id: string, _kind: "question" | "done" | "aborted") {
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
    const kind = t?.waitingKind() ?? "question";
    chip.className = "qchip" + (kind === "question" ? "" : " " + kind);
    chip.textContent = t ? displayName(t.info) : id;
    chip.onclick = () => t && zoom(t);
    queueEl.append(chip);
  }
  nextBtn.hidden = queue.length === 0;
  syncBarHeightVar();

  // Mirror the waiting state in the browser tab (title + favicon dot) so it's
  // visible even when FleetView isn't the focused tab. queue[0] is the oldest
  // waiter — the same one "Jump to next" goes to.
  const head = queue[0] ? panes.get(queue[0]) : undefined;
  setTabAttention(
    queue.length,
    head ? displayName(head.info) : "",
    head ? head.waitingKind() : null
  );
  // Same count on the installed app's home-screen icon. Piggybacks on the tab
  // indicator's choke point so the two can't drift.
  setBadge(queue.length);
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
  syncBarHeightVar();
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
  if (dormant.size === 0) return syncBarHeightVar();
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
  syncBarHeightVar();
}

// ---- Folder picker ----------------------------------------------------
const picker = document.getElementById("picker") as HTMLElement;
const crumbsEl = document.getElementById("crumbs")!;
const plistEl = document.getElementById("plist")!;
const precentEl = document.getElementById("precent")!;
const agentSelect = document.getElementById("agentSelect") as HTMLSelectElement;
const sshOptGroup = document.getElementById("sshOptGroup") as HTMLOptGroupElement;
const sshRunRow = document.getElementById("sshRunRow") as HTMLElement;
const sshAgentSelect = document.getElementById("sshAgentSelect") as HTMLSelectElement;
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

// One GET for both: settings.ts needs the appearance/alert keys, the picker
// needs sort/defaultDir, and they all live in the same prefs object.
async function loadPrefs() {
  prefs = await loadSettings();
  sortEl.value = prefs.sort || "name";
  applySettings(); // server values may differ from the localStorage mirror we booted on
}

// Chat view (see agent-chat.ts) is available for the four local claude/codex
// agent options (backed by claude-driver.js / codex-driver.js), OR for an
// SSH pick once "and run — there" (sshAgentSelect) also names one of those
// four profiles — the remote counterpart, driven the same way but over ssh
// (see server/ssh-remote-agent.js). Every new agent box defaults to it, on
// desktop as well as mobile; opting back into the classic terminal is a
// per-open, explicit uncheck. Existing boxes are unaffected — this only
// decides what a NEWLY created box becomes.
// Which accounts THIS machine offers — a property of the machine, not of the
// product, so it comes from the server (~/.fleetview/machine.json) rather than
// being baked in here. Hardcoding it is what put a work-only picker and a work
// badge on a personal machine when the branch was pulled.
type MachineProfile = { id: string; provider: string; account: string; label: string };
type MachineInfo = {
  label: string | null;
  iconColor: string | null;
  accounts: string[];
  badgeLogo: string | null;
  seeded: boolean;
  profiles: MachineProfile[];
  installed: string[];
  iconColors: string[];
  logoUrl: string | null;
};
let machine: MachineInfo = {
  label: null, iconColor: null, accounts: [], badgeLogo: null, seeded: false,
  profiles: [], installed: [], iconColors: [], logoUrl: null,
};

function isAgentProfile(v: string): boolean {
  return machine.accounts.includes(v);
}
function profileLabel(id: string): string {
  return machine.profiles.find((p) => p.id === id)?.label || id;
}
function chatViewAvailable(cmd: string, remoteAgentCmd: string = ""): boolean {
  return isAgentProfile(cmd) || (isSshValue(cmd) && isAgentProfile(remoteAgentCmd));
}
// What the user wants for THIS picker session, so that bouncing the agent
// select through "plain shell" (which force-unchecks, since a shell has no
// chat view) and back doesn't strand the box on the terminal it never
// re-checks itself out of. Reset to the default on every picker open.
let chatViewWanted = true;
function updateChatViewAvailability() {
  const available = chatViewAvailable(agentSelect.value, sshAgentSelect.value);
  chatViewEl.disabled = !available;
  chatViewEl.checked = available && chatViewWanted;
}
agentSelect.addEventListener("change", updateChatViewAvailability);
sshAgentSelect.addEventListener("change", updateChatViewAvailability);
chatViewEl.addEventListener("change", () => {
  if (!chatViewEl.disabled) chatViewWanted = chatViewEl.checked;
});

// "and run — there": only meaningful once an SSH server is picked. Combined
// with Chat view (above), it decides which pane gets created: plain shell →
// PTY typing `ssh ...`; an agent profile + Chat view unchecked → PTY typing
// `ssh -t ... '<agent>; exec $SHELL -l'`; an agent profile + Chat view
// checked → an "agent" pane whose claude/codex runs over ssh instead of
// locally (see choose()/resolveRemoteTarget() below). Hidden/reset the rest
// of the time.
function isSshValue(v: string): boolean {
  return v.startsWith("sshprofile:") || v.startsWith("sshhost:");
}
function updateSshRunRow() {
  const isSsh = isSshValue(agentSelect.value);
  sshRunRow.hidden = !isSsh;
  if (!isSsh) sshAgentSelect.value = "";
}
agentSelect.addEventListener("change", updateSshRunRow);

async function openPicker() {
  picker.hidden = false;
  chatViewWanted = true;
  updateChatViewAvailability();
  updateSshRunRow();
  // Resume where we left off; on first open use the saved default (or home).
  await navigate(pickPath ?? prefs.defaultDir);
  loadPickerRecents();
  loadSshHosts(); // cheap re-read of ~/.ssh/config in case it was hand-edited since last open
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
    row.innerHTML = `<span class="ico">${iconSvg("folder")}</span><span class="nm"></span>`;
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
  const ssh = isSshValue(agentSelect.value);
  const remoteAgent = ssh ? sshAgentSelect.value : "";
  const wantsChat = chatViewAvailable(agentSelect.value, remoteAgent) && chatViewEl.checked;
  if (ssh && remoteAgent && wantsChat) {
    // Remote CHAT VIEW pane: cmd stays the bare profile name (agent-manager.js
    // derives provider/account from it exactly like a local agent pane) plus
    // a structured `remote` target — never a typed shell command.
    const remote = resolveRemoteTarget(agentSelect.value);
    if (remote) {
      openTermAt(path, remoteAgent, "agent", remote);
      closePicker();
      return;
    }
  }
  // Everything else (local agent/shell, or SSH terminal-view with or without
  // an agent running there) keeps the existing typed-shell-command path.
  openTermAt(path, resolveCmd(agentSelect.value), wantsChat ? "agent" : "pty");
  closePicker();
}
type RemoteTarget = { target: string; port?: number; identityFile?: string };
async function openTermAt(cwd: string, cmd: string, kind: "pty" | "agent" = "pty", remote?: RemoteTarget) {
  await fetch("/api/panes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd, cmd, session: SESSION, kind, ...(remote ? { remote } : {}) }),
  });
}
// The structured counterpart of resolveCmd's sshprofile:/sshhost: branching,
// for the remote-CHAT-VIEW path above — a target descriptor instead of a
// shell string (agent-manager.js/ssh-remote-agent.js build the ssh argv
// server-side; nothing here gets typed into a shell).
function resolveRemoteTarget(value: string): RemoteTarget | null {
  if (value.startsWith("sshprofile:")) {
    const p = sshProfiles.find((p) => p.name === value.slice("sshprofile:".length));
    if (!p) return null;
    const t: RemoteTarget = { target: `${p.user}@${p.host}` };
    if (p.port && p.port !== 22) t.port = p.port;
    if (p.identityFile) t.identityFile = p.identityFile;
    return t;
  }
  if (value.startsWith("sshhost:")) return { target: value.slice("sshhost:".length) };
  return null;
}

// ---- SSH: turning an agentSelect value into the real typed command --------
// "claude-work" / "codex-work" / "" (plain shell) pass
// through unchanged — the option value IS the command, same as always. SSH
// picks are encoded as "sshprofile:<name>" (a FleetView-managed profile,
// resolved via its stored host/port/user/identityFile) or "sshhost:<alias>"
// (an alias auto-discovered read-only from ~/.ssh/config — ssh itself applies
// the rest of that config). Either way, `sshAgentSelect` (the "and run …
// there" row, only shown once an SSH pick is made) optionally names an agent
// profile to launch on the REMOTE box. This function ONLY handles the
// terminal-view case (a plain interactive process typed into a real shell —
// see remoteAgentCmd() below for how each agent profile turns into
// what's actually typed remotely); the chat-view case is resolveRemoteTarget()
// above, which never builds a shell string at all.
function resolveCmd(value: string): string {
  const agentCmd = isSshValue(value) ? sshAgentSelect.value : "";
  if (value.startsWith("sshprofile:")) {
    const p = sshProfiles.find((p) => p.name === value.slice("sshprofile:".length));
    return p ? buildSshCommand(p, agentCmd) : "";
  }
  if (value.startsWith("sshhost:")) {
    const parts = ["ssh"];
    if (agentCmd) parts.push("-t");
    parts.push(shQuote(value.slice("sshhost:".length)));
    if (agentCmd) parts.push(shQuote(remoteAgentCmd(agentCmd)));
    return parts.join(" ");
  }
  return value;
}
function buildSshCommand(p: SshProfile, agentCmd: string): string {
  const parts = ["ssh"];
  if (agentCmd) parts.push("-t"); // force a pty — needed for an interactive remote command
  if (p.port && p.port !== 22) parts.push("-p", String(p.port));
  if (p.identityFile) parts.push("-o", "IdentitiesOnly=yes", "-i", shQuote(p.identityFile));
  parts.push(shQuote(`${p.user}@${p.host}`));
  if (agentCmd) parts.push(shQuote(remoteAgentCmd(agentCmd)));
  return parts.join(" ");
}
// Turns an sshAgentSelect value into what actually gets typed on the REMOTE
// host, then falls back to an interactive login shell when the agent exits
// (so quitting claude/codex doesn't just drop the ssh connection).
//
// The "-work" profiles can't rely on the local
// `claude-work` wrapper script existing remotely (~/.local/bin/claude-work is
// a local PATH convenience, not something any given remote box has) — instead
// they set the same env var that script sets, inline: CLAUDE_CONFIG_DIR for
// claude, CODEX_HOME for codex (same mapping agent-manager.js uses for the
// local SDK-driven "-work" panes, agent-manager.js:108-112). This assumes the
// remote account has its own ~/.claude-work / ~/.codex-work set up — same
// assumption the local "-work" picker options already make about this
// machine.
function remoteAgentCmd(agentCmd: string): string {
  const p = machine.profiles.find((x) => x.id === agentCmd);
  // A personal account runs the bare CLI; a work account can't rely on a local
  // `*-work` wrapper existing on the remote box, so it sets the same env var
  // that wrapper sets, inline.
  const run = !p
    ? agentCmd
    : p.account === "work"
      ? `${p.provider === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"}="$HOME/.${p.provider}-work" ${p.provider}`
      : p.provider;
  return `${run}; exec $SHELL -l`;
}
// POSIX single-quote escaping, so a value with spaces/special chars still
// types as one literal argument into the pane's shell.
function shQuote(s: string): string {
  return "'" + s.replace(/'/g, `'\\''`) + "'";
}
function prettyPath(p: string): string {
  if (pickHome && (p === pickHome || p.startsWith(pickHome + "/")))
    return "~" + p.slice(pickHome.length);
  return p;
}

document.getElementById("addBtn")!.addEventListener("click", openPicker);
document.getElementById("pcancel")!.addEventListener("click", closePicker);

// ---- Settings dropdown ------------------------------------------------
// Holds everything except "+ Terminal", on every screen size (this replaced the
// old ☰-on-mobile-only menu, so the bar is now identical on a phone and a
// desktop). Visibility is the .open class, not the `hidden` attribute — the
// attribute is only in the markup to prevent a flash before CSS loads.
const settingsBtn = document.getElementById("settingsBtn")!;
const settingsPanel = document.getElementById("settings") as HTMLElement;
settingsPanel.hidden = false;

function closeSettings() {
  settingsPanel.classList.remove("open");
  settingsBtn.classList.remove("active");
}
settingsBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  const open = settingsPanel.classList.toggle("open");
  settingsBtn.classList.toggle("active", open);
  if (open) {
    settingsBtn.classList.remove("hasnews"); // you've now seen it
    settingsBtn.title = "Settings";
  }
});
settingsPanel.addEventListener("click", (e) => {
  // Toggles and sliders leave the panel open — you often flip two at once. The
  // ACTIONS (open/save a layout, show tasks, jump to the next waiting terminal)
  // close it, since each one hands the screen over to something else.
  if ((e.target as HTMLElement).closest("#openBtn, #saveBtn, #tasksBtn, #nextBtn"))
    closeSettings();
});
document.addEventListener("click", (e) => {
  if (!settingsPanel.classList.contains("open")) return;
  if (e.target === settingsBtn || settingsPanel.contains(e.target as Node)) return;
  closeSettings();
});
document.getElementById("popen")!.addEventListener("click", () => pickPath && choose(pickPath));
picker.addEventListener("click", (e) => {
  if (e.target === picker) closePicker(); // click backdrop to dismiss
});

// ---- Control socket (grid-level events) -------------------------------
let controlWs: WebSocket | null = null;
// ---- Deep links from a tapped notification -----------------------------
// A notification carries `#pane=<id>`. The fragment is the only part of the URL
// that survives clients.openWindow() into a cold-started app in a form we can
// read on boot — but we can't act on it immediately, because no pane exists
// until the first `panes` snapshot arrives over the control socket. So it's
// parked here and consumed there, once.
let pendingDeepLink: string | null = (() => {
  const m = /(?:^|[#&])pane=([^&]+)/.exec(location.hash);
  return m ? decodeURIComponent(m[1]) : null;
})();

function consumeDeepLink() {
  if (!pendingDeepLink) return;
  const t = panes.get(pendingDeepLink);
  pendingDeepLink = null;
  if (!t) return; // the pane died between the push and the tap
  zoom(t);
  // Drop the fragment so a later refresh doesn't re-zoom, without adding a
  // history entry.
  history.replaceState(null, "", `${location.pathname}${location.search}`);
}

// The service worker talks to us for two things: a tapped notification that
// found this window already open (focus-pane), and a courtesy heads-up that a
// push arrived (push-attention). The latter is only a hint — the control socket
// is the authority on pane state and the two race by design.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", (ev: MessageEvent) => {
    const m = ev.data || {};
    if (m.t === "focus-pane" && m.pane) {
      const t = panes.get(m.pane);
      if (t) zoom(t);
      else pendingDeepLink = m.pane; // not here yet — let the next snapshot catch it
    }
  });
}

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
        consumeDeepLink(); // panes only exist now — see the note on pendingDeepLink
        break;
      }
      case "created": {
        undormant(m.pane.id); // a respawn lands here — drop its recovery chip
        // A view flip broadcasts `closed` then `created` with `replaces` set to
        // the old id, which is what lets the new box reclaim the old one's slot.
        const slot = vacated;
        vacated = null;
        const at = slot !== null && slot.id === m.replaces ? slot.at : undefined;
        addTerm(m.pane, at);
        break;
      }
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
      case "usage":
        usageRows = m.usage || [];
        renderUsage();
        pushUsageToPanes();
        break;
      // A pane's driver reported which model it resolved to (agent-manager.js).
      case "model":
        panes.get(m.pane)?.setModel(m.model);
        break;
      case "usage-reset":
        onUsageReset(m);
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
      case "work":
        panes.get(m.pane)?.setBusy(m.on);
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
      case "ssh-profiles":
        loadSshProfiles(); // an SSH server profile was added/edited/removed in some window
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

// ---- SSH servers --------------------------------------------------------
// Two sources, merged in the picker's "SSH" optgroup: FleetView-managed
// profiles (sshProfiles, editable via the Manage… modal, key/agent auth
// only — see server/ssh-profiles.js) and aliases auto-discovered read-only
// from ~/.ssh/config (sshHosts — see server/ssh-hosts.js). FleetView never
// writes to ~/.ssh/config; it only reads it.
type SshProfile = { name: string; host: string; port: number; user: string; identityFile?: string };
type SshHost = { alias: string; hostName: string; user: string; port: number };
let sshProfiles: SshProfile[] = [];
let sshHosts: SshHost[] = [];

async function loadSshProfiles() {
  sshProfiles = await fetch("/api/ssh-profiles").then((r) => r.json());
  renderSshOptions();
  renderSshManagerList();
}
async function loadSshHosts() {
  sshHosts = await fetch("/api/ssh-hosts").then((r) => r.json());
  renderSshOptions();
  renderSshManagerList();
}

function renderSshOptions() {
  const keep = agentSelect.value;
  sshOptGroup.innerHTML = "";
  for (const p of sshProfiles) {
    const o = document.createElement("option");
    o.value = "sshprofile:" + p.name;
    o.textContent = p.name;
    sshOptGroup.append(o);
  }
  for (const h of sshHosts) {
    const o = document.createElement("option");
    o.value = "sshhost:" + h.alias;
    o.textContent = h.alias + " (~/.ssh/config)";
    sshOptGroup.append(o);
  }
  // Re-selecting the same value after rebuilding options only "sticks" if it
  // still exists (e.g. a profile that was just deleted falls back to claude).
  agentSelect.value = keep;
  if (agentSelect.value !== keep) agentSelect.value = machine.accounts[0] || "";
  updateChatViewAvailability();
  updateSshRunRow();
}

// ---- SSH server manager modal -------------------------------------------
const sshManager = document.getElementById("sshManager") as HTMLElement;
const sshList = document.getElementById("sshList")!;
const sshEdit = document.getElementById("sshEdit") as HTMLElement;
const sshEditTitle = document.getElementById("sshEditTitle")!;
const sshNameEl = document.getElementById("sshName") as HTMLInputElement;
const sshHostEl = document.getElementById("sshHost") as HTMLInputElement;
const sshPortEl = document.getElementById("sshPort") as HTMLInputElement;
const sshUserEl = document.getElementById("sshUser") as HTMLInputElement;
const sshIdentityEl = document.getElementById("sshIdentity") as HTMLInputElement;
let sshEditOriginalName: string | null = null; // set when editing, so Save can rename via delete+create

function openSshManager() {
  sshManager.hidden = false;
  renderSshManagerList();
}
function closeSshManager() {
  sshManager.hidden = true;
}
function renderSshManagerList() {
  if (sshManager.hidden) return;
  sshList.innerHTML = "";
  if (!sshProfiles.length) {
    const empty = document.createElement("div");
    empty.className = "prow empty";
    empty.textContent = "no saved servers yet — “+ Add server” below";
    sshList.append(empty);
  }
  for (const p of sshProfiles) {
    const row = document.createElement("div");
    row.className = "prow sshrow";
    const nm = document.createElement("span");
    nm.className = "nm";
    const main = document.createElement("span");
    main.textContent = p.name;
    const sub = document.createElement("span");
    sub.className = "sub";
    sub.textContent = `${p.user}@${p.host}${p.port !== 22 ? ":" + p.port : ""}${p.identityFile ? " · " + p.identityFile : ""}`;
    nm.append(main, sub);
    const actions = document.createElement("span");
    actions.className = "ssh-actions";
    const edit = document.createElement("button");
    edit.textContent = "✎";
    edit.title = "Edit";
    edit.onclick = () => openSshEdit(p);
    const del = document.createElement("button");
    del.className = "ssh-del";
    del.textContent = "✕";
    del.title = "Delete";
    del.onclick = () => deleteSshProfile(p.name);
    actions.append(edit, del);
    row.append(nm, actions);
    sshList.append(row);
  }
  if (sshHosts.length) {
    const label = document.createElement("div");
    label.className = "prow empty";
    label.textContent = "From ~/.ssh/config (read-only):";
    sshList.append(label);
    for (const h of sshHosts) {
      const row = document.createElement("div");
      row.className = "prow sshrow";
      const nm = document.createElement("span");
      nm.className = "nm";
      const main = document.createElement("span");
      main.textContent = h.alias;
      const sub = document.createElement("span");
      sub.className = "sub";
      sub.textContent = h.user ? `${h.user}@${h.hostName}` : h.hostName;
      nm.append(main, sub);
      row.append(nm);
      sshList.append(row);
    }
  }
}
function openSshEdit(p?: SshProfile) {
  sshEditOriginalName = p ? p.name : null;
  sshEditTitle.textContent = p ? "Edit SSH server" : "Add SSH server";
  sshNameEl.value = p?.name ?? "";
  sshHostEl.value = p?.host ?? "";
  sshPortEl.value = p ? String(p.port) : "";
  sshUserEl.value = p?.user ?? "";
  sshIdentityEl.value = p?.identityFile ?? "";
  sshEdit.hidden = false;
  sshNameEl.focus();
}
function closeSshEdit() {
  sshEdit.hidden = true;
}
async function saveSshProfile() {
  const name = sshNameEl.value.trim();
  const host = sshHostEl.value.trim();
  const user = sshUserEl.value.trim();
  if (!name || !host || !user) {
    alert("Name, host, and user are required.");
    return;
  }
  const renaming = sshEditOriginalName && sshEditOriginalName !== name;
  // Renaming onto another profile's name would silently overwrite it (save()
  // upserts by name) — confirm rather than clobber it quietly.
  if (renaming && sshProfiles.some((p) => p.name === name)) {
    if (!confirm(`“${name}” already exists — replace it?`)) return;
  }
  // Renaming = a new record under the new name; drop the old one so it
  // doesn't linger as a duplicate.
  if (renaming) {
    await fetch(`/api/ssh-profiles/${encodeURIComponent(sshEditOriginalName!)}`, { method: "DELETE" });
  }
  const r = await fetch("/api/ssh-profiles", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name,
      host,
      user,
      port: sshPortEl.value ? Number(sshPortEl.value) : 22,
      identityFile: sshIdentityEl.value.trim(),
    }),
  }).then((r) => r.json());
  if (r?.error) {
    alert("Couldn't save: " + r.error);
    return;
  }
  closeSshEdit();
  await loadSshProfiles(); // also arrives via the "ssh-profiles" broadcast, but don't wait on it
}
async function deleteSshProfile(name: string) {
  if (!confirm(`Delete saved server “${name}”?`)) return;
  await fetch(`/api/ssh-profiles/${encodeURIComponent(name)}`, { method: "DELETE" });
  await loadSshProfiles();
}

document.getElementById("sshManageBtn")!.addEventListener("click", () => {
  closeSettings();
  openSshManager();
});
document.getElementById("sshManagerClose")!.addEventListener("click", closeSshManager);
document.getElementById("sshAddBtn")!.addEventListener("click", () => openSshEdit());
document.getElementById("sshEditCancel")!.addEventListener("click", closeSshEdit);
document.getElementById("sshEditSave")!.addEventListener("click", saveSshProfile);
sshManager.addEventListener("click", (e) => {
  if (e.target === sshManager) closeSshManager();
});
sshEdit.addEventListener("click", (e) => {
  if (e.target === sshEdit) closeSshEdit();
});

// ---- Usage (subscription limits, per account) --------------------------
// Rows are per ACCOUNT, not per pane: every claude box draws on the same
// 5-hour bucket, so a row per box would repeat the same number N times.
// Reading these costs no tokens (see server/usage.js), so the server polls on
// a timer and also takes free pushes from live panes.

const usageListEl = document.getElementById("usageList")!;
const usageRefreshEl = document.getElementById("usageRefresh") as HTMLButtonElement;
let usageRows: UsageRow[] = [];

/** Colour by headroom, so a row that's about to bite reads as urgent. */
// ONE ramp, shared with the usage rings in each chat pane's tools row
// (usageLevel in agent-chat.ts). If these two ever disagree the same account
// reads green on a ring and amber in this panel.
function usageLevel(pct: number): string {
  if (pct >= 90) return "crit";
  if (pct >= 75) return "warn";
  return "ok";
}

/** "6:59 PM" today, "Thu 6:59 PM" beyond it — a bare time would be a lie. */
function resetLabel(at: number | null): string {
  if (!at) return "";
  const d = new Date(at);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? time : `${d.toLocaleDateString([], { weekday: "short" })} ${time}`;
}

function renderUsage() {
  usageListEl.innerHTML = "";
  if (!usageRows.length) {
    const empty = document.createElement("div");
    empty.className = "use-empty";
    empty.textContent = "No agent accounts detected.";
    usageListEl.append(empty);
    return;
  }
  for (const row of usageRows) {
    const el = document.createElement("div");
    el.className = "use-row";

    const head = document.createElement("div");
    head.className = "use-head";
    const name = document.createElement("span");
    name.className = "use-name";
    name.textContent = row.label;
    head.append(name);
    if (row.plan) {
      const plan = document.createElement("span");
      plan.className = "use-plan";
      plan.textContent = row.plan;
      head.append(plan);
    }
    el.append(head);

    if (!row.available || !row.primary) {
      const err = document.createElement("div");
      err.className = "use-err";
      // The claude reader leans on an SDK method upstream flags EXPERIMENTAL,
      // whose name is documented to change. When that happens this row degrades
      // to a message instead of taking the panel down with it.
      err.textContent = row.error ? `unavailable — ${row.error}` : "no plan limits on this account";
      el.append(err);
      usageListEl.append(el);
      continue;
    }

    const p = row.primary;
    const bar = document.createElement("div");
    bar.className = `use-bar ${usageLevel(p.percent)}`;
    const fill = document.createElement("i");
    fill.style.width = `${p.percent}%`;
    bar.append(fill);
    el.append(bar);

    const meta = document.createElement("div");
    meta.className = "use-meta";
    const pctEl = document.createElement("span");
    pctEl.className = `use-pct ${usageLevel(p.percent)}`;
    pctEl.textContent = `${p.percent}%`;
    const win = document.createElement("span");
    win.className = "use-win";
    win.textContent = p.resetsAt ? `${p.label} · resets ${resetLabel(p.resetsAt)}` : p.label;
    meta.append(pctEl, win);
    if (row.secondary) {
      const sec = document.createElement("span");
      sec.className = "use-sec";
      sec.textContent = `${row.secondary.label} ${row.secondary.percent}%`;
      meta.append(sec);
    }
    el.append(meta);
    usageListEl.append(el);
  }
}

/**
 * A window rolled over. The server announces this exactly once per window and
 * persists what it already reported, so a restart can't repeat it.
 */
function onUsageReset(m: { label: string; window: string; account: string }) {
  const text = `${m.label}: fresh ${m.window} window`;
  if (getSettings().notify && "Notification" in window && Notification.permission === "granted") {
    try {
      const n = new Notification(text, { body: "Your limit reset — starting from zero.", tag: `reset-${m.account}` });
      n.onclick = () => {
        window.focus();
        n.close();
      };
    } catch {
      /* some browsers throw outside a service worker — the badge below still shows it */
    }
  }
  // Always leave a visible mark, even with notifications off or denied: the
  // point is that you find out without having to go looking.
  settingsBtn.classList.add("hasnews");
  settingsBtn.title = text;
}

usageRefreshEl.addEventListener("click", async (e) => {
  e.stopPropagation();
  usageRefreshEl.disabled = true;
  usageRefreshEl.classList.add("spin");
  try {
    usageRows = await fetch("/api/usage/refresh", { method: "POST" }).then((r) => r.json());
    renderUsage();
  } catch {
    /* leave the last-known rows up rather than blanking the panel */
  } finally {
    usageRefreshEl.disabled = false;
    usageRefreshEl.classList.remove("spin");
  }
});

// ---- Settings controls ------------------------------------------------
// The panel is the only place these live now. Values are server-backed (see
// settings.ts) so they follow you between devices; this section just binds them
// to the DOM and re-applies on change.
const soundEl = document.getElementById("setSound") as HTMLInputElement;
const volumeEl = document.getElementById("setVolume") as HTMLInputElement;
const volRow = document.getElementById("volRow")!;
const notifyEl = document.getElementById("setNotify") as HTMLInputElement;
const notifyNote = document.getElementById("notifyNote")!;
const confirmCloseEl = document.getElementById("setConfirmClose") as HTMLInputElement;
const pushDeviceEl = document.getElementById("setPushDevice") as HTMLInputElement;
const pushNote = document.getElementById("pushNote")!;
const pushCats = document.getElementById("pushCats")!;
const pushQuestionEl = document.getElementById("setPushQuestion") as HTMLInputElement;
const pushDoneEl = document.getElementById("setPushDone") as HTMLInputElement;

/** Mark the selected button in a segmented control. */
function seg(id: string, value: string) {
  for (const b of document.querySelectorAll<HTMLButtonElement>(`#${id} button`))
    b.classList.toggle("on", b.dataset.v === value);
}
/** Segmented controls replaced the old cycling icon buttons (◍ / A⁺ / ☀): in a
 *  settings panel the current value should be readable at a glance, not
 *  inferred from which glyph the button happens to be showing. */
function wireSeg(id: string, apply: (v: string) => void) {
  document.getElementById(id)!.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("button") as HTMLButtonElement | null;
    if (!b?.dataset.v) return;
    apply(b.dataset.v);
    applySettings();
  });
}

function applySettings() {
  const s = getSettings();
  document.body.classList.toggle("light", s.theme === "light");
  document.body.classList.toggle("big", s.text === "big");
  // The .busy/.idle classes on each box stay authoritative regardless — only
  // the CSS that reacts to them is gated, so changing this is instant and never
  // loses a pane's actual state.
  for (const f of FX_ORDER) document.body.classList.toggle("fx-" + f, s.fx === f);

  const theme = xtermTheme(s.theme === "light");
  const fs = xtermFontSize(s.text === "big");
  for (const t of panes.values()) t.setAppearance(theme, fs);

  // Reflect state back into the controls. Also covers the post-load reconcile,
  // where the server's values can differ from the mirror we booted on.
  seg("segTheme", s.theme);
  seg("segText", s.text);
  seg("segFx", s.fx);
  soundEl.checked = s.sound;
  volumeEl.value = String(s.volume);
  volRow.classList.toggle("off", !s.sound);
  notifyEl.checked = s.notify;
  confirmCloseEl.checked = s.confirmClose;
  pushQuestionEl.checked = s.pushQuestion;
  pushDoneEl.checked = s.pushDone;
  // The device switch is NOT a pref — it reflects whether this device actually
  // holds a push subscription, which only push.ts knows.
  pushDeviceEl.checked = pushActive();
  pushCats.setAttribute("aria-disabled", pushActive() ? "false" : "true");

  renderQueue(); // favicon colours come from CSS vars — repaint after a theme flip
}

wireSeg("segTheme", (v) => patchSettings({ theme: v as Settings["theme"] }));
wireSeg("segText", (v) => patchSettings({ text: v as Settings["text"] }));
wireSeg("segFx", (v) => patchSettings({ fx: v as Settings["fx"] }));

soundEl.addEventListener("change", () => {
  patchSettings({ sound: soundEl.checked });
  applySettings();
  if (soundEl.checked) play("question", getSettings().volume / 100); // preview
});
// `change`, not `input`: dragging the slider would otherwise fire a tone per
// pixel. The preview is the point of the control — you can't set a volume you
// can't hear.
volumeEl.addEventListener("change", () => {
  patchSettings({ volume: Number(volumeEl.value) });
  if (getSettings().sound) play("question", getSettings().volume / 100);
});

/** Ask the browser for notification permission, reporting why it failed.
 *  Note for iOS: Safari only grants this to a page installed to the home
 *  screen, so the checkbox can legitimately refuse to stay on in mobile Safari. */
async function ensureNotifyPermission(): Promise<boolean> {
  notifyNote.hidden = true;
  if (!("Notification" in window)) {
    notifyNote.textContent = "This browser doesn't support notifications.";
    notifyNote.hidden = false;
    return false;
  }
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") {
    notifyNote.textContent =
      "Notifications are blocked for this site. Enable them in your browser's site settings, then try again.";
    notifyNote.hidden = false;
    return false;
  }
  const res = await Notification.requestPermission();
  if (res !== "granted") {
    notifyNote.textContent =
      "Permission wasn't granted. On iOS, add FleetView to your home screen first.";
    notifyNote.hidden = false;
  }
  return res === "granted";
}
notifyEl.addEventListener("change", async () => {
  // Only persist `true` once the browser has actually granted permission —
  // otherwise the setting reads "on" while nothing can ever fire.
  const on = notifyEl.checked ? await ensureNotifyPermission() : false;
  patchSettings({ notify: on });
  applySettings();
});
confirmCloseEl.addEventListener("change", () => {
  patchSettings({ confirmClose: confirmCloseEl.checked });
  applySettings();
});

// Push, per device. This handler IS the user gesture that iOS requires before
// Notification.requestPermission() will resolve to anything but "denied", which
// is why enabling can't happen at boot or from a settings reconcile.
pushDeviceEl.addEventListener("change", async () => {
  pushNote.hidden = true;
  if (!pushDeviceEl.checked) {
    await disablePush();
    applySettings();
    return;
  }
  const res = await enablePush();
  if (!res.ok) {
    // Say what went wrong rather than letting the checkbox silently spring
    // back — on iPhone the reason is almost always the fixable "add it to your
    // Home Screen first", which is worth spelling out.
    pushNote.textContent = res.reason || "Couldn't enable push on this device.";
    pushNote.hidden = false;
  }
  applySettings();
});
pushQuestionEl.addEventListener("change", () => {
  patchSettings({ pushQuestion: pushQuestionEl.checked });
  applySettings();
});
pushDoneEl.addEventListener("change", () => {
  patchSettings({ pushDone: pushDoneEl.checked });
  applySettings();
});

// ---- Boot -------------------------------------------------------------
applySettings(); // instant, from the localStorage mirror; loadPrefs() reconciles with the server
connectControl();
// Before anything reads machine.accounts: the picker's options, the agent
// whitelist and the badge image all come from it.
void loadMachine();
loadLayouts();
loadSshProfiles();
loadSshHosts();
loadPrefs();
setCurrentLayout(currentLayout); // restore the indicator after a refresh
renderQueue(); // draw the idle favicon / base title before any attention arrives
initTasks(); // task-list sidebar (tree arrives via the control socket)
// Register the service worker and re-validate an existing subscription. Never
// prompts (see push.ts); applySettings() afterwards so the per-device checkbox
// reflects the subscription we just confirmed rather than defaulting to off.
void initPush(SESSION).then(applySettings);
loadIdentity(); // name this machine in the top bar + tab title

/**
 * Ask the server which machine this is (see server/identity.js). One workspace
 * = one machine, so with two of these open — a laptop's and a box's — the bar
 * and tab strip need to say which host's shells you're looking at. Best-effort:
 * on failure the UI just keeps the generic "FleetView" branding.
 */
async function loadIdentity() {
  try {
    const { label } = await fetch("/api/identity").then((r) => r.json());
    if (!label) return;
    brandEl.textContent = `▦ ${label}`;
    brandEl.title = `FleetView on ${label}`;
    setAppLabel(label);
  } catch {
    /* keep the default branding */
  }
}
