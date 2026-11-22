#!/usr/bin/env node
/**
 * Regenerate the Home Screen icons: client/public/icons/<mark>-<colour>/.
 *
 * Committed artifacts — this script exists so they're reproducible, NOT as a
 * build step. Run it only when a mark or the palette changes:
 *   node scripts/make-icons.mjs
 * Needs macOS `sips` (preinstalled) or `rsvg-convert` (librsvg) on Linux.
 *
 * WHY MARKS *AND* COLOURS. Several installs can sit on one Home Screen (one
 * per machine — the workspace is per-machine), and they must be tellable
 * apart. The first palette varied only the TILE colour, which iOS throws away:
 * in dark Home Screen mode it swaps the background for its own dark tile, so
 * every install became the same grey squares, and "tinted" mode recolours
 * everything to one hue anyway. So now:
 *   - the tile is always dark, and the COLOUR is on the mark (a coloured glyph
 *     on a dark tile survives iOS dark mode — the dark variant looks like the
 *     light one);
 *   - the SHAPE differs per install (fleet / terminal / briefcase / house /
 *     code), which is the only thing that survives tinted mode.
 *
 * Why four compositions per set instead of one image at four sizes:
 *   icon-192/512        rounded tile, transparent corners — the plain
 *                       any-purpose icon most browsers show as-is.
 *   icon-maskable-512   FULL-BLEED, mark shrunk into the safe zone: Android
 *                       crops maskable icons to any shape, and anything outside
 *                       the centre 80% circle can be cut off.
 *   apple-touch-icon    FULL-BLEED and NOT pre-rounded: iOS applies its own
 *                       squircle, so a pre-rounded source gets rounded twice.
 * badge-96.png (notification badge) is a white silhouette — platforms recolour
 * it — and favicon.svg is the fleet mark in blue.
 *
 * Directory names are flat (<mark>-<colour>) on purpose: gate.js lets
 * /icons/<one-segment>/<file>.png through unauthenticated (iOS fetches icons
 * without credentials) and nothing deeper.
 */
import { writeFileSync, mkdirSync, rmSync, mkdtempSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "client/public/icons");

// [light, deep] gradient stops for the MARK. Bright enough on the dark tile,
// and kept far apart in hue — distinguishable at Home Screen size is the point.
export const COLORS = {
  blue: ["#8cc0ff", "#2f74ff"],
  violet: ["#d2b0ff", "#8a4dff"],
  green: ["#7ff0ad", "#16a352"],
  amber: ["#ffe08a", "#f08c00"],
  red: ["#ff9c9c", "#e0262b"],
  teal: ["#7af5e0", "#0c9c8c"],
};

const DARK = "#14171c"; // cut-outs inside a solid mark
// Marks on a 1024 grid, roughly a 560px footprint centred on 512.
export const MARKS = {
  // The FleetView mark: a 2x2 fleet, one tile lit with a prompt.
  fleet: (f = "url(#fg)", cut = DARK) => `
    <rect x="232" y="232" width="262" height="262" rx="64" fill="${f}"/>
    <path d="M292 312 l70 52 -70 52" fill="none" stroke="${cut}" stroke-width="36" stroke-linecap="round" stroke-linejoin="round"/>
    <rect x="384" y="398" width="76" height="34" rx="17" fill="${cut}"/>
    <rect x="548" y="250" width="226" height="226" rx="54" fill="${f}" fill-opacity="0.16" stroke="${f}" stroke-width="36"/>
    <rect x="250" y="548" width="226" height="226" rx="54" fill="${f}" fill-opacity="0.16" stroke="${f}" stroke-width="36"/>
    <rect x="548" y="548" width="226" height="226" rx="54" fill="${f}" fill-opacity="0.16" stroke="${f}" stroke-width="36"/>`,
  terminal: (f = "url(#fg)") => `
    <rect x="236" y="276" width="552" height="472" rx="70" fill="none" stroke="${f}" stroke-width="48"/>
    <path d="M354 432 l104 80 -104 80" fill="none" stroke="${f}" stroke-width="52" stroke-linecap="round" stroke-linejoin="round"/>
    <rect x="510" y="566" width="150" height="52" rx="26" fill="${f}"/>`,
  briefcase: (f = "url(#fg)", cut = DARK) => `
    <path d="M418 330 v-44 a40 40 0 0 1 40 -40 h108 a40 40 0 0 1 40 40 v44" fill="none" stroke="${f}" stroke-width="44" stroke-linejoin="round"/>
    <rect x="232" y="330" width="560" height="420" rx="72" fill="${f}"/>
    <rect x="232" y="486" width="560" height="34" fill="${cut}" opacity="0.55"/>
    <rect x="466" y="460" width="92" height="86" rx="20" fill="${cut}"/>`,
  house: (f = "url(#fg)", cut = DARK) => `
    <path d="M512 232 L812 476 a26 26 0 0 1 -16 46 h-36 v196 a40 40 0 0 1 -40 40 H304 a40 40 0 0 1 -40 -40 V522 h-36 a26 26 0 0 1 -16 -46 Z" fill="${f}"/>
    <rect x="452" y="566" width="120" height="192" rx="26" fill="${cut}"/>`,
  code: (f = "url(#fg)") => `
    <path d="M392 330 L232 512 L392 694" fill="none" stroke="${f}" stroke-width="64" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M632 330 L792 512 L632 694" fill="none" stroke="${f}" stroke-width="64" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M560 268 L464 756" fill="none" stroke="${f}" stroke-width="56" stroke-linecap="round" opacity="0.6"/>`,
};

