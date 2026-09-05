/**
 * A dependency-free chart renderer for the chat view.
 *
 * WHY HAND-ROLLED: the same reasoning as markdown.ts — this project is
 * dependency-light and ships no external assets, and a charting library
 * (Chart.js, Recharts, d3) would be 50-200KB of bundle to draw the four forms
 * an agent actually emits. Everything here is built with `createElementNS`, so
 * no chart path ever touches `innerHTML` and untrusted model output can only
 * ever become a text node or a NUMBER — see `num()`, which is the single gate
 * every value passes through.
 *
 * WHAT IT DRAWS: column, horizontal bar, line, area, donut, and stat-tile
 * forms, chosen either by an explicit ```chart block or by the "Chart" toggle
 * on a Markdown table (see agent-chat.ts). Every chart carries a table view —
 * that is not a nicety, it's the accessibility relief the palette's light-mode
 * contrast WARN obligates, and it's the fallback whenever a value can't be
 * direct-labelled.
 *
 * DESIGN RULES it implements (they are not arbitrary — deviating makes charts
 * that mislead): one y-axis, never two. Categorical hues assigned in fixed slot
 * order and never cycled — a 9th series folds into "Other". Marks are thin (a
 * bar is capped at 24px no matter how much room the band has), the data-end is
 * rounded 4px while the baseline stays square, adjacent fills are separated by
 * a 2px gap of surface rather than a stroke, and dots carry a 2px surface ring.
 * Gridlines are solid hairlines, never dashed. Text always wears a text token —
 * a series colour identifies a mark, never a label.
 */

const NS = "http://www.w3.org/2000/svg";

/** Categorical slots. The hexes live in styles.css so light/dark swap in one place. */
const SERIES_VARS = [
  "var(--viz-1)",
  "var(--viz-2)",
  "var(--viz-3)",
  "var(--viz-4)",
  "var(--viz-5)",
  "var(--viz-6)",
  "var(--viz-7)",
  "var(--viz-8)",
];
/** Past this, hues would have to be cycled or generated — fold the tail into "Other" instead. */
const MAX_SERIES = 8;
/** Part-to-whole only reads at a glance while the segments stay countable. */
const MAX_SLICES = 6;
const BAR_MAX = 24; // px — cap the mark, let the band's leftover be air
const BAR_RADIUS = 4; // px — on the data-end corners only
const GAP = 2; // px of surface between touching marks

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs?: Record<string, string | number>
): SVGElementTagNameMap[K] {
  const n = document.createElementNS(NS, tag);
  if (attrs) for (const k in attrs) n.setAttribute(k, String(attrs[k]));
  return n;
}

