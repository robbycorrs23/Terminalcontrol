import { execFile } from "node:child_process";
import { writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

/**
 * Keep every machine on the latest FleetView without anyone running git.
 *
 * Each machine runs its own checkout, so a change only reached the second one
 * after a manual `git pull` + restart. This does that by itself, carefully:
 *
 *  - Every FLEET_AUTO_UPDATE_MINUTES (default 5) it `git fetch`es.
 *  - It only ever FAST-FORWARDS a clean checkout of the branch it's on: any
 *    local edit (a machine someone is developing on — like the one this code
 *    was written on), local commits, or a diverged branch → it does nothing
 *    and says why. It never stashes, resets, or merges.
 *  - It waits for the fleet to be IDLE — no pane working, none waiting on an
 *    approval or answer — continuously for IDLE_MS, because a restart cuts off
 *    every chat pane's live turn (they resume, but the reply in flight is lost).
 *  - Then it pulls and exits 75, and the supervisor restarts it into the new
 *    code; the startup self-check installs changed deps and rebuilds the
 *    bundle. Open tabs then get the existing "FleetView was updated" chip.
 *  - It only runs under a SUPERVISOR (launchd's com.fleetview.server, or a
 *    systemd service): exiting a hand-started `npm start` would just stop it.
 *
 * The gate (a separate process) restarts itself when its own files change —
 * see watchOwnSource() in gate.js — so a pull that touches it lands too.
 *
 * FLEET_AUTO_UPDATE=0 turns it off. State for Settings → This machine:
 * ~/.fleetview/auto-update.json.
 */

const STATE_FILE = join(homedir(), ".fleetview", "auto-update.json");
const IDLE_MS = 2 * 60 * 1000;

function git(cwd, args, timeout = 60000) {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: String(stdout).trim(), err: String(stderr || err?.message || "").trim() })
    );
  });
}

/** Running under launchd/systemd, so an exit means "restart me", not "stop". */
export function supervised(env = process.env) {
  return /^com\.fleetview\./.test(env.XPC_SERVICE_NAME || "") || !!env.INVOCATION_ID;
}

/**
 * One check: is there a safe fast-forward waiting? Pure git, no side effects
 * beyond `git fetch`. Returns { status, detail, behind, branch }.
 *   status: "up-to-date" | "available" | "skipped" | "error"
 */
export async function checkForUpdate(repo) {
  const branch = (await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).out;
  if (!branch || branch === "HEAD") return { status: "skipped", detail: "not on a branch" };
  const up = await git(repo, ["rev-parse", "--abbrev-ref", "@{upstream}"]);
  if (!up.ok) return { status: "skipped", detail: `${branch} has no upstream`, branch };
  const fetched = await git(repo, ["fetch", "--quiet", "--prune"], 90000);
  if (!fetched.ok) return { status: "error", detail: `git fetch failed: ${fetched.err.split("\n")[0]}`, branch };
  // Tracked changes only — untracked files (local state, notes) never block a fast-forward of other paths.
  const dirty = (await git(repo, ["status", "--porcelain", "--untracked-files=no"])).out;
  const behind = Number((await git(repo, ["rev-list", "--count", "HEAD..@{upstream}"])).out) || 0;
  const ahead = Number((await git(repo, ["rev-list", "--count", "@{upstream}..HEAD"])).out) || 0;
  if (!behind) return { status: "up-to-date", detail: ahead ? `${ahead} local commit(s) not pushed` : "", branch, behind };
  if (dirty) return { status: "skipped", detail: `${behind} update(s) waiting, but this checkout has local edits`, branch, behind };
  if (ahead) return { status: "skipped", detail: `${behind} update(s) waiting, but ${branch} has local commits`, branch, behind };
  return { status: "available", detail: `${behind} update(s)`, branch, behind };
}

/**
 * @param {object} o
 * @param {string} o.repo                 checkout to update
 * @param {() => boolean} o.isIdle        true when no pane is working / waiting on you
 * @param {() => void} [o.beforeExit]     e.g. write a snapshot
 */
export function startAutoUpdate({ repo, isIdle, beforeExit = () => {}, env = process.env, timing = {} }) {
  // timing is for tests only; the defaults are the real behaviour.
  const idleMs = timing.idleMs ?? IDLE_MS;
  const firstCheckMs = timing.firstCheckMs ?? 30 * 1000;
  const applyEveryMs = timing.applyEveryMs ?? 20 * 1000;
  const state = { enabled: false, lastCheck: 0, status: "off", detail: "", pending: 0 };
  const save = () => {
    try {
      mkdirSync(dirname(STATE_FILE), { recursive: true });
      writeFileSync(STATE_FILE + ".tmp", JSON.stringify(state, null, 2));
      renameSync(STATE_FILE + ".tmp", STATE_FILE);
    } catch {}
  };
  if (env.FLEET_AUTO_UPDATE === "0") {
    state.detail = "turned off (FLEET_AUTO_UPDATE=0)";
    save();
    return { state };
  }
  if (!supervised(env)) {
    state.detail = "only runs as the auto-start service (npm run service:install)";
    save();
    return { state };
  }
  state.enabled = true;
  const every = Math.max(1, Number(env.FLEET_AUTO_UPDATE_MINUTES) || 5) * 60 * 1000;
  let idleSince = 0;
  let applying = false;

  async function tick() {
    if (applying) return;
    const r = await checkForUpdate(repo);
    state.lastCheck = Date.now();
    state.status = r.status;
    state.detail = r.detail || "";
    state.pending = r.status === "available" ? r.behind : 0;
    save();
    if (r.status !== "available") return;
    console.log(`[fleetview] update available (${r.detail}) — will install once every session is idle`);
  }

  // The idle watch runs more often than the fetch, so an update lands within a
  // minute or two of the fleet going quiet rather than up to `every` later.
  async function maybeApply() {
    if (applying || state.status !== "available") return;
    if (!isIdle()) {
      idleSince = 0;
      return;
    }
    if (!idleSince) idleSince = Date.now();
    if (Date.now() - idleSince < idleMs) return;
    applying = true;
    // Re-check right before acting: the tree or upstream may have moved.
    const r = await checkForUpdate(repo);
    if (r.status !== "available" || !isIdle()) {
      applying = false;
      return;
    }
    const pulled = await git(repo, ["merge", "--ff-only", "@{upstream}"], 120000);
    if (!pulled.ok) {
      state.status = "error";
      state.detail = `fast-forward failed: ${pulled.err.split("\n")[0]}`;
      save();
      applying = false;
      return;
    }
    state.status = "restarting";
    state.detail = `installed ${r.behind} update(s)`;
    state.lastApplied = Date.now();
    save();
    console.log(`[fleetview] installed ${r.behind} update(s) — restarting into them`);
    try {
      beforeExit();
    } catch {}
    process.exit(75); // the supervisor restarts us; self-check handles deps + bundle
  }

  setTimeout(() => void tick(), firstCheckMs).unref?.(); // not during startup
  setInterval(() => void tick(), every).unref?.();
  setInterval(() => void maybeApply(), applyEveryMs).unref?.();
  return { state };
}
