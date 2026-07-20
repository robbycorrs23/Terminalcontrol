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

// A line needs server validation only when it has a space AND a path signal (a
// "/" or a file-extension-like token). Without a space the client can match on
// its own; with one, only the filesystem can say where the path ends.
const NEEDS_SERVER =
  /(?:\/|\.[A-Za-z0-9]{2,8}(?=$|[\s:)\]}]))/;

class FileLinkProvider implements ILinkProvider {
  constructor(
    private term: Terminal,
    private paneId: string,
    private open: OpenFile
  ) {}

  provideLinks(y: number, cb: (links: ILink[] | undefined) => void): void {
    const bufLine = this.term.buffer.active.getLine(y - 1);
    if (!bufLine) return cb(undefined);
    // Keep trailing spaces so string indices line up with terminal columns.
    const text = bufLine.translateToString(false);
    if (text.includes(" ") && NEEDS_SERVER.test(text)) {
      void this.serverLinks(text, y, cb); // spaces → let the server validate
    } else {
      cb(this.clientLinks(text, y)); // fast path, no round-trip
    }
  }

  // Whitespace-delimited tokens matched purely client-side (no spaces in paths).
  private clientLinks(text: string, y: number): ILink[] {
    const links: ILink[] = [];
    const tokenRe = /\S+/g;
    let m: RegExpExecArray | null;
    while ((m = tokenRe.exec(text))) {
      // Skip a leading opener like "(" or quote so the link range is tight.
      const lead = m[0].match(/^[([{<'"]+/);
      const off = lead ? lead[0].length : 0;
      const parsed = parseFileLink(m[0].slice(off));
      if (!parsed) continue;
      const startIdx = m.index + off; // 0-based index of the link's first char
      links.push(this.link(parsed.text, startIdx, y, parsed.file, parsed.line));
    }
    return links;
  }

  // Ask the server which spans of this line are real files/dirs (spaces and all).
  private async serverLinks(
    text: string,
    y: number,
    cb: (links: ILink[] | undefined) => void
  ): Promise<void> {
    try {
      const res = await fetch(`/api/panes/${this.paneId}/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ line: text }),
      });
      if (!res.ok) return cb(undefined);
      const { links } = (await res.json()) as {
        links: { start: number; end: number; path: string; line?: number }[];
      };
      cb(
        links.map((l) =>
          this.link(text.slice(l.start, l.end), l.start, y, l.path, l.line)
        )
      );
    } catch {
      cb(undefined);
    }
  }

  // Build one xterm link. `startIdx` is a 0-based string index; xterm columns
  // are 1-based and range.end.x is the inclusive last cell.
  private link(
    label: string,
    startIdx: number,
    y: number,
    file: string,
    line?: number
  ): ILink {
    return {
      text: label,
      range: {
        start: { x: startIdx + 1, y },
        end: { x: startIdx + label.length, y },
      },
      activate: () => this.open(file, line),
    };
  }
}

/** Register the file-path link provider on a terminal. */
export function installFileLinks(
  term: Terminal,
  paneId: string,
  open: OpenFile
): void {
  term.registerLinkProvider(new FileLinkProvider(term, paneId, open));
}