function div(cls: string, text?: string): HTMLElement {
  const n = document.createElement("div");
  n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

/**
 * The one gate every incoming value passes through. Accepts numbers and the
 * numeric strings a Markdown table is full of ("1,234", "$45.20", "87%",
 * "12s", "(3.1)" for negative, "1.2K"), and returns null for anything else so
 * a column of prose is never silently plotted as zeros.
 */
export function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  let s = v.trim();
  if (!s) return null;
  // Accounting negatives: (3.1) means -3.1.
  let sign = 1;
  if (/^\(.*\)$/.test(s)) {
    sign = -1;
    s = s.slice(1, -1);
  }
  // Strip currency/percent/unit decoration and thousands separators, but keep
  // a magnitude suffix so "1.2K" scales instead of parsing as 1.2.
  const mag = /([kmbt])\b/i.exec(s.replace(/[^0-9a-z.]/gi, ""));
  s = s.replace(/[,\s_]/g, "").replace(/^[^\d.\-+]+/, "").replace(/[^\d.\-+e]+$/i, "");
  // Stripping decoration off a word leaves the empty string, and Number("") is
  // 0 — so without this guard "yes", "N/A" and "web" all parse as a perfectly
  // finite zero. That's the single worst thing this function could do: a column
  // of prose would pass specFromTable's all-numeric check and get plotted as a
  // flat zero series, i.e. the chart would invent data that was never reported.
  if (!/\d/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  const scale = mag ? { k: 1e3, m: 1e6, b: 1e9, t: 1e12 }[mag[1].toLowerCase()]! : 1;
  return sign * n * scale;
}

/** Axis ticks and dense labels: 1234567 → "1.2M". */
function fmtCompact(n: number): string {
  const a = Math.abs(n);
  const unit = a >= 1e12 ? ["T", 1e12] : a >= 1e9 ? ["B", 1e9] : a >= 1e6 ? ["M", 1e6] : a >= 1e3 ? ["K", 1e3] : null;
  if (!unit) return trimZero(n);
  const scaled = n / (unit[1] as number);
  return (Math.abs(scaled) < 10 ? scaled.toFixed(1).replace(/\.0$/, "") : Math.round(scaled).toString()) + unit[0];
}
function trimZero(n: number): string {
  if (Number.isInteger(n)) return n.toLocaleString();
  return Number(n.toFixed(2)).toLocaleString();
}
/**
 * Join a formatted number to its unit. A compact number ends in a magnitude
 * letter, and jamming a unit straight onto it produces "4.1Kms" — so those get
 * a space, while "12%" and "8s" stay tight the way they're normally written.
 */
function withUnit(text: string, unit?: string): string {
  if (!unit) return text;
  return /[KMBT]$/.test(text) && /^[a-z]/i.test(unit) ? `${text} ${unit}` : text + unit;
}

/** Tooltips and the table view, where there's room for the real number. */
function fmtFull(n: number): string {
  return Number.isInteger(n) ? n.toLocaleString() : Number(n.toFixed(4)).toLocaleString();
}

/** Round the axis to 1/2/5×10ⁿ steps so ticks land on numbers a human would pick. */
function niceTicks(lo: number, hi: number, target = 4): number[] {
  if (!(hi > lo)) {
    // A flat series (every value identical) has no range to divide — give it a
    // baseline and the value itself rather than dividing by zero.
    const v = hi;
    return v === 0 ? [0, 1] : [Math.min(0, v), Math.max(0, v)];
  }
  const raw = (hi - lo) / target;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  // Snap OUTWARD on both ends. The axis is derived from these ticks, so a tick
  // list that stops short of `hi` produces a scale that doesn't contain its own
  // data — marks then render outside the plot instead of being clipped, which
  // reads as a chart that is simply wrong.
  const first = Math.floor(lo / step) * step;
  const last = Math.ceil(hi / step) * step;
  const out: number[] = [];
  for (let t = first; t <= last + step * 1e-9; t += step) {
    out.push(Math.abs(t) < step * 1e-9 ? 0 : Number(t.toPrecision(12)));
  }
  return out;
}

/**
 * A column/bar's data-end is rounded and its baseline stays square, so every
 * mark visibly grows FROM the axis. `dir` is the direction the bar grows.
 */
function barPath(x: number, y: number, w: number, h: number, dir: "up" | "right"): string {
  const r = Math.max(0, Math.min(BAR_RADIUS, dir === "up" ? Math.min(w / 2, h) : Math.min(h / 2, w)));
  if (dir === "up") {
    // (x,y) is the top-left of the mark; it grows upward to y from y+h.
    return `M${x},${y + h}V${y + r}a${r},${r} 0 0 1 ${r},-${r}h${w - 2 * r}a${r},${r} 0 0 1 ${r},${r}V${y + h}Z`;
  }
  return `M${x},${y}h${w - r}a${r},${r} 0 0 1 ${r},${r}v${h - 2 * r}a${r},${r} 0 0 1 -${r},${r}h-${w - r}Z`;
}

// ---- Spec ------------------------------------------------------------------

export type ChartSeries = { name: string; data: (number | null)[] };
export type ChartSpec = {
  type: "bar" | "hbar" | "line" | "area" | "donut" | "pie" | "stat";
  title?: string;
  labels: string[];
  series: ChartSeries[];
  unit?: string;
  /** Stat-tile only: a signed change, and whether up is the good direction. */
  delta?: number;
  goodDirection?: "up" | "down";
};

/**
 * Accepts the several shapes an agent plausibly emits and normalises them to
 * one internal spec. Deliberately permissive about INPUT SHAPE and strict about
 * VALUES: anything non-numeric becomes null (a gap), never 0.
 *
 * Understood forms:
 *   {type, labels:[…], series:[{name,data:[…]}]}     ← canonical
 *   {type, data:[{label,value}, …]}                  ← single series
 *   {type, data:{a:1, b:2}}                          ← object map
 *   {type, labels:[…], data:[1,2,3]}                 ← bare single series
 */
export function normalizeSpec(raw: unknown): ChartSpec | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const t = String(r.type || r.chart || "bar").toLowerCase();
  const type = (["bar", "column", "hbar", "line", "area", "donut", "pie", "stat"].includes(t)
    ? t === "column"
      ? "bar"
      : t
    : "bar") as ChartSpec["type"];

  let labels: string[] = Array.isArray(r.labels)
    ? (r.labels as unknown[]).map((x) => String(x))
    : Array.isArray(r.categories)
      ? (r.categories as unknown[]).map((x) => String(x))
      : [];
  let series: ChartSeries[] = [];

  const rawSeries = r.series ?? r.data ?? r.values;

  if (Array.isArray(rawSeries) && rawSeries.length && isSeriesLike(rawSeries[0])) {
    series = (rawSeries as Record<string, unknown>[]).map((s, i) => ({
      name: String(s.name ?? s.label ?? `Series ${i + 1}`),
      data: toNumArray(s.data ?? s.values ?? s.points),
    }));
  } else if (Array.isArray(rawSeries) && rawSeries.length && isPointLike(rawSeries[0])) {
    const pts = rawSeries as Record<string, unknown>[];
    labels = pts.map((p, i) => String(p.label ?? p.name ?? p.x ?? p.key ?? i + 1));
    series = [{ name: String(r.name ?? r.title ?? "Value"), data: pts.map((p) => num(p.value ?? p.y ?? p.count)) }];
  } else if (Array.isArray(rawSeries)) {
    series = [{ name: String(r.name ?? "Value"), data: toNumArray(rawSeries) }];
  } else if (rawSeries && typeof rawSeries === "object") {
    const entries = Object.entries(rawSeries as Record<string, unknown>);
    labels = entries.map(([k]) => k);
    series = [{ name: String(r.name ?? "Value"), data: entries.map(([, v]) => num(v)) }];
  }

  if (!series.length) return null;
  // Length is the longest of the labels and every series, so a short row is
  // padded out rather than truncating the axis — dropping a label the agent
  // explicitly listed would quietly hide a category.
  const len = Math.max(labels.length, ...series.map((s) => s.data.length));
  if (!len) return null;
  // Pad short rows to a gap rather than letting them read as a drop to zero.
  for (const s of series) while (s.data.length < len) s.data.push(null);
  while (labels.length < len) labels.push(String(labels.length + 1));
  labels = labels.slice(0, len);

  return {
    type,
    title: r.title ? String(r.title) : undefined,
    unit: r.unit ? String(r.unit) : undefined,
    delta: num(r.delta) ?? undefined,
    goodDirection: r.goodDirection === "down" ? "down" : "up",
    labels,
    series: foldTail(series),
  };
}

