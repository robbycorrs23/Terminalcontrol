/**
 * Git facts on every box: which branch a session is on, and whether another
 * session is editing the same files.
 *
 *   branch chip   shown when a pane is NOT on its repo's main line — its own
 *                 worktree ("Own branch" sessions) or any other branch — so
 *                 parallel sessions are tellable apart at a glance. A box on
 *                 main shows nothing: that's the normal case, and chrome on
 *                 every box would be noise.
 *   overlap chip  "Also edited in <session>: app.js" — two sessions of one
 *                 repo touching the same file, which will collide at merge
 *                 time even when they're in separate worktrees.
 *
 * Data: GET /api/panes-git (cached 10s server-side) and GET /api/overlaps,
 * refetched on created/closed, when a turn ends, and every 30s. Each lives in
 * its own `.git-slot` in the title bar — never `.badge-slot`, which
 * setWaiting() wipes on every attention change.
 */
import { iconSvg } from "./icons";
import type { PaneView } from "./terminal";

export type PaneGit = { branch: string; worktree: boolean; base: string | null };
export type Overlap = { pane: string; name: string; files: string[] };

let gitByPane: Record<string, PaneGit> = {};
let overlapsByPane: Record<string, Overlap[]> = {};
let getPanes: () => Iterable<PaneView> = () => [];
let timer: number | undefined;
let pending: number | undefined;

const MAIN_LINE = /^(main|master|trunk|develop)$/;

export function gitOf(id: string): PaneGit | undefined {
  return gitByPane[id];
}
export function overlapsOf(id: string): Overlap[] {
  return overlapsByPane[id] || [];
}

export function initGitStatus(panes: () => Iterable<PaneView>) {
  getPanes = panes;
  void refreshGit();
  timer = window.setInterval(() => void refreshGit(), 30000);
  void timer;
}

/** Coalesced refetch — call freely from socket events. */
export function scheduleGitRefresh(delay = 600) {
  if (pending != null) clearTimeout(pending);
  pending = window.setTimeout(() => {
    pending = undefined;
    void refreshGit();
  }, delay);
}

async function refreshGit() {
  if (document.hidden) return;
  const [g, o] = await Promise.all([
    fetch("/api/panes-git", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    fetch("/api/overlaps", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]);
  if (g) gitByPane = g;
  if (o) overlapsByPane = o;
  for (const t of getPanes()) decorateGit(t);
}

function slotOf(t: PaneView): HTMLElement {
  let slot = t.titleBar.querySelector(".git-slot") as HTMLElement | null;
  if (!slot) {
    slot = document.createElement("span");
    slot.className = "git-slot";
    const anchor = t.titleBar.querySelector(".spacer");
    if (anchor) anchor.before(slot);
    else t.titleBar.append(slot);
  }
  return slot;
}

/** Draw (or clear) a box's branch + overlap chips and its phone subline. */
export function decorateGit(t: PaneView) {
  const g = gitByPane[t.id];
  const ov = overlapsByPane[t.id] || [];
  const slot = slotOf(t);
  slot.textContent = "";
  const showBranch = !!g && !!g.branch && g.branch !== "HEAD" && (g.worktree || !MAIN_LINE.test(g.branch));
  if (showBranch) {
    const chip = document.createElement("span");
    chip.className = `git-chip${g.worktree ? " own" : ""}`;
    chip.innerHTML = iconSvg("branch"); // static markup; the name goes in via textContent
    const name = document.createElement("span");
    name.textContent = g.branch.replace(/^fleet\//, "");
    chip.append(name);
    chip.title = `${g.worktree ? "Own branch (separate worktree)" : "Branch"}: ${g.branch}${g.base ? ` · from ${g.base}` : ""}`;
    slot.append(chip);
  }
  if (ov.length) {
    const chip = document.createElement("span");
    chip.className = "git-chip overlap";
    chip.innerHTML = iconSvg("alert");
    const n = document.createElement("span");
    const files = new Set(ov.flatMap((o) => o.files));
    n.textContent = String(files.size);
    chip.append(n);
    chip.title = ov.map((o) => `Also edited in "${o.name}": ${o.files.join(", ")}`).join("\n");
    chip.setAttribute("aria-label", chip.title);
    slot.append(chip);
  }
  // Phone nav bar: "folder · branch" under the name.
  const sub = t.titleBar.querySelector(".pane-sub") as HTMLElement | null;
  if (sub) {
    const parts = (t.info.cwd || "").split("/").filter(Boolean);
    const folder = parts.length > 2 ? parts.slice(-2).join("/") : t.info.cwd || "";
    // A worktree's folder is ~/.fleetview/worktrees/<repo>/<slug> — the repo name says more.
    const where = g?.worktree && parts.length >= 2 ? parts[parts.length - 2] : folder;
    sub.textContent = showBranch ? `${where} · ${g!.branch.replace(/^fleet\//, "")}` : folder;
  }
}