// A FLAT tile: a background gradient looked no better at Home Screen size and
// doubled the bytes (smooth gradients barely compress) across 30 sets.
const BG = `<linearGradient id="bg"><stop offset="0" stop-color="#1c2027"/></linearGradient>`;
const FG = (c) => `<linearGradient id="fg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c[0]}"/><stop offset="1" stop-color="${c[1]}"/></linearGradient>`;

/** kind: plain (rounded, transparent corners) | full (full-bleed) | mask (full-bleed, mark in the safe zone). */
export function iconSvg(mark, color, kind) {
  const tile =
    kind === "plain"
      ? `<rect width="1024" height="1024" rx="230" fill="url(#bg)"/>`
      : `<rect width="1024" height="1024" fill="url(#bg)"/>`;
  // 0.8 keeps the mark's corners inside the maskable safe circle (80% of the canvas).
  const body = kind === "mask" ? `<g transform="translate(512 512) scale(0.8) translate(-512 -512)">${MARKS[mark]()}</g>` : MARKS[mark]();
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><defs>${BG}${FG(COLORS[color])}</defs>${tile}${body}</svg>`;
}

function render(svg, size, out, tmp) {
  const src = join(tmp, "in.svg");
  writeFileSync(src, svg);
  if (process.platform === "darwin") {
    execFileSync("sips", ["-s", "format", "png", "--resampleHeightWidth", String(size), String(size), src, "--out", out], { stdio: "ignore" });
  } else {
    execFileSync("rsvg-convert", ["-w", String(size), "-h", String(size), src, "-o", out]);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const tmp = mkdtempSync(join(tmpdir(), "fv-icons-"));
  try {
    rmSync(OUT, { recursive: true, force: true }); // drop sets for marks/colours that no longer exist
    for (const mark of Object.keys(MARKS)) {
      for (const color of Object.keys(COLORS)) {
        const dir = join(OUT, `${mark}-${color}`);
        mkdirSync(dir, { recursive: true });
        render(iconSvg(mark, color, "plain"), 192, join(dir, "icon-192.png"), tmp);
        render(iconSvg(mark, color, "plain"), 512, join(dir, "icon-512.png"), tmp);
        render(iconSvg(mark, color, "mask"), 512, join(dir, "icon-maskable-512.png"), tmp);
        render(iconSvg(mark, color, "full"), 180, join(dir, "apple-touch-icon.png"), tmp);
      }
      console.log(`  ${mark}: ${Object.keys(COLORS).join(" ")}`);
    }
    // Notification badge: white silhouette (cut-outs transparent via a mask-free solid mark).
    render(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="160 160 704 704">${MARKS.fleet("#ffffff", "none")}</svg>`,
      96,
      join(ROOT, "client/public/badge-96.png"),
      tmp
    );
    // Browser-tab favicon: the fleet mark, blue (tab.ts paints the attention dot over it).
    writeFileSync(join(ROOT, "client/public/favicon.svg"), iconSvg("fleet", "blue", "plain") + "\n");
    console.log(`[icons] done -> ${OUT}${existsSync(OUT) ? "" : " (missing?)"}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