function isSeriesLike(v: unknown): boolean {
  return !!v && typeof v === "object" && ("data" in v || "values" in v || "points" in v);
}
function isPointLike(v: unknown): boolean {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return "value" in o || "y" in o || "count" in o;
}
function toNumArray(v: unknown): (number | null)[] {
  return Array.isArray(v) ? v.map(num) : [];
}

/**
 * Past the 8 categorical slots there is no 9th hue to assign — generating one
 * produces a colour indistinguishable from an existing slot under colour-vision
 * deficiency. Sum the tail into a single "Other" series instead.
 */
function foldTail(series: ChartSeries[]): ChartSeries[] {
  if (series.length <= MAX_SERIES) return series;
  const kept = series.slice(0, MAX_SERIES - 1);
  const tail = series.slice(MAX_SERIES - 1);
  const len = Math.max(...tail.map((s) => s.data.length));
  const merged: (number | null)[] = [];
  for (let i = 0; i < len; i++) {
    const vals = tail.map((s) => s.data[i]).filter((v): v is number => v != null);
    merged.push(vals.length ? vals.reduce((a, b) => a + b, 0) : null);
  }
  kept.push({ name: `Other (${tail.length})`, data: merged });
  return kept;
}

// ---- Rendering -------------------------------------------------------------

/**
 * Builds the whole figure: header (title + Chart/Table toggle), the plot, a
 * legend when there are two or more series, and the table view. Re-renders the
 * plot on width change, because a chat pane is resized constantly (zoom, grid
 * reflow, phone rotation) and a chart laid out for 320px is unreadable at 900.
 */
export function renderChart(spec: ChartSpec, opts: { toggle?: boolean } = {}): HTMLElement {
  // `toggle: false` is for callers that already own a chart/table switch — a
  // Markdown table's own Chart button flips back to the real table, so a
  // second toggle inside the chart would be two controls doing one job.
  const withToggle = opts.toggle !== false;
  const root = div("viz");
  const head = div("viz-head");
  // A stat tile renders its own label as part of the figure, so letting the
  // header print the title too would show the same words twice.
  if (spec.title && spec.type !== "stat") head.append(div("viz-title", spec.title));
  const plot = div("viz-plot");
  const table = buildTable(spec);
  table.hidden = true;

  if (withToggle) {
    const toggle = document.createElement("button");
    toggle.className = "viz-toggle";
    toggle.type = "button";
    toggle.textContent = "Table";
    toggle.title = "Show the underlying numbers";
    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      const showTable = table.hidden;
      table.hidden = !showTable;
      plot.hidden = showTable;
      toggle.textContent = showTable ? "Chart" : "Table";
    });
    head.append(toggle);
  }
  // An empty header (no title, no toggle) would still eat vertical space.
  if (head.childElementCount) root.append(head);
  root.append(plot, table);

  // Legend is the dependable identity channel — always present for ≥2 series,
  // omitted for one (there is only one colour; the title already names it).
  if (spec.series.length > 1 && spec.type !== "donut" && spec.type !== "pie") {
    root.append(buildLegend(spec.series.map((s, i) => ({ name: s.name, slot: i }))));
  }

  let last = -1;
  const draw = () => {
    const w = Math.max(180, plot.clientWidth || root.clientWidth || 320);
    if (Math.abs(w - last) < 8) return; // ignore sub-pixel/scrollbar jitter
    last = w;
    plot.replaceChildren(drawPlot(spec, w, root));
  };
  // Width is 0 until the node is in the document, so draw once on insertion.
  requestAnimationFrame(draw);
  if (typeof ResizeObserver !== "undefined") {
    const ro = new ResizeObserver(() => requestAnimationFrame(draw));
    ro.observe(plot);
  }
  return root;
}

