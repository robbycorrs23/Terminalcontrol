import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * JSON-backed Web Push subscriptions — one row per device that asked to be
 * notified.
 *
 * File shape: { subscriptions: [ { endpoint, p256dh, auth, origin, session,
 * label, createdAt, lastOkAt, lastErrorAt, failures } ] }
 *
 * Stored 0600 in ~/.fleetview/, NOT in the repo root next to layouts.json. A
 * push endpoint URL is a capability: anyone holding one can send notifications
 * to that device without any further credential. That puts this file in the
 * same class as pane-secrets.json rather than ssh-profiles.json.
 *
 * There is no per-device on/off flag here, on purpose: the EXISTENCE of a row
 * is the switch. A device that doesn't want pushes has no row, which means one
 * less piece of state that can disagree with itself across devices.
 */

const MAX_ROWS = 20; // a personal tool; 20 devices is already generous
const MAX_ENDPOINT_LEN = 1024;

/** Drop anything that isn't a plausible subscription before it reaches disk.
 *  Same spirit as task-store.js's sanitize(): this object came from a browser,
 *  so validate shape rather than trusting it. */
function clean(raw) {
  if (!raw || typeof raw !== "object") return null;

  const endpoint = typeof raw.endpoint === "string" ? raw.endpoint : "";
  // https only — a push endpoint is always https, and this also stops a
  // file:/data: URL from ever being handed to the sender.
  if (!/^https:\/\//.test(endpoint) || endpoint.length > MAX_ENDPOINT_LEN) return null;

  const keys = raw.keys && typeof raw.keys === "object" ? raw.keys : raw;
  const p256dh = typeof keys.p256dh === "string" ? keys.p256dh : "";
  const auth = typeof keys.auth === "string" ? keys.auth : "";
  if (!p256dh || !auth) return null;

  const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");

  return {
    endpoint,
    p256dh,
    auth,
    // Which origin this device actually reaches FleetView on. The server binds
    // loopback but you browse it via the tailnet hostname, so this is the only
    // way to build a deep link the phone can open.
    origin: str(raw.origin, 200),
    session: str(raw.session, 100),
    label: str(raw.label, 120),
  };
}

export class PushStore {
  constructor(file) {
    this.file = file;
    this.data = { subscriptions: [] };
    if (existsSync(file)) {
      try {
        const raw = JSON.parse(readFileSync(file, "utf8"));
        this.data.subscriptions = Array.isArray(raw.subscriptions) ? raw.subscriptions : [];
      } catch (e) {
        console.warn(
          `[fleetview] could not read ${file} (${e.message}); starting with no push subscriptions.`
        );
      }
    }
  }

  _persist() {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    } catch (e) {
      console.warn(`[fleetview] could not write ${this.file}: ${e.message}`);
    }
  }

  list() {
    return this.data.subscriptions;
  }

  count() {
    return this.data.subscriptions.length;
  }

  /**
   * Add or refresh a device. Keyed on `endpoint`, which is what the browser
   * hands us and what actually identifies a subscription — re-subscribing on
   * the same device usually yields a NEW endpoint, so the old row is left to be
   * pruned when the push service reports it gone (410/404).
   *
   * Returns the stored row, or null if the payload didn't look like a
   * subscription.
   */
  upsert(raw) {
    const row = clean(raw);
    if (!row) return null;

    const existing = this.data.subscriptions.find((s) => s.endpoint === row.endpoint);
    if (existing) {
      Object.assign(existing, row, { lastOkAt: Date.now(), failures: 0 });
      this._persist();
      return existing;
    }

    const fresh = { ...row, createdAt: Date.now(), lastOkAt: Date.now(), lastErrorAt: 0, failures: 0 };
    this.data.subscriptions.push(fresh);

    // Cap the list, dropping least-recently-successful first. Prevents a device
    // that re-subscribes on every launch from growing this file without bound.
    if (this.data.subscriptions.length > MAX_ROWS) {
      this.data.subscriptions.sort((a, b) => (b.lastOkAt || 0) - (a.lastOkAt || 0));
      this.data.subscriptions = this.data.subscriptions.slice(0, MAX_ROWS);
    }

    this._persist();
    return fresh;
  }

  remove(endpoint) {
    if (typeof endpoint !== "string" || !endpoint) return;
    const before = this.data.subscriptions.length;
    this.data.subscriptions = this.data.subscriptions.filter((s) => s.endpoint !== endpoint);
    if (this.data.subscriptions.length !== before) this._persist();
  }

  markOk(endpoint) {
    const row = this.data.subscriptions.find((s) => s.endpoint === endpoint);
    if (!row) return;
    row.lastOkAt = Date.now();
    row.failures = 0;
    this._persist();
  }

  /**
   * Record a delivery failure. Returns true when the row was dropped, either
   * because the push service said the subscription is gone for good (410/404)
   * or because it has failed too many times in a row to be worth keeping.
   */
  markFailed(endpoint, status) {
    const row = this.data.subscriptions.find((s) => s.endpoint === endpoint);
    if (!row) return false;

    if (status === 404 || status === 410) {
      this.remove(endpoint);
      return true;
    }

    row.lastErrorAt = Date.now();
    row.failures = (row.failures || 0) + 1;
    if (row.failures >= 10) {
      this.remove(endpoint);
      return true;
    }
    this._persist();
    return false;
  }
}
