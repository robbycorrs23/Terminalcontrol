import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { relative, isAbsolute } from "node:path";
import { gitInfo } from "./worktrees.js";
import { sessionChanges, touchedFiles, real } from "./changes.js";
import { findTranscript, allTranscriptEvents } from "./transcript.js";
import { oneShot } from "./auto-title.js";

/**
 * "Ship it" from the Changes panel: commit → push → open a PR, with the commit
 * message and PR text drafted from what the session actually did (Haiku via
 * oneShot, editable before anything happens; plain fallbacks if it fails).
 *
 * Safety rules, all enforced here rather than in the UI:
 *  - only the files you tick are committed (in a shared checkout the session's
 *    own files are pre-ticked; in its own worktree, everything is);
 *  - pushing the repo's DEFAULT branch from here is refused — ship on a branch;
 *  - a new branch name is validated by `git check-ref-format`;
 *  - every git/gh call is execFile with an argv (no shell), with timeouts.
 * Verified beforehand: push and `gh` work under the service's minimal env
 * (HTTPS remotes + macOS keychain; gh authenticated via keyring).
 */

const run = promisify(execFile);
const sh = async (cmd, cwd, args, timeout = 60000) => (await run(cmd, args, { cwd, timeout, maxBuffer: 16 * 1024 * 1024 })).stdout.trim();
const git = (cwd, args, t) => sh("git", cwd, args, t);
const tryGit = (cwd, args) => git(cwd, args).catch(() => null);
const errText = (e) => String(e?.stderr || e?.message || e).trim().split("\n").slice(-3).join(" ");