function buildLegend(items: { name: string; slot: number }[]): HTMLElement {
  const legend = div("viz-legend");
  for (const it of items) {
    const row = div("viz-key");
    const swatch = div("viz-swatch");
    swatch.style.background = SERIES_VARS[it.slot % SERIES_VARS.length];
    // The swatch carries identity; the text stays in a text token so it is
    // legible whatever the series hue is.
    row.append(swatch, div("viz-key-label", it.name));
    legend.append(row);
  }
  return legend;
}

function buildTable(spec: ChartSpec): HTMLElement {
  const wrap = div("viz-table-wrap");
  const t = document.createElement("table");
  t.className = "viz-table";
  const thead = document.createElement("thead");
  const hr = document.createElement("tr");
  hr.append(document.createElement("th"));
  for (const s of spec.series) {
    const th = document.createElement("th");
    th.textContent = s.name;
    hr.append(th);
  }
  thead.append(hr);
  const tbody = document.createElement("tbody");
  spec.labels.forEach((label, i) => {
    const tr = document.createElement("tr");
    const th = document.createElement("th");
    th.scope = "row";
    th.textContent = label;
    tr.append(th);
    for (const s of spec.series) {
      const td = document.createElement("td");
      const v = s.data[i];
      td.textContent = v == null ? "—" : withUnit(fmtFull(v), spec.unit);
      tr.append(td);
    }
    tbody.append(tr);
  });
  t.append(thead, tbody);
  wrap.append(t);
  return wrap;
}

function drawPlot(spec: ChartSpec, width: number, root: HTMLElement): SVGSVGElement | HTMLElement {
  switch (spec.type) {
    case "stat":
      return drawStat(spec);
    case "donut":
    case "pie":
      return drawDonut(spec, width, root);
    case "hbar":
      return drawHBar(spec, width, root);
    case "line":
    case "area":
      return drawLine(spec, width, root, spec.type === "area");
    default:
      return drawBar(spec, width, root);
  }
}

/** One shared tooltip per chart, positioned over the plot. */
function tooltipFor(root: HTMLElement): HTMLElement {
  let tip = root.querySelector(":scope > .viz-tip") as HTMLElement | null;
  if (!tip) {
    tip = div("viz-tip");
    tip.hidden = true;
    root.append(tip);
  }
  return tip;
}

/**
 * Wires the hover layer for one mark. An HTML chart is interactive by default —
 * the tooltip is what lets the chart stay sparsely labelled without hiding
 * values (the table view is the non-hover path to the same numbers).
 */
function wireHover(mark: SVGElement, root: HTMLElement, label: string, value: string, slot: number) {
  const show = (e: MouseEvent) => {
    const tip = tooltipFor(root);
    tip.replaceChildren();
    const sw = div("viz-swatch");
    sw.style.background = SERIES_VARS[slot % SERIES_VARS.length];
    const head = div("viz-tip-head");
    head.append(sw, div("viz-tip-label", label));
    tip.append(head, div("viz-tip-value", value));
    tip.hidden = false;
    const box = root.getBoundingClientRect();
    // Keep the tip inside the pane: a chat box can be 320px wide and a tip
    // hanging off the right edge would be clipped by the log's overflow.
    const x = Math.min(Math.max(e.clientX - box.left, 4), box.width - tip.offsetWidth - 4);
    tip.style.left = `${Math.max(4, x)}px`;
    tip.style.top = `${Math.max(4, e.clientY - box.top - tip.offsetHeight - 10)}px`;
  };
  mark.addEventListener("mouseenter", show);
  mark.addEventListener("mousemove", show);
  mark.addEventListener("mouseleave", () => {
    const tip = root.querySelector(":scope > .viz-tip") as HTMLElement | null;
    if (tip) tip.hidden = true;
  });
}

