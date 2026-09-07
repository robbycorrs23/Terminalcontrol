import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { hostname } from "node:os";

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
 *   FLEET_ICON_COLOR  one of the palette dirs under client/public/icons/.
 *
 * ⚠ iOS caches an installed web app's name AND icon at install time. Changing
 * either means deleting and re-adding the app on that device — the running
 * server can't push it.
 */

export const ICON_COLORS = ["blue", "violet", "green", "amber", "red", "teal"];

/** Stable per-machine fallback so two machines don't collide by default: pick
 *  from the palette by hashing the label, rather than everyone getting blue. */
function colorFromLabel(label) {
  let h = 0;
  for (let i = 0; i < label.length; i++) h = (h * 31 + label.charCodeAt(i)) >>> 0;
  return ICON_COLORS[h % ICON_COLORS.length];
}

export function createIdentity(publicDir) {
  // Short hostname: "docholliday.local" / "DID2200.tail...ts.net" -> "docholliday" / "did2200".
  // Lowercased because macOS reports a capitalised hostname ("DID2200") while
  // the tailnet name everyone actually reads is lowercase. An explicit
  // FLEET_LABEL is left exactly as typed.
  const label = (
    process.env.FLEET_LABEL ||
    hostname().split(".")[0].toLowerCase() ||
    "FleetView"
  ).slice(0, 40);

  const requested = process.env.FLEET_ICON_COLOR;
  let color = colorFromLabel(label);
  if (requested) {
    if (ICON_COLORS.includes(requested)) color = requested;
    else {
      console.warn(
        `[fleetview] FLEET_ICON_COLOR="${requested}" is not one of ${ICON_COLORS.join(", ")} — using "${color}".`
      );
    }
  }

  // resolve(), not join(): res.sendFile() throws on a relative path, so a
  // caller passing a relative dir would 500 on every icon — and a broken icon
  // is precisely what makes iOS refuse to install the app with no useful error.
  // Guarantee absolute here rather than trusting every call site.
  const dir = resolve(publicDir, "icons", color);
  if (!existsSync(dir)) {
    // A build that predates the palette, or a bad checkout. Warn rather than
    // 404 every icon silently — a missing icon is exactly what makes iOS refuse
    // to install the app, with no useful error.
    console.warn(`[fleetview] icon set ${dir} is missing — run scripts/make-icons.sh`);
  }

  return {
    label,
    color,
    /** Absolute path to one of the colour's icon files. */
    iconPath: (file) => join(dir, file),

    /**
     * Public URL for one of the colour's icons — COLOUR-SCOPED on purpose.
     *
     * These used to be stable paths (/icon-192.png) with the server choosing
     * the bytes, which seemed tidy: nothing outside this module needed to know
     * about palettes. It was wrong. iOS caches a Home Screen icon per URL, so
     * a machine that had ever served blue from /apple-touch-icon.png kept
     * showing blue after the colour changed — the install sheet previewed the
     * new colour and the installed tile stayed stale. A URL that changes with
     * the colour is the only thing that reliably beats that cache.
     *
     * These are plain files under dist/icons/<colour>/, so express.static
     * already serves them; no route needed. gate.js allows the whole /icons/
     * prefix unauthenticated for the same reason the manifest is allowed.
     */
    iconHref: (file) => `/icons/${color}/${file}`,
    /** The web app manifest, built fresh so the name follows FLEET_LABEL. */
    manifest: () => ({
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
      // Colour-scoped URLs — see iconHref above for why stable ones were a bug.
      icons: [
        { src: `/icons/${color}/icon-192.png`, sizes: "192x192", type: "image/png" },
        { src: `/icons/${color}/icon-512.png`, sizes: "512x512", type: "image/png" },
        {
          src: `/icons/${color}/icon-maskable-512.png`,
          sizes: "512x512",
          type: "image/png",
          purpose: "maskable",
        },
      ],
    }),
  };
}
