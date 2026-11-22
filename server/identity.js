import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { hostname } from "node:os";
import * as machineConfig from "./machine-config.js";

/**
 * Which machine is this?
 *
 * Only interesting because the workspace is per-machine (see pane-registry.js):
 * you can have FleetView installed as an app for several machines at once, and
 * with one shared name and icon they are indistinguishable — on the Home
 * Screen, in the app switcher, and inside the running window. For a tool whose
 * boxes hold real shells on real hosts, "which machine am I typing into" should
 * never be a guess.
 *
 * So the server declares an identity, and it shows up in three places: the
 * manifest's name (the Home Screen caption), the icon bytes served from the
 * stable /icon-*.png URLs, and the in-app top bar + tab title.
 *
 *   FLEET_LABEL       display name. Defaults to the machine's short hostname.
 *   FLEET_ICON_COLOR  the mark's colour (ICON_COLORS).
 *   FLEET_ICON_MARK   the mark's SHAPE (ICON_MARKS) — fleet / terminal /
 *                     briefcase / house / code.
 * Env wins; otherwise Settings → This machine (machine.json), read LIVE on
 * every manifest / index.html request, so a change applies to the next
 * "Add to Home Screen" without a restart.
 *
 * Shape AND colour, because colour alone failed: the icon sets are a coloured
 * mark on a dark tile (scripts/make-icons.mjs explains why), and iOS's tinted
 * Home Screen mode recolours every icon to one hue — two installs then differ
 * only if their SHAPES do. Sets live in client/public/icons/<mark>-<colour>/.
 *
 * ⚠ iOS caches an installed web app's name AND icon at install time. Changing
 * either means deleting and re-adding the app on that device — the running
 * server can't push it.
 */

export const ICON_COLORS = ["blue", "violet", "green", "amber", "red", "teal"];
export const ICON_MARKS = ["fleet", "terminal", "briefcase", "house", "code"];

/** Stable per-machine fallback so two machines don't collide by default: pick
 *  from the palette by hashing the label, rather than everyone getting blue. */
function colorFromLabel(label) {
  let h = 0;
  for (let i = 0; i < label.length; i++) h = (h * 31 + label.charCodeAt(i)) >>> 0;
  return ICON_COLORS[h % ICON_COLORS.length];
}

export function createIdentity(publicDir) {
  const warned = new Set();
  const warnOnce = (msg) => {
    if (warned.has(msg)) return;
    warned.add(msg);
    console.warn(msg);
  };

  /** The current label / colour / mark — env > saved settings > defaults. */
  function current() {
    const saved = machineConfig.read();
    // Short hostname: "docholliday.local" / "DID2200.tail...ts.net" -> "docholliday" / "did2200".
    // Lowercased because macOS reports a capitalised hostname ("DID2200") while
    // the tailnet name everyone actually reads is lowercase. An explicit
    // FLEET_LABEL is left exactly as typed.
    const label = (process.env.FLEET_LABEL || saved.label || hostname().split(".")[0].toLowerCase() || "FleetView").slice(0, 40);

    const wantColor = process.env.FLEET_ICON_COLOR || saved.iconColor;
    let color = colorFromLabel(label);
    if (wantColor) {
      if (ICON_COLORS.includes(wantColor)) color = wantColor;
      else warnOnce(`[fleetview] icon colour "${wantColor}" is not one of ${ICON_COLORS.join(", ")} — using "${color}".`);
    }
    const wantMark = process.env.FLEET_ICON_MARK || saved.iconMark;
    let mark = "fleet";
    if (wantMark) {
      if (ICON_MARKS.includes(wantMark)) mark = wantMark;
      else warnOnce(`[fleetview] icon mark "${wantMark}" is not one of ${ICON_MARKS.join(", ")} — using "fleet".`);
    }
    // Is either value pinned by the environment (so Settings can't change it)?
    return { label, color, mark, envColor: !!process.env.FLEET_ICON_COLOR, envMark: !!process.env.FLEET_ICON_MARK };
  }

  // resolve(), not join(): res.sendFile() throws on a relative path, so a
  // caller passing a relative dir would 500 on every icon — and a broken icon
  // is precisely what makes iOS refuse to install the app with no useful error.
  const setDir = (mark, color) => resolve(publicDir, "icons", `${mark}-${color}`);
  const checkSet = (mark, color) => {
    const dir = setDir(mark, color);
    if (!existsSync(dir)) warnOnce(`[fleetview] icon set ${dir} is missing — run: node scripts/make-icons.mjs`);
    return dir;
  };
  {
    const c = current();
    checkSet(c.mark, c.color);
  }

  return {
    get label() {
      return current().label;
    },
    get color() {
      return current().color;
    },
    current,
    /** Absolute path to one of the current set's icon files. */
    iconPath: (file) => {
      const c = current();
      return join(checkSet(c.mark, c.color), file);
    },

    /**
     * Public URL for one of the current set's icons — SET-SCOPED on purpose.
     *
     * These used to be stable paths (/icon-192.png) with the server choosing
     * the bytes. It was wrong: iOS caches a Home Screen icon per URL, so a
     * machine that had ever served blue from /apple-touch-icon.png kept showing
     * blue after the colour changed — the install sheet previewed the new one
     * and the installed tile stayed stale. A URL that changes with the choice
     * is the only thing that reliably beats that cache.
     *
     * Plain files under dist/icons/<mark>-<colour>/, so express.static serves
     * them; gate.js allows /icons/<one-segment>/*.png unauthenticated (the
     * reason the directory names are flat).
     */
    iconHref: (file) => {
      const c = current();
      return `/icons/${c.mark}-${c.color}/${file}`;
    },
    /** The web app manifest, built fresh so the name and icon follow the settings. */
    manifest: () => {
      const { label, color, mark } = current();
      const base = `/icons/${mark}-${color}`;
      return {
        id: "/",
        start_url: "/",
        scope: "/",
        // The Home Screen caption. Two installs now read "docholliday" and
        // "did2200" instead of two tiles both saying "FleetView".
        name: `FleetView — ${label}`,
        short_name: label,
        description: "A grid of real terminals, one agent per box.",
        display: "standalone",
        background_color: "#0d1117",
        theme_color: "#0d1117",
        icons: [
          { src: `${base}/icon-192.png`, sizes: "192x192", type: "image/png" },
          { src: `${base}/icon-512.png`, sizes: "512x512", type: "image/png" },
          { src: `${base}/icon-maskable-512.png`, sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      };
    },
  };
}