type Frame = {
  svg: SVGSVGElement;
  x0: number;
  y0: number;
  w: number;
  h: number;
  scale: (v: number) => number;
  ticks: number[];
};

/**
 * Axis furniture shared by the column and line forms: y ticks rounded to clean
 * numbers, solid hairline gridlines one step off the surface, and no axis
 * spine beyond the baseline.
 */
function frame(spec: ChartSpec, width: number, height: number, padLeft: number): Frame {
  const svg = svgEl("svg", { width, height, viewBox: `0 0 ${width} ${height}`, class: "viz-svg" });
  const padTop = 12;
  const padBottom = 22;
  const padRight = 10;
  const all = spec.series.flatMap((s) => s.data).filter((v): v is number => v != null);
  const hi = all.length ? Math.max(...all, 0) : 1;
  const lo = all.length ? Math.min(...all, 0) : 0;
  const ticks = niceTicks(lo, hi);
  const tMin = Math.min(...ticks);
  const tMax = Math.max(...ticks);
  const h = height - padTop - padBottom;
  const w = width - padLeft - padRight;
  const scale = (v: number) => padTop + h - ((v - tMin) / (tMax - tMin || 1)) * h;

  for (const t of ticks) {
    const y = scale(t);
    svg.append(svgEl("line", { x1: padLeft, y1: y, x2: padLeft + w, y2: y, class: "viz-grid" }));
    const lbl = svgEl("text", { x: padLeft - 6, y: y + 3.5, class: "viz-axis", "text-anchor": "end" });
    lbl.textContent = fmtCompact(t);
    svg.append(lbl);
  }
  return { svg, x0: padLeft, y0: padTop, w, h, scale, ticks };
}

/** Widest y-tick decides the left gutter, so labels are never clipped. */
function gutter(spec: ChartSpec): number {
  const all = spec.series.flatMap((s) => s.data).filter((v): v is number => v != null);
  const ticks = niceTicks(all.length ? Math.min(...all, 0) : 0, all.length ? Math.max(...all, 0) : 1);
  const widest = Math.max(...ticks.map((t) => fmtCompact(t).length));
  return Math.min(56, 14 + widest * 6.5);
}

function drawBar(spec: ChartSpec, width: number, root: HTMLElement): SVGSVGElement {
  const height = 190;
  const f = frame(spec, width, height, gutter(spec));
  const n = spec.labels.length;
  const band = f.w / Math.max(1, n);
  const nSeries = spec.series.length;
  // Cap the mark and let the leftover be air, rather than filling the band.
  const slot = Math.max(2, Math.min(BAR_MAX, (band - 8) / nSeries - (nSeries > 1 ? GAP : 0)));
  const groupW = slot * nSeries + GAP * (nSeries - 1);
  const base = f.scale(0);

  spec.series.forEach((s, si) => {
    s.data.forEach((v, i) => {
      if (v == null) return;
      const x = f.x0 + band * i + (band - groupW) / 2 + si * (slot + GAP);
      const y = f.scale(v);
      const top = Math.min(y, base);
      const h = Math.abs(base - y);
      const p = svgEl("path", { d: barPath(x, top, slot, h, "up"), class: "viz-mark" });
      p.style.fill = SERIES_VARS[si % SERIES_VARS.length];
      wireHover(p, root, `${spec.labels[i]} · ${s.name}`, withUnit(fmtFull(v), spec.unit), si);
      f.svg.append(p);
    });
  });

  // Baseline: solid hairline, the one axis rule the chart draws.
  f.svg.append(svgEl("line", { x1: f.x0, y1: base, x2: f.x0 + f.w, y2: base, class: "viz-axis-line" }));

  // Category labels, thinned to whatever fits — a collided axis is worse than
  // a sparse one, and the tooltip/table carry every label regardless.
  const every = Math.ceil(n / Math.max(1, Math.floor(f.w / 52)));
  spec.labels.forEach((label, i) => {
    if (i % every) return;
    const t = svgEl("text", {
      x: f.x0 + band * i + band / 2,
      y: height - 7,
      class: "viz-axis",
      "text-anchor": "middle",
    });
    t.textContent = label.length > 10 ? label.slice(0, 9) + "…" : label;
    const title = svgEl("title");
    title.textContent = label;
    t.append(title);
    f.svg.append(t);
  });
  return f.svg;
}

