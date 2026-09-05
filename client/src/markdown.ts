/**
 * A deliberately small, self-contained Markdown → HTML renderer for assistant
 * chat bubbles. NOT a full CommonMark implementation — it covers the subset
 * agents actually emit (fenced/inline code, bold, italic, strikethrough,
 * links, headings, lists, blockquotes, rules, GFM tables, task lists, and
 * embedded media) and renders everything else as plain text.
 *
 * SECURITY: assistant text is untrusted model output. The one and only rule
 * that keeps this safe is that raw source NEVER reaches innerHTML — every leaf
 * of text is passed through `esc()` before any markup is added, and the only
 * tags this file emits are the fixed safe set below. There is no code path
 * that copies source characters into the output without escaping them first,
 * so a `<script>` or `<img onerror=…>` in the model's output comes out as
 * inert text. URLs are additionally scheme-checked: links accept only
 * http/https/mailto, and media `src` attributes are built by `mediaSrc()`,
 * which either passes through an http(s)/data:image URL or rewrites a local
 * filesystem path into `/api/file?path=…` with the path percent-encoded — so
 * no attribute value is ever raw source either.
 *
 * We hand-roll this instead of pulling in marked + DOMPurify: the project is
 * dependency-light and ships no external assets, a renderer we can read in full
 * is a smaller trust surface than two vendored libs, and it's covered by its
 * own throwaway test (see the PR).
 */

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const SAFE_SCHEME = /^(https?:|mailto:)/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)(\?[^\s]*)?$/i;
const VIDEO_EXT = /\.(mp4|m4v|webm|ogv|mov)(\?[^\s]*)?$/i;
const AUDIO_EXT = /\.(mp3|m4a|wav|oga|ogg|flac)(\?[^\s]*)?$/i;

/**
 * Resolve a Markdown URL to something the browser can actually load, and say
 * what kind of element should load it.
 *
 * The interesting case is a LOCAL path. Agents overwhelmingly report artefacts
 * as filesystem paths ("wrote the plot to /tmp/latency.png"), not as URLs —
 * those bytes are on this machine's disk, outside `dist/`, so they get routed
 * through the server's `/api/file` media endpoint. A `~` prefix can't be
 * expanded here (the browser doesn't know $HOME), so it's handed over as-is
 * and the server resolves it. Relative paths are deliberately NOT resolved:
 * without the pane's cwd, "./shot.png" would be a guess, and a broken image is
 * worse than a plain link.
 */
