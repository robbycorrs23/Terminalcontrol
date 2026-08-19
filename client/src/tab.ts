// Reflects "a terminal needs you" in the browser tab — title + a favicon dot — so
// you notice even when FleetView isn't the focused tab. One entry point,
// `setTabAttention`, driven from the attention queue in main.ts.

const BASE_TITLE = "▦ FleetView";

export type AttentionKind = "question" | "done";

let iconEl: HTMLLinkElement | null = null;
function iconLink(): HTMLLinkElement {
  if (iconEl) return iconEl;
  iconEl = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!iconEl) {
    iconEl = document.createElement("link");
    iconEl.rel = "icon";
    document.head.appendChild(iconEl);
  }
  // Remember the static SVG favicon (shipped in index.html) so the idle state
  // always falls back to a reliable, no-JS icon — only the attention dot needs
  // the canvas.
  if (baseHref === null) baseHref = iconEl.getAttribute("href") || "";
  return iconEl;
}

let baseHref: string | null = null;
// Avoid regenerating the favicon data URL when its visual state hasn't changed.
let lastIconKey = "";

/**
 * @param count number of terminals currently waiting on the user
 * @param name  folder name of the most-urgent one (queue head); "" if none
 * @param kind  its kind, or null when nothing is waiting
 */
export function setTabAttention(count: number, name: string, kind: AttentionKind | null) {
  document.title = count > 0 ? `(${count}) ${name} — FleetView` : BASE_TITLE;

  const key = count > 0 && kind ? kind : "idle";
  if (key === lastIconKey) return;
  const link = iconLink();
  lastIconKey = key;
  // Idle → restore the static SVG; attention → canvas with a colored dot.
  link.href = key === "idle" ? (baseHref || "") : drawFavicon(key as AttentionKind);
}

function drawFavicon(kind: AttentionKind | null): string {
  const S = 32;
  const canvas = document.createElement("canvas");
  canvas.width = S;
  canvas.height = S;
  const x = canvas.getContext("2d")!;

  // Rounded-square tile in brand blue — legible on both light and dark chrome.
  roundRect(x, 1, 1, S - 2, S - 2, 6);
  x.fillStyle = "#1f6feb";
  x.fill();

  // 2×2 grid of light cells → the "grid of terminals" mark.
  x.fillStyle = "#eaf2ff";
  const m = 7;
  const gap = 3;
  const cell = (S - 2 * m - gap) / 2;
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < 2; c++) {
      x.fillRect(m + c * (cell + gap), m + r * (cell + gap), cell, cell);
    }
  }

  // Attention dot badge, top-right: orange = needs you, yellow = done. Colours
  // come from the same CSS variables the boxes and chips use, so the favicon
  // can't drift out of sync with the palette (and follows light/dark too).
  if (kind) {
    x.beginPath();
    x.arc(S - 8, 8, 6, 0, Math.PI * 2);
    x.fillStyle = kind === "done" ? cssVar("--done", "#f5d142") : cssVar("--waiting", "#f0a35e");
    x.fill();
    x.lineWidth = 2;
    x.strokeStyle = "#0d1117";
    x.stroke();
  }

  return canvas.toDataURL("image/png");
}

/** Read a theme colour out of CSS, with a fallback for the pre-boot call. */
function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.body).getPropertyValue(name).trim();
  return v || fallback;
}

function roundRect(x: CanvasRenderingContext2D, px: number, py: number, w: number, h: number, r: number) {
  x.beginPath();
  x.moveTo(px + r, py);
  x.arcTo(px + w, py, px + w, py + h, r);
  x.arcTo(px + w, py + h, px, py + h, r);
  x.arcTo(px, py + h, px, py, r);
  x.arcTo(px, py, px + w, py, r);
  x.closePath();
}