async function defaultBranch(root) {
  const head = await tryGit(root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (head) return head.replace(/^origin\//, "");
  for (const b of ["main", "master"]) if (await tryGit(root, ["rev-parse", "--verify", "-q", b])) return b;
  return null;
}

/** The session's first prompt — context for commit/PR drafts. */
function firstPrompt(configDir, sdkSessionId) {
  const file = sdkSessionId && findTranscript(configDir, sdkSessionId);
  if (!file) return "";
  const u = allTranscriptEvents(file).find((e) => e.t === "user");
  return u ? String(u.text).slice(0, 1500) : "";
}

/** Everything the Ship section shows: branch facts + the files you could commit. */
export async function shipStatus(ctx) {
  const info = await gitInfo(ctx.cwd);
  if (!info) return { repo: false };
  const root = info.root;
  const def = await defaultBranch(root);
  const base = info.base || def;
  const branch = info.branch === "HEAD" ? null : info.branch;
  const upstream = branch ? await tryGit(root, ["rev-parse", "--abbrev-ref", "@{upstream}"]) : null;
  const unpushed = upstream ? Number((await tryGit(root, ["rev-list", "--count", "@{upstream}..HEAD"])) || 0) : null;
  const ahead = base && branch && base !== branch ? Number((await tryGit(root, ["rev-list", "--count", `${base}..HEAD`])) || 0) : 0;
  const ch = await sessionChanges(ctx);
  const files = [
    ...ch.session.filter((f) => f.status !== "clean" && !f.outside).map((f) => ({ rel: f.rel, status: f.status, session: true })),
    ...ch.other.map((f) => ({ rel: f.rel, status: f.status, session: false })),
  ];
  let pr = null;
  if (branch && upstream && branch !== def) {
    const out = await sh("gh", root, ["pr", "view", "--json", "url,state,number"], 15000).catch(() => null);
    if (out) pr = JSON.parse(out);
  }
  return {
    repo: true,
    root,
    branch,
    base,
    defaultBranch: def,
    worktree: info.worktree,
    onDefault: !!branch && branch === def,
    upstream,
    unpushed,
    ahead,
    files,
    pr,
  };
}

/** A commit message for the chosen files, drafted from their diff + the session's first prompt. */
export async function draftCommit(ctx, files) {
  const info = await gitInfo(ctx.cwd);
  if (!info || !files?.length) return { message: "" };
  const stat = (await tryGit(info.root, ["diff", "HEAD", "--stat", "--", ...files])) || "";
  const diff = ((await tryGit(info.root, ["diff", "HEAD", "--", ...files])) || "").slice(0, 8000);
  const fallback = files.length === 1 ? `Update ${files[0]}` : `Update ${files.length} files\n\n${files.map((f) => `- ${f}`).join("\n")}`;
  const text = await oneShot(
    "You write git commit messages. Output ONLY the message: an imperative summary line of at most 72 characters, then (only if useful) a blank line and a few short bullet points. No quotes, no code fences.",
    `The developer's request to the coding agent:\n${firstPrompt(ctx.configDir, ctx.sdkSessionId) || "(unknown)"}\n\nFiles changed (stat):\n${stat}\n\nDiff (truncated):\n${diff}\n\nNew files without a diff: ${files.filter((f) => !stat.includes(f)).join(", ") || "none"}`,
    { env: ctx.env, cwd: info.root }
  );
  return { message: text.replace(/^```\w*\n?|```$/g, "").trim() || fallback };
}

/** Commit the chosen files, optionally onto a new branch. Returns { ok, sha?, branch?, reason? }. */
export async function commit(ctx, { files, message, newBranch }) {
  const info = await gitInfo(ctx.cwd);
  if (!info) return { ok: false, reason: "Not a git repository." };
  if (!Array.isArray(files) || !files.length) return { ok: false, reason: "Choose at least one file." };
  if (!String(message || "").trim()) return { ok: false, reason: "Write a commit message." };
  // Only paths inside this repo, as the panel listed them.
  const safe = files.filter((f) => typeof f === "string" && f && !isAbsolute(f) && !relative(".", f).startsWith(".."));
  if (safe.length !== files.length) return { ok: false, reason: "Unexpected file path." };
  try {
    if (newBranch) {
      await git(info.root, ["check-ref-format", "--branch", newBranch]);
      const from = info.branch !== "HEAD" ? info.branch : null;
      await git(info.root, ["switch", "-c", newBranch]); // carries the uncommitted changes along
      if (from) await tryGit(info.root, ["config", `branch.${newBranch}.fleetBase`, from]);
    }
    await git(info.root, ["add", "-A", "--", ...safe]);
    await git(info.root, ["commit", "-m", String(message).trim(), "--", ...safe]);
    const sha = await git(info.root, ["rev-parse", "--short", "HEAD"]);
    return { ok: true, sha, branch: newBranch || info.branch };
  } catch (e) {
    return { ok: false, reason: errText(e) };
  }
}

/** Push the current branch (never the default branch). */
export async function push(ctx) {
  const info = await gitInfo(ctx.cwd);
  if (!info || info.branch === "HEAD") return { ok: false, reason: "Not on a branch." };
  const def = await defaultBranch(info.root);
  if (info.branch === def) return { ok: false, reason: `Pushing ${def} from here is disabled — commit to a branch and open a PR.` };
  try {
    await git(info.root, ["push", "-u", "origin", info.branch], 120000);
    return { ok: true, branch: info.branch };
  } catch (e) {
    return { ok: false, reason: errText(e) };
  }
}

/** PR title + body drafted from the branch's commits and diffstat. */
export async function draftPr(ctx) {
  const st = await shipStatus(ctx);
  if (!st.repo || !st.branch || !st.base) return { title: "", body: "" };
  const log = (await tryGit(st.root, ["log", "--format=- %s%n%b", `${st.base}..HEAD`])) || "";
  const stat = (await tryGit(st.root, ["diff", "--stat", `${st.base}...HEAD`])) || "";
  const fallbackTitle = (log.split("\n")[0] || st.branch).replace(/^- /, "");
  const text = await oneShot(
    "You write GitHub pull request descriptions. Output ONLY: a title line (under 70 characters, no prefix), a blank line, then a concise Markdown body with a short Summary section and a bullet list of changes. No code fences around the whole thing.",
    `The developer's request to the coding agent:\n${firstPrompt(ctx.configDir, ctx.sdkSessionId) || "(unknown)"}\n\nCommits:\n${log.slice(0, 4000)}\n\nDiffstat:\n${stat.slice(0, 3000)}`,
    { env: ctx.env, cwd: st.root }
  );
  const [first, ...rest] = text.split("\n");
  return { title: (first || "").replace(/^#+\s*|^title:\s*/i, "").trim() || fallbackTitle, body: rest.join("\n").trim() || log };
}

/** Open the PR with gh. Returns { ok, url?, reason? }. */
export async function openPr(ctx, { title, body }) {
  const st = await shipStatus(ctx);
  if (!st.repo || !st.branch) return { ok: false, reason: "Not on a branch." };
  if (st.onDefault) return { ok: false, reason: "Open a PR from a branch, not the default branch." };
  if (!st.upstream) return { ok: false, reason: "Push the branch first." };
  if (!String(title || "").trim()) return { ok: false, reason: "Give the PR a title." };
  try {
    const url = await sh("gh", st.root, ["pr", "create", "--base", st.base, "--head", st.branch, "--title", String(title).trim(), "--body", String(body || "")], 60000);
    return { ok: true, url: url.split("\n").pop() };
  } catch (e) {
    return { ok: false, reason: errText(e) };
  }
}

/**
 * Files edited in more than one session of the same repository — "Session B is
 * also editing api.ts". Keyed per pane. Sessions are grouped by git common dir,
 * so worktrees of one repo count as the same repo (their edits will collide at
 * merge time even though they don't on disk).
 */
export async function overlaps(panes) {
  const groups = new Map(); // commonDir -> [{ id, name, files:Set<rel> }]
  for (const p of panes) {
    if (!p.sdkSessionId || p.remote) continue;
    const info = await gitInfo(p.cwd).catch(() => null);
    if (!info) continue;
    const root = real(info.root);
    const files = new Set();
    for (const abs of touchedFiles(p.configDir, p.sdkSessionId).keys()) {
      const rel = relative(root, abs);
      if (!rel.startsWith("..") && !isAbsolute(rel)) files.add(rel);
    }
    if (!files.size) continue;
    if (!groups.has(info.commonDir)) groups.set(info.commonDir, []);
    groups.get(info.commonDir).push({ id: p.id, name: p.name, files });
  }
  const out = {};
  for (const list of groups.values()) {
    for (const a of list) {
      for (const b of list) {
        if (a === b) continue;
        const shared = [...a.files].filter((f) => b.files.has(f));
        if (shared.length) (out[a.id] ||= []).push({ pane: b.id, name: b.name, files: shared.slice(0, 20) });
      }
    }
  }
  return out;
}