function drawHBar(spec: ChartSpec, width: number, root: HTMLElement): SVGSVGElement {
  const n = spec.labels.length;
  const nSeries = spec.series.length;
  const rowH = Math.min(34, Math.max(18, 26 - n / 4));
  const height = Math.max(90, n * rowH * Math.max(1, nSeries * 0.75) + 26);
  // Long category names need real room on the left; cap so the plot survives.
  const padLeft = Math.min(140, Math.max(52, ...spec.labels.map((l) => Math.min(l.length, 18) * 6.4 + 10)));
  const padRight = 56; // room for the value at the bar tip
  const w = width - padLeft - padRight;
  const svg = svgEl("svg", { width, height, viewBox: `0 0 ${width} ${height}`, class: "viz-svg" });
  const all = spec.series.flatMap((s) => s.data).filter((v): v is number => v != null);
  const max = Math.max(1, ...all.map(Math.abs));
  const band = (height - 16) / Math.max(1, n);
  const slot = Math.max(2, Math.min(BAR_MAX, band / nSeries - GAP - 2));

  spec.series.forEach((s, si) => {
    s.data.forEach((v, i) => {
      if (v == null) return;
      const y = 8 + band * i + (band - (slot * nSeries + GAP * (nSeries - 1))) / 2 + si * (slot + GAP);
      const len = Math.max(1, (Math.abs(v) / max) * w);
      const p = svgEl("path", { d: barPath(padLeft, y, len, slot, "right"), class: "viz-mark" });
      p.style.fill = SERIES_VARS[si % SERIES_VARS.length];
      wireHover(p, root, `${spec.labels[i]} · ${s.name}`, withUnit(fmtFull(v), spec.unit), si);
      svg.append(p);
      // Bars get their value at the tip — a horizontal layout has the room a
      // column chart doesn't, so no gridlines are needed at all.
      if (slot >= 10 && nSeries <= 2) {
        const t = svgEl("text", { x: padLeft + len + 5, y: y + slot / 2 + 3.5, class: "viz-axis" });
        t.textContent = withUnit(fmtCompact(v), spec.unit);
        svg.append(t);
      }
    });
    // Row labels once per category, not once per series.
    if (si === 0) {
      spec.labels.forEach((label, i) => {
        const t = svgEl("text", {
          x: padLeft - 8,
          y: 8 + band * i + band / 2 + 3.5,
          class: "viz-axis",
          "text-anchor": "end",
        });
        t.textContent = label.length > 20 ? label.slice(0, 19) + "…" : label;
        const title = svgEl("title");
        title.textContent = label;
        t.append(title);
        svg.append(t);
      });
    }
  });
  svg.append(svgEl("line", { x1: padLeft, y1: 6, x2: padLeft, y2: height - 8, class: "viz-axis-line" }));
  return svg;
}

function drawLine(spec: ChartSpec, width: number, root: HTMLElement, area: boolean): SVGSVGElement {
  const height = 190;
  const f = frame(spec, width, height, gutter(spec));
  const n = spec.labels.length;
  // A single point has no span to divide; centre it rather than dividing by 0.
  const step = n > 1 ? f.w / (n - 1) : 0;
  const px = (i: number) => (n > 1 ? f.x0 + step * i : f.x0 + f.w / 2);

  spec.series.forEach((s, si) => {
    const colour = SERIES_VARS[si % SERIES_VARS.length];
    // Split on gaps so a null breaks the line instead of interpolating a value
    // the agent never reported.
    const runs: { i: number; v: number }[][] = [];
    let run: { i: number; v: number }[] = [];
    s.data.forEach((v, i) => {
      if (v == null) {
        if (run.length) runs.push(run);
        run = [];
      } else run.push({ i, v });
    });
    if (run.length) runs.push(run);

    for (const r of runs) {
      if (area && r.length > 1) {
        const d =
          `M${px(r[0].i)},${f.scale(0)}` +
          r.map((p) => `L${px(p.i)},${f.scale(p.v)}`).join("") +
          `L${px(r[r.length - 1].i)},${f.scale(0)}Z`;
        const fill = svgEl("path", { d, class: "viz-area" });
        fill.style.fill = colour; // opacity is in CSS — a wash, never a block
        f.svg.append(fill);
      }
      if (r.length > 1) {
        const line = svgEl("path", { d: `M` + r.map((p) => `${px(p.i)},${f.scale(p.v)}`).join("L"), class: "viz-line" });
        line.style.stroke = colour;
        f.svg.append(line);
      }
      // Markers only when the series is sparse enough that they read as points
      // rather than a beaded string; always on a lone point, which has no line.
      if (r.length <= 24) {
        for (const p of r) {
          const c = svgEl("circle", { cx: px(p.i), cy: f.scale(p.v), r: 4, class: "viz-dot" });
          c.style.fill = colour;
          wireHover(c, root, `${spec.labels[p.i]} · ${s.name}`, withUnit(fmtFull(p.v), spec.unit), si);
          f.svg.append(c);
        }
      }
    }
  });

  f.svg.append(svgEl("line", { x1: f.x0, y1: f.scale(0), x2: f.x0 + f.w, y2: f.scale(0), class: "viz-axis-line" }));

  const every = Math.ceil(n / Math.max(1, Math.floor(f.w / 56)));
  spec.labels.forEach((label, i) => {
    if (i % every && i !== n - 1) return;
    const t = svgEl("text", {
      x: px(i),
      y: height - 7,
      class: "viz-axis",
      "text-anchor": i === 0 ? "start" : i === n - 1 ? "end" : "middle",
    });
    t.textContent = label.length > 10 ? label.slice(0, 9) + "…" : label;
    const title = svgEl("title");
    title.textContent = label;
    t.append(title);
    f.svg.append(t);
  });
  return f.svg;
}

