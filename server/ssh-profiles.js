import { readFileSync, writeFileSync, existsSync } from "node:fs";

const MAX_STR = 256;

/**
 * JSON-backed store for user-added SSH server profiles — modeled directly on
 * LayoutStore (see layout-store.js). A profile is intentionally minimal and
 * key/agent-auth only (no password field, no secret material of any kind):
 *   { name, host, port, user, identityFile }
 *
 * FleetView never writes to ~/.ssh/config or anywhere under ~/.ssh — that
 * directory is only ever *read* (see ssh-hosts.js, a separate read-only
 * discovery path). A profile here is turned into a plain `ssh ...` command
 * line client-side and typed into a fresh pane exactly like the "claude" /
 * "codex" startup commands already are (see pty-manager.js's _runStartup) —
 * no core pty/tmux changes needed for this feature.
 *
 * File shape: { profiles: { [name]: { name, host, port, user, identityFile } } }
 */
export class SshProfileStore {
  constructor(file) {
    this.file = file;
    let raw = {};
    if (existsSync(file)) {
      try {
        raw = JSON.parse(readFileSync(file, "utf8"));
      } catch (e) {
        console.warn(`[fleetview] could not read ${file} (${e.message}); starting with no saved SSH profiles.`);
        raw = {};
      }
    }
    this.data = { profiles: raw && typeof raw.profiles === "object" && raw.profiles ? raw.profiles : {} };
  }

  _persist() {
    try {
      writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    } catch (e) {
      console.warn(`[fleetview] could not write ${this.file}: ${e.message}`);
    }
  }

  list() {
    return Object.values(this.data.profiles);
  }

  get(name) {
    return this.data.profiles[name];
  }

  /**
   * Upsert by name. Validates and whitelists fields — nothing but
   * {name, host, port, user, identityFile} is ever persisted, and every
   * string is trimmed + length-capped since these values end up interpolated
   * (quoted) into a literal shell command line typed into a pane.
   */
  save(profile) {
    if (!profile || typeof profile !== "object") throw new Error("profile is required");
    const name = String(profile.name || "").trim().slice(0, MAX_STR);
    const host = String(profile.host || "").trim().slice(0, MAX_STR);
    const user = String(profile.user || "").trim().slice(0, MAX_STR);
    if (!name) throw new Error("name is required");
    if (!host) throw new Error("host is required");
    if (!user) throw new Error("user is required");

    let port = parseInt(profile.port, 10);
    if (!Number.isFinite(port) || port <= 0) port = 22;
    port = Math.min(65535, Math.max(1, port));

    const identityFileRaw = String(profile.identityFile || "").trim().slice(0, 512);

    const clean = { name, host, user, port };
    if (identityFileRaw) clean.identityFile = identityFileRaw;

    this.data.profiles[name] = clean;
    this._persist();
    return clean;
  }

  remove(name) {
    delete this.data.profiles[name];
    this._persist();
  }
}
