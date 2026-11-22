import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { relative, isAbsolute, join, dirname, basename } from "node:path";
import { realpathSync } from "node:fs";
import { findTranscript, allTranscriptEvents } from "./transcript.js";

/**
 * "What has this session changed?" — the Changes panel in a chat pane.
 *
 * Two sources, because neither alone is the truth:
 *  - the session's TRANSCRIPT says which files Claude edited/wrote in this
 *    conversation (all of it, not just what the chat has loaded);
 *  - GIT in the pane's folder says what those files look like on disk NOW,
 *    against the last commit — edits since reverted, amended by hand, or
 *    already committed all show as they really are.
 *
 * Uncommitted changes the session did NOT make are returned separately
 * ("other"), so another session's or your own work is never attributed to
 * this one. Outside a git repo it falls back to the session's own edit inputs
 * (the client turns those into diffs with the same code the chat steps use).
 *
 * git runs via execFile with argument arrays (no shell), a timeout and an
 * output cap. Read-only: nothing here writes to the repo.
 */

const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
const MAX_FILES = 80;
const MAX_DIFF = 120_000; // chars per file diff
const MAX_EDITS = 30; // per file, non-git fallback
const MAX_UNTRACKED = 200_000; // bytes read to show a new file

function git(cwd, args) {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: 8000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) =>
      resolve(err ? null : String(stdout))
    );
  });
}

function stat01(diff) {
  let add = 0;
  let del = 0;
  for (const l of diff.split("\n")) {
    if (l.startsWith("+") && !l.startsWith("+++")) add++;
    else if (l.startsWith("-") && !l.startsWith("---")) del++;
  }
  return { add, del };
}

function cap(diff) {
  return diff.length > MAX_DIFF ? diff.slice(0, MAX_DIFF) + "\n… (diff truncated)" : diff;
}

/**
 * Canonical path, so a transcript's "/tmp/x" matches git's "/private/tmp/x"
 * (macOS symlinks /tmp; any symlinked folder does the same). A deleted file
 * has no realpath, so resolve its folder and re-attach the name.
 */
export function real(p) {
  try {
    return realpathSync(p);
  } catch {
    try {
      return join(realpathSync(dirname(p)), basename(p));
    } catch {
      return p;
    }
  }
}

/** Files this session edited, in first-touched order, with the edit inputs (for the non-git fallback). */
export function touchedFiles(configDir, sdkSessionId) {
  const out = new Map(); // abs path -> [{tool, input}]
  if (!sdkSessionId) return out;
  const file = findTranscript(configDir, sdkSessionId);
  if (!file) return out;
  for (const e of allTranscriptEvents(file)) {
    if (e.t !== "tool_call" || !EDIT_TOOLS.has(e.name)) continue;
    const p = e.input && (e.input.file_path || e.input.notebook_path);
    if (typeof p !== "string" || !isAbsolute(p)) continue;
    const key = real(p);
    if (!out.has(key)) out.set(key, []);
    const list = out.get(key);
    if (list.length < MAX_EDITS) list.push({ tool: e.name, input: e.input });
  }
  return out;
}

/** `git status --porcelain -z` → Map(relPath → status letter). Renames report the new path. */
function parseStatus(raw) {
  const m = new Map();
  if (!raw) return m;
  const parts = raw.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (rec.length < 4) continue;
    const xy = rec.slice(0, 2);
    const path = rec.slice(3);
    if (xy[0] === "R" || xy[0] === "C") i++; // the next field is the old path
    const s = xy === "??" ? "A" : xy.includes("D") ? "D" : xy.includes("A") ? "A" : xy[0] === "R" ? "R" : "M";
    m.set(path, { status: s, untracked: xy === "??" });
  }
  return m;
}

async function untrackedDiff(abs) {
  try {
    const st = await stat(abs);
    if (!st.isFile()) return { diff: "", note: "not a regular file" };
    if (st.size > MAX_UNTRACKED) return { diff: "", note: `new file, ${Math.round(st.size / 1024)} KB — too large to show` };
    const buf = await readFile(abs);
    if (buf.includes(0)) return { diff: "", note: "new binary file" };
    const text = buf.toString("utf8").replace(/\n$/, ""); // a final newline isn't a line
    return { diff: cap(text.split("\n").map((l) => "+" + l).join("\n")) };
  } catch {
    return { diff: "", note: "unreadable" };
  }
}

async function fileDiff(root, rel, info, hasHead) {
  const abs = join(root, rel);
  if (info.untracked || !hasHead) return untrackedDiff(abs);
  const raw = await git(root, ["diff", "--no-color", "--no-ext-diff", "HEAD", "--", rel]);
  if (raw == null) return { diff: "", note: "diff unavailable" };
  if (/^Binary files/m.test(raw)) return { diff: "", note: "binary file changed" };
  // Drop the "diff --git / index / ---/+++" preamble; keep from the first hunk.
  const at = raw.indexOf("\n@@");
  return { diff: cap(at >= 0 ? raw.slice(at + 1) : raw) };
}

/**
 * @param {{ cwd: string, configDir: string, sdkSessionId: string|null, remote?: boolean }} o
 */
export async function sessionChanges({ cwd, configDir, sdkSessionId, remote }) {
  if (remote) return { repo: null, session: [], other: [], note: "This session runs on another machine." };
  const touched = touchedFiles(configDir, sdkSessionId);

  const top = await git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!top) {
    // No git: what the session itself did, as edits for the client to diff.
    const session = [...touched.entries()].slice(0, MAX_FILES).map(([abs, edits]) => ({
      path: abs,
      rel: relative(real(cwd), abs).startsWith("..") ? abs : relative(real(cwd), abs),
      status: edits.some((e) => e.tool === "Write") && edits.length === 1 ? "A" : "M",
      edits,
    }));
    return { repo: null, session, other: [], note: "Not a git repository — showing the edits this session made." };
  }

  const root = real(top.trim());
  const branch = (await git(root, ["rev-parse", "--abbrev-ref", "HEAD"]))?.trim() || "";
  const hasHead = (await git(root, ["rev-parse", "--verify", "-q", "HEAD"])) != null;
  const status = parseStatus(await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]));

  const sessionRel = new Map(); // rel -> abs, for touched files inside this repo
  const outside = [];
  for (const abs of touched.keys()) {
    const rel = relative(root, abs);
    if (rel.startsWith("..") || isAbsolute(rel)) outside.push(abs);
    else sessionRel.set(rel, abs);
  }

  const session = [];
  for (const [rel] of sessionRel) {
    if (session.length >= MAX_FILES) break;
    const info = status.get(rel);
    if (!info) {
      // Touched, but identical to HEAD now: committed, or changed back.
      session.push({ path: join(root, rel), rel, status: "clean", add: 0, del: 0, diff: "" });
      continue;
    }
    const d = await fileDiff(root, rel, info, hasHead);
    session.push({ path: join(root, rel), rel, status: info.status, ...stat01(d.diff), ...d });
  }
  for (const abs of outside.slice(0, Math.max(0, MAX_FILES - session.length))) {
    session.push({ path: abs, rel: abs, status: "M", outside: true, edits: touched.get(abs) });
  }

  const other = [];
  for (const [rel, info] of status) {
    if (sessionRel.has(rel)) continue;
    if (other.length >= MAX_FILES) break;
    const d = await fileDiff(root, rel, info, hasHead);
    other.push({ path: join(root, rel), rel, status: info.status, ...stat01(d.diff), ...d });
  }

  return { repo: { root, branch }, session, other };
}
