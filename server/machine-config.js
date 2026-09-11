/**
 * Per-machine settings: which agent accounts this install offers, what the
 * work badge looks like, and what this machine calls itself.
 *
 * WHY THIS EXISTS. FleetView is one workspace per machine (see
 * pane-registry.js), and the same checkout runs on several of them. Anything
 * that is a property of THIS machine rather than of the product therefore can't
 * live in the source: hardcoding "work accounts only" here put a work badge and
 * a work-only picker on a personal machine the moment that branch was pulled.
 * The rule of thumb: if two machines running this code would want different
 * answers, it belongs in this file, not in a module.
 *
 * WHERE IT LIVES. `~/.fleetview/machine.json` — outside the repo, so it is
 * never committed, never synced, and survives a fresh clone. `layouts.json`'s
 * prefs are already per-machine in the same spirit (theme, sound, picker
 * defaults); those are YOUR preferences, these are the MACHINE's facts.
 *
 * ENV STILL WINS. `FLEET_LABEL` / `FLEET_ICON_COLOR` override the stored values
 * so a headless or scripted install can still be configured without a UI. The
 * env-drop footgun documented in CLAUDE.md is exactly why they are no longer
 * the only way to set these.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DIR = join(homedir(), ".fleetview");
const FILE = join(DIR, "machine.json");

/**
 * Every account FleetView knows how to drive. The `-work` suffix is the whole
 * mechanism (see accountConfigDirFor in agent-manager.js): it picks the config
 * dir, and therefore which login the pane runs as. A machine offers whichever
 * of these it lists; nothing is inferred at runtime.
 */
export const ALL_PROFILES = [
  { id: "claude", provider: "claude", account: "personal", label: "claude" },
  { id: "claude-work", provider: "claude", account: "work", label: "claude (work)" },
  { id: "codex", provider: "codex", account: "personal", label: "codex" },
  { id: "codex-work", provider: "codex", account: "work", label: "codex (work)" },
];

const BY_ID = new Map(ALL_PROFILES.map((p) => [p.id, p]));

/** Where a profile's login lives. Personal accounts use the CLI's default dir. */
export function configDirOf(id) {
  const p = BY_ID.get(id);
  if (!p) return null;
  return p.account === "work" ? join(homedir(), `.${p.provider}-work`) : join(homedir(), `.${p.provider}`);
}

/** Which accounts are actually logged in on this machine (config dir present). */
export function installedProfiles() {
  return ALL_PROFILES.filter((p) => existsSync(configDirOf(p.id))).map((p) => p.id);
}

function readRaw() {
  if (!existsSync(FILE)) return null;
  try {
    const v = JSON.parse(readFileSync(FILE, "utf8"));
    return v && typeof v === "object" ? v : null;
  } catch {
    return null; // corrupt: fall back to defaults rather than refusing to boot
  }
}

function writeRaw(cfg) {
  try {
    mkdirSync(DIR, { recursive: true });
    const tmp = FILE + ".tmp";
    writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    renameSync(tmp, FILE);
    return true;
  } catch (e) {
    console.warn(`[fleetview] could not write ${FILE}: ${e.message}`);
    return false;
  }
}

/**
 * The accounts list is EXPLICIT — a machine states what it offers, so pulling a
 * branch can never change it. On a first run there is nothing to state yet, so
 * it is seeded once from the logins actually present and written down; from
 * then on it is a stored fact that only the settings panel changes. Seeding
 * beats starting empty: an install that offers no agent at all looks broken,
 * and every value is visible and editable immediately afterwards.
 */
export function read() {
  const raw = readRaw() || {};
  let accounts = Array.isArray(raw.accounts) ? raw.accounts.filter((id) => BY_ID.has(id)) : null;
  let seeded = false;
  if (!accounts) {
    accounts = installedProfiles();
    seeded = true;
  }
  return {
    label: raw.label || null,
    iconColor: raw.iconColor || null,
    accounts,
    badgeLogo: typeof raw.badgeLogo === "string" ? raw.badgeLogo : null,
    seeded, // true = never saved; the UI shows it as a suggestion to confirm
  };
}

/** Persist the seed the first time we hand it out, so it stops being a guess. */
export function ensureSeeded() {
  const cur = read();
  if (cur.seeded) writeRaw({ accounts: cur.accounts });
  return read();
}

export function update(patch) {
  const raw = readRaw() || {};
  const next = { ...raw };
  if (patch && Array.isArray(patch.accounts)) {
    next.accounts = patch.accounts.filter((id) => BY_ID.has(id));
  }
  if (patch && "label" in patch) next.label = patch.label ? String(patch.label).slice(0, 40) : null;
  if (patch && "iconColor" in patch) next.iconColor = patch.iconColor || null;
  if (patch && "badgeLogo" in patch) next.badgeLogo = patch.badgeLogo || null;
  writeRaw(next);
  return read();
}

/** Absolute path of the uploaded badge image, or null. */
export function badgeLogoPath() {
  const { badgeLogo } = read();
  if (!badgeLogo) return null;
  const file = join(DIR, badgeLogo);
  // Never let a stored value escape ~/.fleetview.
  if (!file.startsWith(DIR + "/") || badgeLogo.includes("/")) return null;
  return existsSync(file) ? file : null;
}

export function saveBadgeLogo(buf, ext) {
  mkdirSync(DIR, { recursive: true });
  const name = "badge-logo" + ext;
  // Drop any previous image with a different extension, so switching png -> svg
  // doesn't leave the old file lying around shadowed.
  for (const e of [".png", ".jpg", ".webp", ".svg"]) {
    if (e !== ext) {
      try {
        unlinkSync(join(DIR, "badge-logo" + e));
      } catch {}
    }
  }
  writeFileSync(join(DIR, name), buf, { mode: 0o600 });
  update({ badgeLogo: name });
  return name;
}

export function clearBadgeLogo() {
  const p = badgeLogoPath();
  if (p) {
    try {
      unlinkSync(p);
    } catch {}
  }
  update({ badgeLogo: null });
}

/** The profiles this machine offers, in catalogue order, as full objects. */
export function offeredProfiles() {
  const set = new Set(read().accounts);
  return ALL_PROFILES.filter((p) => set.has(p.id));
}

/** Default startup command for a new pane: this machine's first agent, if any. */
export function defaultAgentCmd() {
  return read().accounts[0] || "";
}