function drawDonut(spec: ChartSpec, width: number, root: HTMLElement): HTMLElement {
  // Part-to-whole reads off the FIRST series only — a donut can't show two.
  const s = spec.series[0];
  let parts = spec.labels
    .map((label, i) => ({ label, value: s.data[i] ?? 0 }))
    .filter((p) => p.value > 0)
    .sort((a, b) => b.value - a.value);
  if (parts.length > MAX_SLICES) {
    const tail = parts.slice(MAX_SLICES - 1);
    parts = parts.slice(0, MAX_SLICES - 1);
    parts.push({ label: `Other (${tail.length})`, value: tail.reduce((a, b) => a + b.value, 0) });
  }
  const total = parts.reduce((a, b) => a + b.value, 0);

  const wrap = div("viz-donut-wrap");
  const size = Math.min(180, Math.max(120, width * 0.5));
  const svg = svgEl("svg", { width: size, height: size, viewBox: `0 0 ${size} ${size}`, class: "viz-svg" });
  const cx = size / 2;
  const cy = size / 2;
  const rOuter = size / 2 - 4;
  const rInner = rOuter * 0.62;

  if (!total) {
    wrap.append(div("viz-empty", "No positive values to chart"));
    return wrap;
  }

  let angle = -Math.PI / 2; // start at 12 o'clock
  parts.forEach((p, i) => {
    const sweep = (p.value / total) * Math.PI * 2;
    // A 2px surface gap does the separating between segments — never a stroke.
    const gapAngle = parts.length > 1 ? GAP / rOuter : 0;
    const a0 = angle + gapAngle / 2;
    const a1 = angle + sweep - gapAngle / 2;
    angle += sweep;
    if (a1 <= a0) return;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const d =
      `M${cx + rOuter * Math.cos(a0)},${cy + rOuter * Math.sin(a0)}` +
      `A${rOuter},${rOuter} 0 ${large} 1 ${cx + rOuter * Math.cos(a1)},${cy + rOuter * Math.sin(a1)}` +
      `L${cx + rInner * Math.cos(a1)},${cy + rInner * Math.sin(a1)}` +
      `A${rInner},${rInner} 0 ${large} 0 ${cx + rInner * Math.cos(a0)},${cy + rInner * Math.sin(a0)}Z`;
    const seg = svgEl("path", { d, class: "viz-mark" });
    seg.style.fill = SERIES_VARS[i % SERIES_VARS.length];
    wireHover(
      seg,
      root,
      p.label,
      `${withUnit(fmtFull(p.value), spec.unit)} · ${((p.value / total) * 100).toFixed(1)}%`,
      i
    );
    svg.append(seg);
  });

  // The hole is the natural place for the total — no extra chrome needed.
  const totalText = svgEl("text", { x: cx, y: cy - 1, class: "viz-donut-total", "text-anchor": "middle" });
  totalText.textContent = withUnit(fmtCompact(total), spec.unit);
  const totalLabel = svgEl("text", { x: cx, y: cy + 13, class: "viz-axis", "text-anchor": "middle" });
  totalLabel.textContent = "total";
  svg.append(totalText, totalLabel);

  wrap.append(svg, buildLegend(parts.map((p, i) => ({ name: `${p.label} · ${fmtCompact(p.value)}`, slot: i }))));
  return wrap;
}

/**
 * The form for when the data is ONE number. A single bar is not a chart; a
 * stat tile is. Optional delta is coloured by direction × whether up is good —
 * and always carries its sign, so it never depends on colour alone.
 */
