import { readFileSync, writeFileSync, existsSync } from "node:fs";

const MAX_RECENTS = 10;

/**
 * Everything the client can persist through /api/prefs, with its default.
 *
 * These are USER settings, not machine state: they live here (server-side,
 * alongside layouts) rather than in each browser's localStorage so that the
 * phone and the laptop agree. The client keeps a localStorage mirror purely so
 * the first paint doesn't flash the wrong theme while this loads.
 *
 * Flat on purpose — setPrefs() merges shallowly, so a nested object would be
 * replaced wholesale by any partial patch that touched it.
 */
const DEFAULT_PREFS = {
  // Folder picker
  defaultDir: null,
  sort: "name",
  // Appearance
  theme: "dark", // "dark" | "light"
  text: "normal", // "normal" | "big"
  fx: "full", // working-terminal animation: "full" | "edge" | "off"
  // Alerts
  sound: true, // play a tone when a terminal needs you / finishes
  volume: 70, // 0-100, scales the generated tones
  notify: false, // OS notification when the tab is backgrounded (needs browser permission)
  // Safety
  confirmClose: false, // ask before ✕ kills a terminal
};

/**
 * JSON-backed persistent state: named layouts, a recent-folders list, and the
 * user's settings (see DEFAULT_PREFS).
 *
 * File shape ({ layouts, recents }):
 *   layouts[name] = { name, cmd?, slots: [{ cwd, cmd? }] }
 *   recents       = [absolutePath, ...]  most-recent-first
 *
 * Live terminals are NOT stored here (they live in PtyManager); only the recipe
 * to recreate them (layouts) and the folders you've opened (recents).
 */
export class LayoutStore {
  constructor(file) {
    this.file = file;
    let raw = {};
    if (existsSync(file)) {
      try {
        raw = JSON.parse(readFileSync(file, "utf8"));
      } catch (e) {
        console.warn(`[fleetview] could not read ${file} (${e.message}); starting with no saved layouts.`);
        raw = {};
      }
    }
    // Migrate an older flat {name: layout} file into the new shape.
    if (raw.layouts === undefined && raw.recents === undefined) {
      raw = { layouts: raw && typeof raw === "object" ? raw : {}, recents: [] };
    }
    this.data = {
      layouts: raw.layouts || {},
      recents: raw.recents || [],
      // User preferences (picker, appearance, alerts, safety). Unknown keys from
      // an older/newer client are preserved; missing ones fall back to defaults.
      prefs: { ...DEFAULT_PREFS, ...(raw.prefs || {}) },
    };
  }

  _persist() {
    try {
      writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    } catch (e) {
      console.warn(`[fleetview] could not write ${this.file}: ${e.message}`);
    }
  }

  // --- Layouts ---
  list() {
    return Object.values(this.data.layouts);
  }
  get(name) {
    return this.data.layouts[name];
  }
  save(layout) {
    if (!layout || !layout.name) throw new Error("layout.name is required");
    this.data.layouts[layout.name] = {
      name: layout.name,
      cmd: layout.cmd,
      slots: Array.isArray(layout.slots) ? layout.slots : [],
    };
    this._persist();
  }
  remove(name) {
    delete this.data.layouts[name];
    this._persist();
  }

  // --- Recent folders ---
  recents() {
    return this.data.recents;
  }
  addRecent(path) {
    if (!path) return;
    this.data.recents = [
      path,
      ...this.data.recents.filter((p) => p !== path),
    ].slice(0, MAX_RECENTS);
    this._persist();
  }

  // --- Picker preferences ---
  prefs() {
    return this.data.prefs;
  }
  setPrefs(patch) {
    this.data.prefs = { ...this.data.prefs, ...patch };
    this._persist();
    return this.data.prefs;
  }
}
