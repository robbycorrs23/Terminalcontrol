// Polls each account's subscription limits and announces window rollovers.
//
// Reading limits is free (see server/usage.js), so the interval is set by how
// fast the numbers meaningfully move, not by cost. Both CLIs also PUSH updates
// while you work, so `applyPush()` keeps active accounts live between polls and
// the timer mostly serves idle ones.
//
// State lives OUTSIDE the repo (~/.fleetview/) on purpose: it's per-machine
// runtime state, not project state, and index.js's repo-root JSON files are
// already a documented gotcha.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { detectAccounts, readAccount, readAll } from "./usage.js";

const POLL_MS = 15 * 60 * 1000;
const STATE_DIR = join(homedir(), ".fleetview");
const STATE_FILE = join(STATE_DIR, "usage-state.json");

export class UsageMonitor {
  /**
   * @param broadcastAll  (msg) => void — every window, like tasks
   * @param onRollover    (row, window) => void — fired ONCE per fresh window
   */
  constructor(broadcastAll, onRollover) {
    this.broadcastAll = broadcastAll;
    this.onRollover = onRollover;
    this.accounts = detectAccounts();
    this.rows = new Map(); // id -> row
    this.timer = null;
    // id -> resetsAt(ms) of the primary window we last announced. Persisted so
    // a server restart mid-window doesn't re-announce a rollover you already saw.
    this.seenResets = this._loadState();
  }

  _loadState() {
    try {
      const raw = JSON.parse(readFileSync(STATE_FILE, "utf8"));
      return new Map(Object.entries(raw?.seenResets || {}));
    } catch {
      return new Map(); // missing or corrupt — start fresh, costs one alert at most
    }
  }

  _saveState() {
    try {
      mkdirSync(STATE_DIR, { recursive: true });
      writeFileSync(STATE_FILE, JSON.stringify({ seenResets: Object.fromEntries(this.seenResets) }, null, 2));
    } catch {
      /* best-effort: losing this costs a duplicate alert, never correctness */
    }
  }

  start() {
    if (this.timer) return;
    this.refresh();
    this.timer = setInterval(() => this.refresh(), POLL_MS);
    this.timer.unref?.(); // never hold the process open
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Current rows, in detection order. */
  snapshot() {
    return this.accounts.map((a) => this.rows.get(a.id)).filter(Boolean);
  }

  /** Poll every account concurrently. Never throws. */
  async refresh() {
    try {
      const rows = await readAll(this.accounts);
      for (const row of rows) this._accept(row);
      this._broadcast();
    } catch (e) {
      console.warn(`[fleetview] usage refresh failed: ${e?.message || e}`);
    }
  }

  /** Re-poll one account (used right after a pane reports a limit change). */
  async refreshOne(id) {
    const acct = this.accounts.find((a) => a.id === id);
    if (!acct) return;
    this._accept(await readAccount(acct));
    this._broadcast();
  }

  /**
   * Merge a pushed partial from a live driver. The push carries one window, so
   * it updates that window in place and leaves the rest of the row alone —
   * a partial must never blank out fields the poll established.
   */
  applyPush(id, window) {
    if (!window?.label) return;
    const prev = this.rows.get(id);
    if (!prev) return; // nothing polled yet; the next refresh picks it up
    const key = prev.primary && prev.primary.label === window.label ? "primary"
      : prev.secondary && prev.secondary.label === window.label ? "secondary"
      : prev.primary ? null : "primary";
    if (!key) return;
    this._accept({ ...prev, [key]: window, available: true, error: null, fetchedAt: Date.now() });
    this._broadcast();
  }

  /**
   * Store a row and decide whether its primary window just rolled over.
   *
   * A rollover is "the reset timestamp moved forward" — that's the only signal
   * both providers agree on, and it's robust to the percentage going up as well
   * as down (a fresh window can already be non-zero by the time we look).
   * Announced at most once per window because `seenResets` is only ever
   * advanced, never rewound.
   */
  _accept(row) {
    const prev = this.rows.get(row.id);
    this.rows.set(row.id, row);

    const at = row.primary?.resetsAt;
    if (!row.available || !at) return;
    const seen = this.seenResets.get(row.id);
    this.seenResets.set(row.id, at);
    if (seen === undefined) {
      this._saveState(); // first sighting: record the baseline, don't announce
      return;
    }
    if (at > seen) {
      this._saveState();
      // Only announce if we'd actually observed the old window filling up —
      // a rollover we learn about from a cold start isn't news.
      if (prev) this.onRollover?.(row, row.primary);
    }
  }

  _broadcast() {
    this.broadcastAll?.({ t: "usage", usage: this.snapshot() });
  }
}