function drawStat(spec: ChartSpec): HTMLElement {
  const wrap = div("viz-stat");
  const s = spec.series[0];
  const vals = s.data.filter((v): v is number => v != null);
  const value = vals.length ? vals[vals.length - 1] : 0;
  wrap.append(div("viz-stat-label", spec.title || s.name));
  wrap.append(div("viz-stat-value", withUnit(fmtCompact(value), spec.unit)));
  if (spec.delta != null && spec.delta !== 0) {
    const up = spec.delta > 0;
    const good = up === (spec.goodDirection !== "down");
    const d = div("viz-stat-delta " + (good ? "good" : "bad"));
    d.textContent = `${up ? "▲" : "▼"} ${withUnit(fmtCompact(Math.abs(spec.delta)), spec.unit)}`;
    wrap.append(d);
  }
  // A trailing sparkline when there's a history behind the number.
  if (vals.length > 2) {
    const w = 120;
    const h = 26;
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const span = max - min || 1;
    // Inset by the dot's radius on both axes — a marker centred on the edge
    // loses half of itself to the viewport.
    const px = (i: number) => 4 + (i / (vals.length - 1)) * (w - 8);
    const py = (v: number) => h - 4 - ((v - min) / span) * (h - 8);
    const pts = vals.map((v, i) => `${px(i)},${py(v)}`);
    const svg = svgEl("svg", { width: w, height: h, viewBox: `0 0 ${w} ${h}`, class: "viz-spark" });
    const line = svgEl("path", { d: "M" + pts.join("L"), class: "viz-line" });
    line.style.stroke = SERIES_VARS[0];
    const dot = svgEl("circle", { cx: px(vals.length - 1), cy: py(value), r: 3, class: "viz-dot" });
    dot.style.fill = SERIES_VARS[0];
    svg.append(line, dot);
    wrap.append(svg);
  }
  return wrap;
}

// ---- Table → chart ---------------------------------------------------------

/**
 * Turns a rendered Markdown table into a chart spec, or returns null when the
 * table isn't chartable. Used by the "Chart" toggle agent-chat.ts puts on every
 * numeric table — the path that needs no cooperation from the agent at all.
 *
 * Rules: the first column is the category axis, every OTHER column that parses
 * as numeric end-to-end becomes a series (a mixed column is skipped, not
 * zero-filled), and at least two rows are needed for a chart to say anything.
 */
export function specFromTable(table: HTMLTableElement): ChartSpec | null {
  const rows = Array.from(table.rows);
  if (rows.length < 3) return null; // header + 2 data rows minimum
  const header = Array.from(rows[0].cells).map((c) => c.textContent?.trim() || "");
  if (header.length < 2) return null;
  const body = rows.slice(1);

  const labels = body.map((r) => r.cells[0]?.textContent?.trim() || "");
  const series: ChartSeries[] = [];
  for (let col = 1; col < header.length; col++) {
    const raw = body.map((r) => r.cells[col]?.textContent?.trim() ?? "");
    const parsed = raw.map(num);
    // Require every non-empty cell to be numeric: a column of "yes/no/12" is
    // not a measure, and plotting it would invent data.
    const nonEmpty = raw.filter((t) => t !== "" && t !== "—" && t !== "-").length;
    const good = parsed.filter((v) => v != null).length;
    if (!nonEmpty || good < nonEmpty) continue;
    series.push({ name: header[col] || `Column ${col + 1}`, data: parsed });
  }
  if (!series.length) return null;

  // Form follows the data's job: an ordered/temporal first column is a
  // change-over-time story (line); anything else is magnitude comparison
  // (columns, or horizontal bars once the names get long or numerous).
  const temporal = labels.every((l) => isTemporal(l));
  const longNames = labels.some((l) => l.length > 12) || labels.length > 12;
  const type: ChartSpec["type"] = temporal ? "line" : longNames ? "hbar" : "bar";

  return {
    type,
    labels,
    series: foldTail(series),
    title: undefined,
    goodDirection: "up",
  };
}

/** Does this axis label read as a point in time / an ordered step? */
function isTemporal(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  if (/^\d{4}(-\d{2}(-\d{2})?)?$/.test(t)) return true; // 2026, 2026-08, 2026-08-31
  if (/^\d{1,2}\/\d{1,2}(\/\d{2,4})?$/.test(t)) return true; // 8/31, 8/31/26
  if (/^(mon|tue|wed|thu|fri|sat|sun)/i.test(t)) return true;
  if (/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(t)) return true;
  if (/^(q[1-4]|w\d{1,2}|week \d+|day \d+)$/i.test(t)) return true;
  if (/^\d{1,2}:\d{2}/.test(t)) return true; // 14:05
  return false;
}

/** Parse a ```chart fenced block's body. Returns null on anything unusable. */
export function parseChartBlock(src: string): ChartSpec | null {
  try {
    return normalizeSpec(JSON.parse(src));
  } catch {
    return null;
  }
}