export function mediaSrc(url: string): { src: string; kind: "image" | "video" | "audio" } | null {
  const u = url.trim();
  if (!u) return null;
  const kind = IMAGE_EXT.test(u) ? "image" : VIDEO_EXT.test(u) ? "video" : AUDIO_EXT.test(u) ? "audio" : null;
  // A data: URL carries its own type, so it doesn't need an extension to be
  // recognised — but only image/ is allowed through (data:text/html would be a
  // script-execution vector if it ever reached anything but an <img>).
  if (/^data:image\//i.test(u)) return { src: u, kind: "image" };
  if (!kind) return null;
  if (/^https?:\/\//i.test(u)) return { src: u, kind };
  if (/^file:\/\//i.test(u)) return { src: `/api/file?path=${encodeURIComponent(decodeURI(u.slice(7)))}`, kind };
  if (u.startsWith("/") && !u.startsWith("//")) return { src: `/api/file?path=${encodeURIComponent(u)}`, kind };
  if (u.startsWith("~/")) return { src: `/api/file?path=${encodeURIComponent(u)}`, kind };
  return null;
}

/** Build the embed HTML for a resolved media URL. Caller supplies RAW alt text. */
function mediaTag(m: { src: string; kind: "image" | "video" | "audio" }, alt: string): string {
  // `src` is either a scheme-checked URL or a percent-encoded /api/file path;
  // esc() then makes it attribute-safe. `alt` is raw source, so it's escaped.
  const src = esc(m.src);
  const a = esc(alt);
  if (m.kind === "image") {
    // Wrapped in a link so a chart or screenshot squeezed into a phone-width
    // pane can still be opened at full size. `loading=lazy` keeps a long
    // transcript from fetching every image at once on replay.
    return (
      `<a class="md-media-link" href="${src}" target="_blank" rel="noopener noreferrer">` +
      `<img class="md-img" src="${src}" alt="${a}" loading="lazy" decoding="async">` +
      `</a>`
    );
  }
  if (m.kind === "video") {
    // `preload=metadata` fetches the header (so the poster frame and duration
    // resolve) without pulling the whole file into a chat log.
    return `<video class="md-video" src="${src}" controls playsinline preload="metadata"></video>`;
  }
  return `<audio class="md-audio" src="${src}" controls preload="metadata"></audio>`;
}

/** Inline emphasis, applied to text that has ALREADY been escaped. */
function emphasis(s: string): string {
  return (
    s
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/__([^_]+)__/g, "<strong>$1</strong>")
      .replace(/~~([^~]+)~~/g, "<del>$1</del>")
      // Italic: single * or _ not adjacent to its bold form. `_` only between
      // word boundaries so snake_case identifiers survive intact.
      .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>")
      .replace(/(^|[^\w_])_([^_\n]+)_(?![\w_])/g, "$1<em>$2</em>")
  );
}

/**
 * Inline formatting for one run of text. `raw` is UNescaped source.
 *
 * Order matters and is load-bearing: anything that consumes a URL is parked as
 * finished HTML BEFORE the bulk escape, so a URL is never double-escaped, and
 * the autolink pass that runs afterwards can't reach inside an href it already
 * produced.
 */
function inline(raw: string): string {
  const parked: string[] = [];
  // Markers use \x00, which can't appear in the source stream and which esc()
  // leaves untouched, so a park survives the escape pass intact.
  const park = (html: string) => `\x00${parked.push(html) - 1}\x00`;

  // 1. Inline-code spans: contents get escaped but no further formatting (a
  //    `*` inside code is literal).
  let s = raw.replace(/`([^`]+)`/g, (_m, code) => park(`<code>${esc(code)}</code>`));

  // 2. Images: ![alt](url). Non-media or unresolvable URLs fall through to the
  //    link/text passes rather than emitting a broken <img>.
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt: string, url: string) => {
    const media = mediaSrc(url);
    return media ? park(mediaTag(media, alt)) : m;
  });

  // 3. Links: [text](url). A link POINTING AT media becomes the media itself —
  //    an agent writing [the chart](/tmp/p.png) means "here is the chart", and
  //    rendering it beats a link the user has to leave the pane to follow.
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text: string, url: string) => {
    const media = mediaSrc(url);
    if (media) return park(mediaTag(media, text));
    if (!SAFE_SCHEME.test(url)) return m; // leave odd schemes as literal text
    return park(`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${emphasis(esc(text))}</a>`);
  });

  // 4. Bare media paths and URLs. An agent that says "saved to /tmp/plot.png"
  //    in prose gets the picture shown, which is the whole point of this view.
  s = s.replace(/(^|\s)((?:https?:\/\/|\/|~\/)[^\s<>()[\]{}"']+)/g, (m, pre: string, url: string) => {
    // Trailing sentence punctuation belongs to the prose, not the path.
    const trail = /[.,;:!?]+$/.exec(url)?.[0] || "";
    const clean = trail ? url.slice(0, -trail.length) : url;
    const media = mediaSrc(clean);
    if (media) return pre + park(mediaTag(media, clean)) + trail;
    if (/^https?:\/\//i.test(clean)) {
      return pre + park(`<a href="${esc(clean)}" target="_blank" rel="noopener noreferrer">${esc(clean)}</a>`) + trail;
    }
    return m; // a plain filesystem path stays plain text
  });

  // 5. Escape everything that's left, then layer on emphasis. Every branch
  //    below only ever wraps already-escaped text in a fixed tag.
  s = emphasis(esc(s));

  // 6. Restore the parked HTML.
  return s.replace(/\x00(\d+)\x00/g, (_m, i) => parked[+i]);
}

/**
 * Split one table row into cells on unescaped pipes, ignoring pipes inside
 * inline-code spans — `| a | \`b|c\` |` is two cells, not three.
 */
function splitRow(line: string): string[] {
  let s = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let cur = "";
  let inCode = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
      continue;
    }
    if (ch === "`") inCode = !inCode;
    if (ch === "|" && !inCode) {
      cells.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

/** `|---|:--:|---:|` — the row that makes the line above it a table header. */
const DELIM_ROW = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/;
function isDelimRow(line: string): boolean {
  return line.includes("-") && line.includes("|") && DELIM_ROW.test(line);
}

function alignOf(cell: string): string {
  const c = cell.trim();
  const left = c.startsWith(":");
  const right = c.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return "";
}

const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

/**
 * Render one run of list lines, nested by indentation.
 *
 * Nesting is by leading-whitespace width against a stack of open levels: a
 * deeper indent opens a child list, a shallower one closes back to the nearest
 * matching level. Continuation lines (an unmarked, indented line under an
 * item) are folded into that item's text so a wrapped bullet doesn't break the
 * list in half.
 */
function renderList(lines: string[], start: number): { html: string; next: number } {
  type Level = { indent: number; ordered: boolean; items: string[][] };
  const stack: Level[] = [];
  let i = start;

  const close = (): string => {
    const lvl = stack.pop()!;
    const tag = lvl.ordered ? "ol" : "ul";
    const body = lvl.items.map((parts) => `<li>${parts.join("")}</li>`).join("");
    return `<${tag}>${body}</${tag}>`;
  };

  while (i < lines.length) {
    const m = LIST_ITEM.exec(lines[i]);
    if (!m) {
      // An indented, unmarked, non-blank line continues the current item.
      if (stack.length && /^\s+\S/.test(lines[i]) && lines[i].trim()) {
        const top = stack[stack.length - 1];
        top.items[top.items.length - 1].push("<br>" + inline(lines[i].trim()));
        i++;
        continue;
      }
      break;
    }
    const indent = m[1].replace(/\t/g, "    ").length;
    const ordered = /\d/.test(m[2]);
    let text = m[3];

    while (stack.length && indent < stack[stack.length - 1].indent) {
      const child = close();
      if (stack.length) {
        const parent = stack[stack.length - 1];
        parent.items[parent.items.length - 1].push(child);
      } else {
        // Can't happen (the loop guard keeps one level), but never drop HTML.
        return { html: child, next: i };
      }
    }
    if (!stack.length || indent > stack[stack.length - 1].indent) {
      stack.push({ indent, ordered, items: [] });
    } else if (stack[stack.length - 1].ordered !== ordered) {
      // Switching marker style at the same depth starts a new list, so an
      // ordered run under a bulleted one still numbers from 1.
      const finished = close();
      if (stack.length) {
        const parent = stack[stack.length - 1];
        parent.items[parent.items.length - 1].push(finished);
        stack.push({ indent, ordered, items: [] });
      } else {
        stack.push({ indent, ordered, items: [] });
        stack[0].items.push([finished]);
      }
    }

    // Task list: `- [ ] todo` / `- [x] done`. The box is always disabled —
    // it reports the agent's state, it isn't a control the user drives.
    const task = /^\[([ xX])\]\s+(.*)$/.exec(text);
    let html: string;
    if (task) {
      const checked = task[1].toLowerCase() === "x";
      html =
        `<span class="md-task${checked ? " done" : ""}">` +
        `<input type="checkbox" disabled${checked ? " checked" : ""}>` +
        `<span>${inline(task[2])}</span></span>`;
    } else {
      html = inline(text);
    }
    stack[stack.length - 1].items.push([html]);
    i++;
  }

  let html = "";
  while (stack.length) {
    const child = close();
    if (stack.length) {
      const parent = stack[stack.length - 1];
      parent.items[parent.items.length - 1].push(child);
    } else {
      html = child;
    }
  }
  return { html, next: i };
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
      const code = esc(body.join("\n"));
      // ```chart is a real chart, not source to read. It's emitted as a normal
      // <pre> carrying the spec as text; agent-chat.ts's enhance pass parses it
      // and swaps in the SVG. Keeping the spec in the DOM (rather than, say, an
      // attribute) means an unparseable spec degrades to a visible code block
      // instead of vanishing — see enhanceChart().
      const cls = lang.toLowerCase() === "chart" ? "md-chart-src" : "md-code";
      const langAttr = lang ? ` data-lang="${esc(lang)}"` : "";
      out.push(`<pre class="${cls}"${langAttr}><code>${code}</code></pre>`);
      continue;
    }

    // Horizontal rule.
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      flushPara();
      out.push("<hr>");
      i++;
      continue;
    }

    // GFM table — a header row followed by a |---|:-:| delimiter row. Checked
    // before lists, because `|---|` also matches nothing else and a table's
    // rows would otherwise be swallowed as paragraph text.
    if (line.includes("|") && i + 1 < lines.length && isDelimRow(lines[i + 1])) {
      const header = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map(alignOf);
      if (header.length > 1) {
        flushPara();
        i += 2;
        const cell = (text: string, tag: string, idx: number) => {
          const a = aligns[idx];
          return `<${tag}${a ? ` style="text-align:${a}"` : ""}>${inline(text)}</${tag}>`;
        };
        const head = `<thead><tr>${header.map((h, n) => cell(h, "th", n)).join("")}</tr></thead>`;
        const rows: string[] = [];
        while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
          const cells = splitRow(lines[i]);
          // Pad/trim to the header's width so a ragged row can't shift columns.
          while (cells.length < header.length) cells.push("");
          rows.push(`<tr>${cells.slice(0, header.length).map((c, n) => cell(c, "td", n)).join("")}</tr>`);
          i++;
        }
        // The wrapper is what scrolls: a wide table must not stretch the chat
        // log and force the whole conversation sideways.
        out.push(
          `<div class="md-table-wrap"><table class="md-table">${head}<tbody>${rows.join("")}</tbody></table></div>`
        );
        continue;
      }
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

    // Lists — a run of ordered or unordered items, nested by indentation.
    if (LIST_ITEM.test(line)) {
      flushPara();
      const { html, next } = renderList(lines, i);
      out.push(html);
      i = next;
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
