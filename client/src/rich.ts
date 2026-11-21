/**
 * The pass that turns rendered Markdown into a rich, skimmable message.
 *
 * `renderMarkdown` produces a safe HTML string and nothing else — it can't
 * build a chart, wire a copy button, or measure whether a message is too tall,
 * because none of those are string operations. This module runs over the
 * resulting DOM once the bubble is in the document and adds the interactive
 * layer:
 *
 *   - a ```chart block becomes a real SVG chart (falling back to a plain code
 *     block if the spec doesn't parse, so nothing silently disappears)
 *   - any numeric Markdown table gets a Chart toggle — the path that needs no
 *     cooperation from the agent at all
 *   - code blocks get a language label and a copy button
 *   - media clicks stop short of the pane's own click handler
 *
 * It is deliberately idempotent: every step marks what it has touched, so
 * re-running on the same bubble (which happens whenever a streamed message is
 * finalised) is a no-op rather than a duplicate.
 */

import { parseChartBlock, renderChart, specFromTable, normalizeSpec, ChartSpec } from "./charts";

function div(cls: string, text?: string): HTMLElement {
  const n = document.createElement("div");
  n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

/** A button that never reaches the pane-level click handler (which zooms the box). */
function button(cls: string, label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = cls;
  b.type = "button";
  b.textContent = label;
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();
    onClick();
  });
  return b;
}

export function enhanceRich(bubble: HTMLElement): void {
  enhanceCharts(bubble);
  enhanceTables(bubble);
  enhanceCode(bubble);
  enhanceMedia(bubble);
}

/** ```chart blocks → SVG. An unparseable spec degrades to a visible code block. */
function enhanceCharts(root: HTMLElement) {
  for (const pre of Array.from(root.querySelectorAll("pre.md-chart-src"))) {
    const src = pre.textContent || "";
    const spec = parseChartBlock(src);
    if (!spec) {
      // Show the spec rather than an error: the user can see what the agent
      // meant, and a malformed chart shouldn't cost them the content.
      pre.classList.remove("md-chart-src");
      pre.classList.add("md-code");
      continue;
    }
    pre.replaceWith(renderChart(spec));
  }
}

/**
 * Give every chartable Markdown table a Chart toggle.
 *
 * The chart is built lazily on first click — a transcript can hold dozens of
 * tables, and laying out SVG for charts nobody opens would cost real time on
 * replay. The table stays in the DOM underneath either way, so the numbers are
 * never gated behind a rendering.
 */
function enhanceTables(root: HTMLElement) {
  for (const wrap of Array.from(root.querySelectorAll(".md-table-wrap"))) {
    if (wrap.parentElement?.classList.contains("md-figure")) continue; // already done
    const table = wrap.querySelector("table") as HTMLTableElement | null;
    if (!table) continue;
    const spec = specFromTable(table);
    if (!spec) continue; // nothing numeric to plot — leave it a plain table

    const fig = div("md-figure");
    wrap.replaceWith(fig);
    const bar = div("md-figure-bar");
    const chartSlot = div("md-figure-chart");
    chartSlot.hidden = true;

    let built = false;
    const toggle = button("md-chartbtn", "Chart", () => {
      const showChart = chartSlot.hidden;
      if (showChart && !built) {
        built = true;
        // The figure bar's own button is the chart/table switch here.
        chartSlot.append(renderChart(spec, { toggle: false }));
      }
      chartSlot.hidden = !showChart;
      (wrap as HTMLElement).hidden = showChart;
      toggle.textContent = showChart ? "Table" : "Chart";
    });
    toggle.title = "Plot this table";
    bar.append(toggle);
    fig.append(bar, wrap, chartSlot);
  }
}

/** Language label + copy button on every fenced code block. */
function enhanceCode(root: HTMLElement) {
  for (const pre of Array.from(root.querySelectorAll("pre.md-code"))) {
    if (pre.parentElement?.classList.contains("md-codeblock")) continue;
    const lang = pre.getAttribute("data-lang") || "";
    const box = div("md-codeblock");
    pre.replaceWith(box);
    const bar = div("md-code-bar");
    bar.append(div("md-code-lang", lang || "text"));
    const copy = button("md-copy", "Copy", () => {
      const text = pre.textContent || "";
      void navigator.clipboard?.writeText(text).then(
        () => flash(copy, "Copied"),
        () => flash(copy, "Failed")
      );
    });
    bar.append(copy);
    box.append(bar, pre);
  }
}

function flash(btn: HTMLButtonElement, label: string) {
  const prev = btn.textContent;
  btn.textContent = label;
  setTimeout(() => (btn.textContent = prev), 1200);
}

/**
 * Media sits inside a pane whose own click handler zooms the box, so a click on
 * a video's play button (or an image link) has to stop there.
 */
function enhanceMedia(root: HTMLElement) {
  for (const node of Array.from(root.querySelectorAll(".md-media-link, .md-video, .md-audio"))) {
    if ((node as HTMLElement).dataset.wired) continue;
    (node as HTMLElement).dataset.wired = "1";
    node.addEventListener("click", (e) => e.stopPropagation());
    node.addEventListener("pointerdown", (e) => e.stopPropagation());
  }
  for (const img of Array.from(root.querySelectorAll("img.md-img"))) {
    if ((img as HTMLElement).dataset.wired) continue;
    (img as HTMLElement).dataset.wired = "1";
    // A path that no longer exists (the agent deleted its temp file) shouldn't
    // leave a broken-image glyph — show the path as text instead.
    img.addEventListener(
      "error",
      () => {
        const a = img.closest("a");
        const miss = div("md-media-missing", (img as HTMLImageElement).alt || "media unavailable");
        (a || img).replaceWith(miss);
      },
      { once: true }
    );
  }
}

/** Re-export so agent-chat.ts has one import for the rich layer. */
export { normalizeSpec };
export type { ChartSpec };
