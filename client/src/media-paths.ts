/**
 * Show the media an agent MENTIONS, not just the media it links.
 *
 * markdown.ts embeds a bare absolute path or a Markdown image/link. But agents
 * mostly name what they made the way a person would in a terminal: a path in
 * backticks, relative to the project ("`assets/video/promo.mp4`"), or a file
 * with spaces in its name ("`~/Downloads/Kevin - maestro 1.mp4`"). None of
 * those used to show. This pass runs after a reply renders and, for each such
 * mention, adds the player/image right under the line that mentions it:
 *
 *  - inline code whose whole text is a media path (spaces allowed), and
 *  - bare relative paths in prose ("saved to out/clip.mp4"),
 *  resolved against the SESSION'S folder (relative), $HOME (~, by the server),
 *  or as-is (absolute). Served by /api/file, which only ever serves allowlisted
 *  media types. Each file embeds once per message; at most MAX per message.
 *
 * DOM-only (createElement): nothing here builds HTML from text.
 */
import { mediaSrc } from "./markdown";

const MEDIA = /\.(mp4|m4v|webm|ogv|mov|png|jpe?g|gif|webp|avif|heic|heif|mp3|m4a|wav|ogg|flac)$/i;
const BARE_REL = /(?:^|[\s(])((?:\.{1,2}\/)?[\w@+-][\w@.+-]*(?:\/[\w@.+-]+)+\.(?:mp4|m4v|webm|ogv|mov|png|jpe?g|gif|webp|avif|mp3|m4a|wav))(?=[\s).,;:!?]|$)/gi;
const MAX = 6;

function absolute(path: string, cwd: string): string | null {
  const p = path.trim().replace(/^file:\/\//, "");
  if (!MEDIA.test(p)) return null;
  if (p.startsWith("/") || p.startsWith("~/")) return p;
  if (!cwd || /^[a-z]+:/i.test(p)) return null; // a URL scheme, not a path
  const parts = `${cwd.replace(/\/+$/, "")}/${p}`.split("/");
  const out: string[] = [];
  for (const seg of parts) {
    if (seg === "." || seg === "") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return "/" + out.join("/");
}

function element(path: string): HTMLElement | null {
  const m = mediaSrc(path);
  if (!m) return null;
  const wrap = document.createElement("div");
  wrap.className = "md-mention";
  if (m.kind === "video") {
    const v = document.createElement("video");
    v.className = "md-video";
    v.src = m.src;
    v.controls = true;
    v.playsInline = true;
    v.preload = "metadata";
    wrap.append(v);
  } else if (m.kind === "audio") {
    const a = document.createElement("audio");
    a.className = "md-audio";
    a.src = m.src;
    a.controls = true;
    a.preload = "metadata";
    wrap.append(a);
  } else {
    const link = document.createElement("a");
    link.className = "md-media-link";
    link.href = m.src;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    const img = document.createElement("img");
    img.className = "md-img";
    img.src = m.src;
    img.alt = path.split("/").pop() || "";
    img.loading = "lazy";
    img.decoding = "async";
    link.append(img);
    wrap.append(link);
  }
  return wrap;
}

/** Add players/images under every media path `root` mentions (see top). */
export function embedMediaPaths(root: HTMLElement, cwd: string): void {
  // Already embedded by markdown.ts — don't show the same file twice.
  const seen = new Set<string>();
  root.querySelectorAll("img, video, audio").forEach((el) => {
    const src = el.getAttribute("src") || "";
    const q = /[?&]path=([^&]+)/.exec(src);
    if (q) seen.add(decodeURIComponent(q[1]));
  });
  const found: { path: string; at: Element }[] = [];
  const add = (raw: string, at: Element) => {
    const abs = absolute(raw, cwd);
    if (!abs || seen.has(abs) || found.length >= MAX) return;
    seen.add(abs);
    found.push({ path: abs, at });
  };
  // 1. `inline code` that is exactly a path (spaces allowed — it's delimited).
  root.querySelectorAll("code").forEach((c) => {
    if (c.closest("pre")) return; // code BLOCKS are commands/scripts, not mentions
    add(c.textContent || "", c);
  });
  // 2. Bare RELATIVE paths in prose (absolute ones markdown.ts already embeds).
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const parent = n.parentElement;
    if (!parent || parent.closest("code, pre, a, .md-mention")) continue;
    for (const m of (n.textContent || "").matchAll(BARE_REL)) add(m[1], parent);
  }
  for (const { path, at } of found) {
    const node = element(path);
    if (!node) continue;
    // Under the line that mentions it: after its paragraph / list item.
    const block = at.closest("p, li, td, blockquote") || at;
    block.after(node);
  }
}
