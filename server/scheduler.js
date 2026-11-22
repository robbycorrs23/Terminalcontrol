import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

/**
 * Scheduled sessions: "every weekday at 7:00, in ~/software/app, ask claude to
 * check CI and summarise what changed overnight". At the time, a fresh chat
 * session starts with that prompt; when it finishes, the normal turn-end path
 * summarises it (server/summary.js) and notifies you — always, for scheduled
 * runs, even with "finished" pushes off — and it's on the inbox's Finished list.
 *
 * Model (kept deliberately small):
 *  - A job = { name, cwd, cmd (agent profile), prompt, days [0-6, Sun=0],
 *    time "HH:MM" in THIS machine's local time, enabled }.
 *  - Due when the latest slot ≤ now is newer than both the last run and the
 *    moment the job was (re)armed — so creating or editing a job never fires a
 *    slot from earlier today.
 *  - Missed while the machine slept / the server was down: run ONCE on return
 *    if the slot is under CATCH_UP_MS old; older misses are skipped, never
 *    stacked.
 *  - Each run is a fresh session (startRun in index.js), which also retires
 *    the previous run's session if you're done with it.
 *
 * Per-machine (paths are this machine's): ~/.fleetview/schedules.json, 0600.
 */

const FILE = join(homedir(), ".fleetview", "schedules.json");
const CATCH_UP_MS = 6 * 60 * 60 * 1000;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** The most recent slot at or before `now` (a Date), or null if the job has no days. */
export function lastSlot(job, now = new Date()) {
  const m = TIME.exec(job.time || "");
  if (!m || !job.days?.length) return null;
  for (let back = 0; back < 8; back++) {
    const d = new Date(now);
    d.setDate(d.getDate() - back);
    d.setHours(Number(m[1]), Number(m[2]), 0, 0);
    if (d <= now && job.days.includes(d.getDay())) return d;
  }
  return null;
}

/** The next slot strictly after `now`. */
export function nextSlot(job, now = new Date()) {
  const m = TIME.exec(job.time || "");
  if (!m || !job.days?.length) return null;
  for (let ahead = 0; ahead < 8; ahead++) {
    const d = new Date(now);
    d.setDate(d.getDate() + ahead);
    d.setHours(Number(m[1]), Number(m[2]), 0, 0);
    if (d > now && job.days.includes(d.getDay())) return d;
  }
  return null;
}

/** Is a run due right now? Returns the slot (ms) to run for, or 0. */
export function dueSlot(job, now = new Date()) {
  if (!job.enabled) return 0;
  const slot = lastSlot(job, now);
  if (!slot) return 0;
  const t = slot.getTime();
  if (t <= Math.max(job.lastRunAt || 0, job.armedAt || 0)) return 0;
  if (now.getTime() - t > CATCH_UP_MS) return 0;
  return t;
}

/** Validate + normalise user input into a job (throws a readable Error). */
export function cleanJob(input, existing = null) {
  const name = String(input.name || "").trim().slice(0, 60);
  const cwd = String(input.cwd || "").trim().replace(/^~(?=\/|$)/, homedir());
  const cmd = String(input.cmd || "").trim();
  const prompt = String(input.prompt || "").trim().slice(0, 20000);
  const time = String(input.time || "").trim();
  const days = [...new Set((Array.isArray(input.days) ? input.days : []).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
  if (!name) throw new Error("Give it a name.");
  if (!prompt) throw new Error("What should it do? Write the prompt.");
  if (!TIME.test(time)) throw new Error("Pick a time.");
  if (!days.length) throw new Error("Pick at least one day.");
  if (!/^(claude|codex)(-[a-z]+)?$/.test(cmd)) throw new Error("Pick an agent.");
  let isDir = false;
  try {
    isDir = statSync(cwd).isDirectory();
  } catch {}
  if (!isDir) throw new Error(`That folder doesn't exist on this machine: ${cwd}`);
  const now = Date.now();
  return {
    id: existing?.id || randomBytes(6).toString("hex"),
    name,
    cwd,
    cmd,
    prompt,
    time,
    days,
    enabled: input.enabled === undefined ? existing?.enabled ?? true : !!input.enabled,
    createdAt: existing?.createdAt || now,
    // (Re)armed on every save: an edit never fires a slot that already passed today.
    armedAt: now,
    lastRunAt: existing?.lastRunAt || 0,
    lastPane: existing?.lastPane || null,
    lastError: null,
  };
}

/**
 * @param {{ startRun: (job) => string | Promise<string>, file?: string }} deps
 *   startRun creates the session and returns its pane id (throws on failure).
 */
export function createScheduler({ startRun, file = FILE }) {
  let jobs = [];
  try {
    if (existsSync(file)) jobs = JSON.parse(readFileSync(file, "utf8")).jobs || [];
  } catch (e) {
    console.warn(`[fleetview] could not read ${file}: ${e.message}`);
  }
  const save = () => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file + ".tmp", JSON.stringify({ jobs }, null, 2), { mode: 0o600 });
    renameSync(file + ".tmp", file);
  };
  const view = (j) => ({ ...j, nextRunAt: j.enabled ? nextSlot(j)?.getTime() || null : null });

  async function run(job, slot = Date.now()) {
    job.lastRunAt = slot;
    try {
      job.lastPane = await startRun(job);
      job.lastError = null;
      console.log(`[fleetview] scheduled session "${job.name}" started`);
    } catch (e) {
      job.lastError = e.message || String(e);
      console.warn(`[fleetview] scheduled session "${job.name}" failed: ${job.lastError}`);
    }
    save();
    return job;
  }

  let running = false;
  async function tick() {
    if (running) return;
    running = true;
    try {
      const now = new Date();
      for (const job of jobs) {
        const slot = dueSlot(job, now);
        if (slot) await run(job, slot);
      }
    } finally {
      running = false;
    }
  }
  const timer = setInterval(() => void tick(), 30 * 1000);
  timer.unref?.();
  setTimeout(() => void tick(), 10 * 1000).unref?.(); // catch up shortly after startup, not during it

  return {
    list: () => jobs.map(view),
    upsert(input) {
      const existing = input.id ? jobs.find((j) => j.id === input.id) : null;
      if (input.id && !existing) throw new Error("That schedule no longer exists.");
      const job = cleanJob(input, existing);
      jobs = existing ? jobs.map((j) => (j.id === job.id ? job : j)) : [...jobs, job];
      save();
      return view(job);
    },
    setEnabled(id, on) {
      const job = jobs.find((j) => j.id === id);
      if (!job) return null;
      job.enabled = !!on;
      if (on) job.armedAt = Date.now(); // re-enabling never back-fires a missed slot
      save();
      return view(job);
    },
    remove(id) {
      const before = jobs.length;
      jobs = jobs.filter((j) => j.id !== id);
      if (jobs.length !== before) save();
      return jobs.length !== before;
    },
    async runNow(id) {
      const job = jobs.find((j) => j.id === id);
      if (!job) throw new Error("That schedule no longer exists.");
      return view(await run(job));
    },
    tick,
    stop: () => clearInterval(timer),
  };
}
