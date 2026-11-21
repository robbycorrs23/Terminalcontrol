import type { UsageWindow } from "./terminal";
import { el } from "./chat-steps";

/**
 * Turn a model id into something that fits a badge: "claude-opus-4-5-20260315"
 * -> "Opus 4.5". Falls back to the raw id minus the vendor prefix and date
 * suffix, so an unrecognised model still reads as something rather than
 * vanishing — the full id is always on the title attribute.
 */
export function shortModel(id: string): string {
  const m = /(opus|sonnet|haiku)[-_]?(\d+)(?:[-.](\d+))?/i.exec(id);
  if (!m) return id.replace(/^claude-/, "").replace(/-\d{8}$/, "");
  const name = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
  return m[3] ? `${name} ${m[2]}.${m[3]}` : `${name} ${m[2]}`;
}

/** "5-hour" -> "5h", "7-day" -> "7d". Codex labels are data-driven, so fall back. */
export function winShort(label: string): string {
  const m = /^(\d+)[-\s]*(hour|day|week|min)/i.exec(label);
  if (!m) return label.slice(0, 3);
  return m[1] + m[2][0].toLowerCase();
}

/**
 * A usage window as a small ring meter. This is the "single ratio against a
 * limit" case, so it is a meter, not a pie — and the percentage is ALWAYS
 * rendered in normal ink beside/inside the ring, never conveyed by colour
 * alone. That matters twice over: status colour must carry a label to be
 * accessible, and the amber step is deliberately low-contrast on a light
 * surface, so the numeral is what stays readable.
 */
const RING_NS = "http://www.w3.org/2000/svg";

export function usageRing(win: UsageWindow): HTMLElement {
  const size = 20; // sits inside the 28px pill alongside its label
  const stroke = 3;
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, Math.round(win.percent)));

  const wrap = el("span", "ring " + usageLevel(pct));
  const svg = document.createElementNS(RING_NS, "svg");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.setAttribute("aria-hidden", "true"); // the text below carries it for AT

  const mk = (cls: string, dash?: string) => {
    const c = document.createElementNS(RING_NS, "circle");
    c.setAttribute("cx", String(size / 2));
    c.setAttribute("cy", String(size / 2));
    c.setAttribute("r", String(r));
    c.setAttribute("fill", "none");
    c.setAttribute("stroke-width", String(stroke));
    c.setAttribute("class", cls);
    if (dash) {
      c.setAttribute("stroke-dasharray", dash);
      c.setAttribute("stroke-linecap", "round");
      // start at 12 o'clock instead of 3
      c.setAttribute("transform", `rotate(-90 ${size / 2} ${size / 2})`);
    }
    return c;
  };
  svg.append(mk("ring-track"));
  if (pct > 0) svg.append(mk("ring-fill", `${(pct / 100) * circ} ${circ}`));

  const num = el("b", "ring-num");
  num.textContent = String(pct);
  const tag = el("i", "ring-tag");
  tag.textContent = winShort(win.label);

  const face = el("span", "ring-face");
  face.append(svg, num);
  wrap.append(face, tag);
  wrap.title =
    `${win.label}: ${pct}% used` + (win.resetsAt ? ` · resets ${resetAt(win.resetsAt)}` : "");
  return wrap;
}

/** The ONE usage ramp — chat rings, context meter and the settings panel bars all use it. */
export function usageLevel(pct: number): string {
  if (pct >= 90) return "crit";
  if (pct >= 75) return "warn";
  return "ok";
}

export function resetAt(at: number): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const today = new Date().toDateString() === d.toDateString();
  return today ? time : `${d.toLocaleDateString([], { weekday: "short" })} ${time}`;
}
