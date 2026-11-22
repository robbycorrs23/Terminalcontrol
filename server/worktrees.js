import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, readdirSync, statSync, copyFileSync, realpathSync, readFileSync, appendFileSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

/**
 * "Own branch" sessions: each gets a git worktree, so several agents can work
 * on one repo without trampling each other's files (verified: a session in a
 * worktree commits on its branch while the main checkout stays untouched, and
 * resumes after a restart remembering its branch).
 *
 *  - Worktrees live OUTSIDE the repo: ~/.fleetview/worktrees/<repo>/<slug>.
 *  - Branch: fleet/<slug>. The branch it came from is recorded in git's own
 *    config (branch.<name>.fleetBase) — no FleetView state to lose or migrate.
 *  - `.env*` files at the repo root are copied in (most apps won't run without
 *    them; they're untracked so a worktree wouldn't have them). node_modules is
 *    deliberately NOT copied or linked — the agent installs what it needs.
 *  - Cleanup only ever uses git's SAFE commands: `worktree remove` refuses a
 *    worktree with uncommitted work, `branch -d` refuses an unmerged branch.
 *    Nothing here forces either.
 *
 * Everything is derived from the folder (gitInfo), so the terminal⇄chat flip,
 * restarts and the pane managers need no changes to carry it.
 */

const run = promisify(execFile);
const ROOT = join(homedir(), ".fleetview", "worktrees");

async function git(cwd, args, opts = {}) {
  const { stdout } = await run("git", args, { cwd, timeout: 20000, maxBuffer: 8 * 1024 * 1024, ...opts });
  return stdout.trim();
}
const tryGit = (cwd, args) => git(cwd, args).catch(() => null);
const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

function slugify(s) {
  const base = String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/, "");
  return `${base || "session"}-${randomBytes(2).toString("hex")}`;
}

/** Git facts about a folder: repo root, branch, whether it's a linked worktree, and its base. Null if not a repo. */
export async function gitInfo(cwd) {
  const out = await tryGit(cwd, ["rev-parse", "--show-toplevel", "--abbrev-ref", "HEAD", "--git-dir", "--git-common-dir"]);
  if (!out) return null;
  const [root, branch, gitDir, commonDir] = out.split("\n");
  const abs = (p) => (p.startsWith("/") ? p : join(cwd, p));
  const worktree = real(abs(gitDir)) !== real(abs(commonDir));
  const base = branch && branch !== "HEAD" ? await tryGit(cwd, ["config", `branch.${branch}.fleetBase`]) : null;
  return { root, branch, worktree, commonDir: real(abs(commonDir)), base: base || null };
}

/** Copy small untracked `.env*` files from the repo root into the new worktree. */
function copyEnvFiles(from, to) {
  const copied = [];
  for (const name of readdirSync(from)) {
    if (!/^\.env(\..+)?$/.test(name)) continue;
    const src = join(from, name);
    try {
      const st = statSync(src);
      if (!st.isFile() || st.size > 1024 * 1024 || existsSync(join(to, name))) continue;
      copyFileSync(src, join(to, name));
      copied.push(name);
    } catch {}
  }
  return copied;
}

/**
 * Make sure the copied env files are IGNORED, via the repo's local exclude
 * file (<common git dir>/info/exclude — never committed, shared by the
 * repo's worktrees, and it never affects files git already tracks). Without
 * this a copied .env shows as an uncommitted file: "Finish branch" refuses
 * forever, and worse, the Ship form offers secrets as a file to commit.
 */
function ignoreLocally(commonDir, names) {
  const file = join(commonDir, "info", "exclude");
  try {
    mkdirSync(join(commonDir, "info"), { recursive: true });
    const have = existsSync(file) ? readFileSync(file, "utf8").split("\n") : [];
    const add = names.map((n) => "/" + n).filter((l) => !have.includes(l));
    if (add.length) appendFileSync(file, (have.length && have[have.length - 1] !== "" ? "\n" : "") + "# FleetView: env files copied into worktrees\n" + add.join("\n") + "\n");
  } catch {}
}

/**
 * Create a worktree + branch for a new session started in `cwd`. `hint`
 * (e.g. the first message) names the branch. Returns { path, branch, base, root, envCopied }.
 */
export async function createWorktree(cwd, hint) {
  const info = await gitInfo(cwd);
  if (!info) throw new Error("That folder isn't a git repository.");
  const slug = slugify(hint);
  const branch = `fleet/${slug}`;
  const dir = join(ROOT, basename(info.root), slug);
  mkdirSync(join(ROOT, basename(info.root)), { recursive: true });
  const base = info.branch && info.branch !== "HEAD" ? info.branch : null;
  await git(info.root, ["worktree", "add", "-b", branch, dir, "HEAD"]);
  if (base) await tryGit(info.root, ["config", `branch.${branch}.fleetBase`, base]);
  const envCopied = copyEnvFiles(info.root, dir);
  if (envCopied.length) ignoreLocally(info.commonDir, envCopied);
  return { path: dir, branch, base, root: info.root, envCopied };
}

/**
 * Remove a session's worktree and (if merged) its branch — the deliberate
 * cleanup step. Refuses with uncommitted work; keeps an unmerged branch.
 * Returns { ok, reason?, branchDeleted }.
 */
export async function finishWorktree(path) {
  const info = await gitInfo(path);
  if (!info?.worktree) return { ok: false, reason: "This session isn't on its own worktree." };
  const dirty = await tryGit(path, ["status", "--porcelain"]);
  if (dirty) return { ok: false, reason: "This branch has uncommitted changes — commit or discard them first." };
  const main = (await tryGit(info.commonDir, ["rev-parse", "--show-toplevel"])) || join(info.commonDir, "..");
  try {
    await git(main, ["worktree", "remove", path]); // refuses if anything is uncommitted
  } catch (e) {
    return { ok: false, reason: String(e.stderr || e.message).split("\n")[0] };
  }
  // Delete the branch only once it's merged into its BASE. `branch -d` alone
  // isn't enough: it also accepts "merged into its upstream", which is true
  // the moment you push — so a pushed-but-unmerged PR branch would vanish.
  let branchDeleted = false;
  const base = info.base || (await tryGit(main, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]))?.replace(/^origin\//, "");
  const merged = base && (await tryGit(main, ["merge-base", "--is-ancestor", info.branch, base])) !== null;
  if (merged) {
    try {
      await git(main, ["branch", "-d", info.branch]); // still refuses if git disagrees
      branchDeleted = true;
    } catch {}
  }
  return { ok: true, branch: info.branch, branchDeleted };
}
