/**
 * A deliberately small, self-contained Markdown → HTML renderer for assistant
 * chat bubbles. NOT a full CommonMark implementation — it covers the subset
 * agents actually emit (fenced/inline code, bold, italic, strikethrough,
 * links, headings, lists, blockquotes, rules) and renders everything else as
 * plain text.
 *
 * SECURITY: assistant text is untrusted model output. The one and only rule
 * that keeps this safe is that raw source NEVER reaches innerHTML — every leaf
 * of text is passed through `esc()` before any markup is added, and the only
 * tags this file emits are the fixed safe set below. There is no code path
 * that copies source characters into the output without escaping them first,
 * so a `<script>` or `<img onerror=…>` in the model's output comes out as
 * inert text. Link hrefs are additionally scheme-checked (http/https/mailto).
 *
 * We hand-roll this instead of pulling in marked + DOMPurify: the project is
 * dependency-light and its CSP forbids external anything, a ~150-line renderer
 * we can read in full is a smaller trust surface than two vendored libs, and
 * it's covered by its own test (see the throwaway script referenced in the PR).
 */

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const SAFE_SCHEME = /^(https?:|mailto:)/i;

/** Inline formatting for one run of text. `raw` is UNescaped source. */
function inline(raw: string): string {
  // 1. Pull out inline-code spans first and park them behind markers so their
  //    contents get escaped but no further formatting (a `*` inside code is
  //    literal). Markers use \x00, which can't appear in the source stream.
  const codes: string[] = [];
  let s = raw.replace(/`([^`]+)`/g, (_m, code) => {
    codes.push(`<code>${esc(code)}</code>`);
    return `\x00${codes.length - 1}\x00`;
  });

  // 2. Escape everything else, then layer on the inline tags. Every branch
  //    below only ever wraps already-escaped text in a fixed tag.
  s = esc(s);

  // Links: [text](url) — text is escaped-and-inlined; url is scheme-checked
  // and quote-stripped so it can't break out of the attribute.
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text, url) => {
    const clean = url.replace(/&quot;/g, "");
    if (!SAFE_SCHEME.test(clean)) return m; // leave odd schemes as literal text
    return `<a href="${clean}" target="_blank" rel="noopener noreferrer">${text}</a>`;
  });

  s = s
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>")
    // Italic: single * or _ not adjacent to its bold form. `_` only between
    // word boundaries so snake_case identifiers survive intact.
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>")
    .replace(/(^|[^\w_])_([^_\n]+)_(?![\w_])/g, "$1<em>$2</em>");

  // 3. Restore the parked code spans.
  return s.replace(/\x00(\d+)\x00/g, (_m, i) => codes[+i]);
}

/** Render trusted-subset Markdown to a safe HTML string. */
export function renderMarkdown(src: string): string {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;

  // Open list/paragraph accumulators so consecutive lines merge correctly.
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${para.map(inline).join("<br>")}</p>`);
      para = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block — content is escaped verbatim, no inline formatting.
    const fence = line.match(/^\s*```(\w*)\s*$/);
    if (fence) {
      flushPara();
      const lang = fence[1];
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++; // consume closing fence (or run off the end on an unclosed block)
      const cls = lang ? ` class="md-code" data-lang="${esc(lang)}"` : ' class="md-code"';
      out.push(`<pre${cls}><code>${esc(body.join("\n"))}</code></pre>`);
      continue;
    }

    // Horizontal rule.
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      flushPara();
      out.push("<hr>");
      i++;
      continue;
    }

    // Heading.
    const h = line.match(/^\s*(#{1,6})\s+(.*)$/);
    if (h) {
      flushPara();
      const n = h[1].length;
      out.push(`<div class="md-h md-h${n}">${inline(h[2])}</div>`);
      i++;
      continue;
    }

    // Blockquote — one or more consecutive `>` lines.
    if (/^\s*>\s?/.test(line)) {
      flushPara();
      const quote: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quote.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      out.push(`<blockquote>${quote.map(inline).join("<br>")}</blockquote>`);
      continue;
    }

    // Lists — a run of ordered or unordered items. Nesting is not supported;
    // deeper indentation just renders as part of the item text.
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      flushPara();
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, ""));
        i++;
      }
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}>${items.map((it) => `<li>${inline(it)}</li>`).join("")}</${tag}>`);
      continue;
    }

    // Blank line ends a paragraph; otherwise accumulate.
    if (/^\s*$/.test(line)) flushPara();
    else para.push(line);
    i++;
  }
  flushPara();
  return out.join("");
}
