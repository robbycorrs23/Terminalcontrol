// User settings: theme, text size, working-animation strength, alert sounds,
// notifications, and the confirm-before-close guard.
//
// These live SERVER-SIDE (layouts.json -> prefs, via /api/prefs) rather than in
// each browser's localStorage, so the phone and the laptop agree. That's the
// whole point — you set "large text, no sound" once, not once per device.
//
// The catch with a server round-trip is the first paint: we'd render dark and
// then flip to light a moment later. So localStorage is kept as a write-through
// MIRROR — never the source of truth, just a cache that lets boot paint the
// right thing immediately. Server values win as soon as they land.

const MIRROR = "fleet-settings";

/** Working-terminal animation strength (see the `.busy`/`.idle` rules in
 *  styles.css). "full" = travelling border light + Matrix rain + idle boxes
 *  dimmed; "edge" = the border light only, for a dense grid; "off" = nothing. */
export type WorkFx = "full" | "edge" | "off";
export const FX_ORDER: WorkFx[] = ["full", "edge", "off"];

/** Mirrors DEFAULT_PREFS in server/layout-store.js — same key names, so a
 *  patch is just the subset of this object that changed. */
export interface Settings {
  theme: "dark" | "light";
  text: "normal" | "big";
  fx: WorkFx;
  sound: boolean;
  volume: number; // 0-100
  notify: boolean;
  confirmClose: boolean;
}

const DEFAULTS: Settings = {
  theme: "dark",
  text: "normal",
  fx: "full",
  sound: true,
  volume: 70,
  notify: false,
  confirmClose: false,
};

/** Coerce anything (server JSON, a stale mirror, a hand-edited file) into a
 *  valid Settings. Every field is validated: a bad value falls back to its
 *  default rather than poisoning the UI. */
function coerce(raw: any): Settings {
  const r = raw && typeof raw === "object" ? raw : {};
  const num = Number(r.volume);
  return {
    theme: r.theme === "light" ? "light" : "dark",
    text: r.text === "big" ? "big" : "normal",
    fx: FX_ORDER.find((f) => f === r.fx) ?? DEFAULTS.fx,
    sound: r.sound === undefined ? DEFAULTS.sound : !!r.sound,
    volume: Number.isFinite(num) ? Math.min(100, Math.max(0, num)) : DEFAULTS.volume,
    notify: !!r.notify,
    confirmClose: !!r.confirmClose,
  };
}

/** Read the mirror, migrating the pre-settings localStorage keys the appearance
 *  toggles used to write. Runs once at module load, so an existing user's theme
 *  survives the upgrade instead of snapping back to dark. */
function readMirror(): Settings {
  try {
    const cached = localStorage.getItem(MIRROR);
    if (cached) return coerce(JSON.parse(cached));
  } catch {
    /* unparseable mirror — fall through to the legacy keys / defaults */
  }
  const legacy = {
    theme: localStorage.getItem("fleet-theme") === "light" ? "light" : "dark",
    text: localStorage.getItem("fleet-text") === "big" ? "big" : "normal",
    fx: localStorage.getItem("fleet-fx") ?? DEFAULTS.fx,
  };
  return coerce(legacy);
}

let current: Settings = readMirror();

function writeMirror() {
  try {
    localStorage.setItem(MIRROR, JSON.stringify(current));
  } catch {
    /* private mode / quota — the server copy is authoritative anyway */
  }
}

export function getSettings(): Settings {
  return current;
}

// --- Server sync -------------------------------------------------------

/** Raw PUT of a prefs patch. Also used by the folder picker for sort/defaultDir,
 *  which live in the same prefs object but aren't part of Settings. */
export async function putPrefs(patch: object) {
  return fetch("/api/prefs", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  }).then((r) => r.json());
}

// Coalesce rapid changes (dragging the volume slider) into one PUT.
let pending: Partial<Settings> = {};
let timer: number | undefined;
function flush() {
  const patch = pending;
  pending = {};
  timer = undefined;
  if (Object.keys(patch).length) void putPrefs(patch);
}

/**
 * Apply a change locally (synchronously — callers can read getSettings()
 * immediately) and schedule the server write. Deliberately fire-and-forget: a
 * failed PUT costs you the cross-device sync of that one toggle, not the
 * toggle itself, and blocking the UI on the network to flip a theme is worse.
 */
export function patchSettings(patch: Partial<Settings>) {
  current = coerce({ ...current, ...patch });
  writeMirror();
  Object.assign(pending, patch);
  if (timer === undefined) timer = window.setTimeout(flush, 250);
}

/**
 * Fetch the authoritative settings at boot. Returns the FULL prefs object, so
 * the caller also gets the picker's `sort`/`defaultDir` out of the same
 * request rather than fetching /api/prefs twice.
 */
export async function loadSettings(): Promise<any> {
  const raw = await fetch("/api/prefs").then((r) => r.json());
  current = coerce(raw);
  writeMirror();
  return raw;
}

// --- xterm helpers -----------------------------------------------------
// The UI chrome reacts to settings via body classes (CSS), but xterm needs its
// colors and font size handed to it in JS — at construction and on every change.

export function xtermTheme(light = current.theme === "light") {
  return light
    ? {
        background: "#ffffff",
        foreground: "#1f2328",
        cursor: "#1f2328",
        cursorAccent: "#ffffff",
        selectionBackground: "#b6dcff",
      }
    : {
        background: "#000000",
        foreground: "#c9d1d9",
        cursor: "#c9d1d9",
        selectionBackground: "#3b5070",
      };
}

export function xtermFontSize(big = current.text === "big") {
  return big ? 17 : 12;
}
