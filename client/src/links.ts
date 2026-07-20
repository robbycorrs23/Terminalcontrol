import type { Terminal, ILinkProvider, ILink } from "@xterm/xterm";

/** Called when the user clicks a file link; `open` POSTs to the server. */
type OpenFile = (path: string, line?: number) => void;

/**
 * Turn a whitespace-delimited token into a file link, or null if it isn't one.
 * A token qualifies only if it contains a "/" or ends in a file extension —
 * this keeps ordinary words from being underlined. A trailing ":line[:col]"
 * (Claude's usual "path:42" form) is parsed off; trailing sentence punctuation
 * is trimmed. `text` is the exact substring that became the link (a prefix of
 * `raw`), so the caller can place the link's cell range.
 */
export function parseFileLink(
  raw: string
): { file: string; line?: number; text: string } | null {
  // Drop trailing sentence punctuation ("foo.js).", "foo.js:9.") but keep a real :line.
  const cleaned = raw.replace(/[).,;'"\]}>]+$/, "");
  let file: string;
  let line: number | undefined;
  let text: string;
  const suffix = cleaned.match(/:(\d+)(?::\d+)?$/); // optional :line[:col] at the end
  if (suffix) {
    file = cleaned.slice(0, suffix.index);
    line = Number(suffix[1]);
    text = cleaned; // the link covers path + :line[:col]
  } else {
    file = cleaned.replace(/:+$/, ""); // drop a stray trailing colon ("see foo.js:")
    text = file;
  }
  if (!file) return null;
  if (/^[a-z][\w+.-]*:\/\//i.test(file)) return null; // URL scheme → web-links owns it
  const hasSlash = file.includes("/");
  const hasExt = /[\w-]\.[A-Za-z0-9]{1,8}$/.test(file); // a name char before the dot
  if (!hasSlash && !hasExt) return null;
  return { file, line, text };
}

class FileLinkProvider implements ILinkProvider {
  constructor(private term: Terminal, private open: OpenFile) {}

  provideLinks(y: number, cb: (links: ILink[] | undefined) => void): void {
    const bufLine = this.term.buffer.active.getLine(y - 1);
    if (!bufLine) return cb(undefined);
    // Keep trailing spaces so string indices line up with terminal columns.
    const text = bufLine.translateToString(false);
    const links: ILink[] = [];
    const tokenRe = /\S+/g;
    let m: RegExpExecArray | null;
    while ((m = tokenRe.exec(text))) {
      // Skip a leading opener like "(" or quote so the link range is tight.
      const lead = m[0].match(/^[([{<'"]+/);
      const off = lead ? lead[0].length : 0;
      const parsed = parseFileLink(m[0].slice(off));
      if (!parsed) continue;
      const startIdx = m.index + off; // 0-based string index of the link's first char
      links.push({
        text: parsed.text,
        // xterm columns are 1-based; end.x is the (inclusive) last cell.
        range: {
          start: { x: startIdx + 1, y },
          end: { x: startIdx + parsed.text.length, y },
        },
        activate: () => this.open(parsed.file, parsed.line),
      });
    }
    cb(links);
  }
}

/** Register the file-path link provider on a terminal. */
export function installFileLinks(term: Terminal, open: OpenFile): void {
  term.registerLinkProvider(new FileLinkProvider(term, open));
}
