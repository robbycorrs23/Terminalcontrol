import { statSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

// Expand a leading ~ to the home directory (paths are otherwise left as-is).
function expand(raw) {
  return raw.startsWith("~") ? homedir() + raw.slice(1) : raw;
}

// Only linkify things that look like paths — a "/" or a trailing file
// extension — so ordinary prose words are never probed against the filesystem.
function qualifies(s) {
  return s.includes("/") || /[\w-]\.[A-Za-z0-9]{1,8}$/.test(s);
}

function statOrNull(abs) {
  try {
    return statSync(abs);
  } catch {
    return null;
  }
}

/**
 * Find file/dir paths inside a line of terminal text, validated against the
 * filesystem so paths containing spaces (common on macOS) are matched whole.
 *
 * For each word boundary we try the longest span first, shrinking a word at a
 * time until a candidate resolves (against `cwd`) to something that exists.
 * Prose is free: `qualifies()` gates every filesystem probe, so a line with no
 * path-shaped candidate does zero stats.
 *
 * Returns non-overlapping matches with half-open string indices [start, end)
 * into `line`; `path` is absolute and known to exist; `line` (number) is the
 * clicked line for files that carried a ":42" suffix.
 */
export function findPathLinks(line, cwd) {
  const links = [];
  const n = line.length;
  const isSpace = (c) => c === " " || c === "\t";
  let i = 0;
  while (i < n) {
    if (isSpace(line[i])) {
      i++;
      continue;
    }
    // Word-boundary end indices from i to end of line (exclusive positions).
    const ends = [];
    for (let j = i + 1; j <= n; j++) {
      if (j === n || isSpace(line[j])) ends.push(j);
    }
    let matched = null;
    for (let k = ends.length - 1; k >= 0; k--) {
      // Trim trailing sentence punctuation, then peel an optional :line[:col].
      const cand = line.slice(i, ends[k]).replace(/[).,;'"\]}>]+$/, "");
      if (!cand) continue;
      let filePart = cand;
      let lineNo;
      const suf = cand.match(/:(\d+)(?::\d+)?$/);
      if (suf) {
        filePart = cand.slice(0, suf.index);
        lineNo = Number(suf[1]);
      }
      if (!filePart || !qualifies(filePart)) continue;
      if (/^[a-z][\w+.-]*:\/\//i.test(filePart)) continue; // URL → web-links owns it
      const st = statOrNull(resolve(cwd, expand(filePart)));
      if (!st) continue;
      matched = {
        start: i,
        end: i + cand.length,
        path: resolve(cwd, expand(filePart)),
        line: st.isFile() ? lineNo : undefined,
      };
      break;
    }
    if (matched) {
      links.push(matched);
      i = matched.end;
    } else {
      while (i < n && !isSpace(line[i])) i++; // no match here → skip this word
    }
  }
  return links;
}
