import { existsSync, readFileSync, statSync, readdirSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";

/**
 * Startup self-check: "I pulled and restarted, why is nothing different?"
 *
 * Two things a `git pull` does NOT update, both of which the server depends on:
 *
 *  1. The client bundle. `dist/` is gitignored and `npm start` / the service
 *     don't rebuild it, so a pull + restart kept serving the OLD interface.
 *     → If dist is missing or older than any client source, rebuild it before
 *       serving (vite run directly with this node — no PATH needed, which
 *       matters under launchd/systemd).
 *
 *  2. Dependencies. A pull that bumps package-lock.json (e.g. the Agent SDK)
 *     left the old packages installed, so new features failed quietly.
 *     → If installed versions don't match the lockfile, run `npm install`, then
 *       EXIT so the service manager restarts the server: Node has already loaded
 *       every module (the old SDK included) before any code here runs, so only a
 *       fresh process actually picks the new versions up. One attempt per
 *       lockfile, so a failing install can't crash-loop the service.
 *
 * Everything is synchronous and runs before the server binds a port.
 */

const MARKER = join(homedir(), ".fleetview", "deps-install-attempt");

function mtime(p) {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

/** Newest mtime under a directory (skipping node_modules / dot-dirs). */
function newestUnder(dir) {
  let newest = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    newest = Math.max(newest, e.isDirectory() ? newestUnder(p) : mtime(p));
  }
  return newest;
}

function readJson(p) {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function box(lines) {
  const bar = "─".repeat(66);
  console.warn("\n" + bar);
  for (const l of lines) console.warn("  " + l);
  console.warn(bar + "\n");
}

/** Installed top-level packages that don't match package-lock.json. */
export function depMismatches(root) {
  const pkg = readJson(join(root, "package.json"));
  const lock = readJson(join(root, "package-lock.json"));
  if (!pkg || !lock?.packages) return [];
  const names = Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) });
  const out = [];
  for (const name of names) {
    const want = lock.packages[`node_modules/${name}`]?.version;
    if (!want) continue;
    const have = readJson(join(root, "node_modules", name, "package.json"))?.version || null;
    if (have !== want) out.push({ name, want, have });
  }
  return out;
}

/**
 * npm's own CLI script for the node that's running — PATH-independent (the
 * service has a minimal PATH). Installs differ: the official/nvm layout keeps
 * npm inside node's prefix, Homebrew keeps it in its own lib dir and puts a
 * symlink next to node — so follow that symlink first.
 */
function npmCli() {
  const bin = dirname(process.execPath);
  const candidates = [];
  try {
    candidates.push(realpathSync(join(bin, "npm"))); // → …/npm/bin/npm-cli.js
  } catch {}
  candidates.push(
    join(bin, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    join(bin, "node_modules", "npm", "bin", "npm-cli.js"), // Windows-style layout
    "/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js",
    "/usr/local/lib/node_modules/npm/bin/npm-cli.js"
  );
  return candidates.find((p) => p.endsWith(".js") && existsSync(p)) || null;
}

/**
 * Make sure dependencies match the lockfile. May `npm install` and exit (so
 * the service restarts on the new versions). Returns the remaining
 * mismatches, for /api/version.
 */
export function ensureDeps(root) {
  const bad = depMismatches(root);
  if (!bad.length) return [];
  const list = bad.map((m) => `${m.name}: installed ${m.have || "missing"}, needs ${m.want}`);
  const lockHash = createHash("sha256").update(readFileSync(join(root, "package-lock.json"))).digest("hex");
  const tried = existsSync(MARKER) && readFileSync(MARKER, "utf8").trim() === lockHash;
  const cli = npmCli();
  if (tried || !cli || process.env.FLEET_AUTO_DEPS === "0") {
    box([
      "FleetView: installed packages don't match package-lock.json.",
      ...list.slice(0, 8),
      tried ? "An automatic `npm install` already ran for this lockfile and didn't fix it." : "",
      "Fix:  npm install    (then restart FleetView)",
    ].filter(Boolean));
    return bad;
  }
  console.log(`[fleetview] dependencies out of date (${bad.length}) — running npm install…`);
  for (const l of list.slice(0, 8)) console.log(`[fleetview]   ${l}`);
  try {
    mkdirSync(dirname(MARKER), { recursive: true });
    writeFileSync(MARKER, lockHash);
  } catch {}
  const r = spawnSync(process.execPath, [cli, "install", "--no-audit", "--no-fund"], {
    cwd: root,
    stdio: "inherit",
    timeout: 10 * 60 * 1000,
  });
  if (r.status === 0 && depMismatches(root).length === 0) {
    console.log("[fleetview] dependencies updated — restarting so they take effect.");
    // A fresh process is the only way to load the new versions. Under the
    // service (launchd KeepAlive / systemd Restart=on-failure) a non-zero exit
    // brings the server straight back; run by hand, start it again.
    if (process.stdout.isTTY) console.log("[fleetview] (started by hand: run the same command again)");
    process.exit(75);
  }
  box(["FleetView: `npm install` didn't complete cleanly.", "Fix:  npm install    (then restart FleetView)"]);
  return depMismatches(root);
}

/** Rebuild dist/ if it's missing or older than the client source. Returns true if it rebuilt. */
export function ensureFreshBuild(root) {
  const builtAt = mtime(join(root, "dist", "index.html"));
  const srcAt = Math.max(
    newestUnder(join(root, "client")),
    mtime(join(root, "vite.config.ts")),
    mtime(join(root, "package-lock.json"))
  );
  // What the last self-check build covered: protects against source files with
  // FUTURE mtimes (clock skew, odd unpacking) making every start "stale" again,
  // since a fresh dist/ would still be older than them.
  const stampFile = join(root, "dist", ".source-stamp");
  const covered = Number((existsSync(stampFile) && readFileSync(stampFile, "utf8")) || 0);
  if (builtAt && (builtAt >= srcAt || covered >= srcAt)) return false;
  const vite = join(root, "node_modules", "vite", "bin", "vite.js");
  if (!existsSync(vite)) {
    box(["FleetView: the client bundle is out of date, and vite isn't installed to rebuild it.", "Fix:  npm install && npm run build"]);
    return false;
  }
  console.log(`[fleetview] client bundle ${builtAt ? "is older than the source" : "is missing"} — rebuilding…`);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [vite, "build", "--logLevel", "warn"], { cwd: root, stdio: "inherit", timeout: 5 * 60 * 1000 });
  if (r.status !== 0) {
    box(["FleetView: rebuilding the client failed — serving the previous bundle.", "Fix:  npm run build   (see the error above)"]);
    return false;
  }
  console.log(`[fleetview] client rebuilt in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
  try {
    writeFileSync(stampFile, String(srcAt));
  } catch {}
  return true;
}

/**
 * The code this process is RUNNING — captured once at startup on purpose: after
 * a pull without a restart, HEAD moves but the running code doesn't, and that
 * mismatch is exactly what this is here to expose.
 */
export function serverVersion(root, startedAt, mismatches) {
  const git = (args) => {
    const r = spawnSync("git", args, { cwd: root, encoding: "utf8", timeout: 3000 });
    return r.status === 0 ? r.stdout.trim() : null;
  };
  return {
    server: {
      commit: git(["rev-parse", "--short", "HEAD"]),
      branch: git(["rev-parse", "--abbrev-ref", "HEAD"]),
      dirty: !!git(["status", "--porcelain", "--untracked-files=no"]),
      startedAt,
    },
    deps: mismatches,
  };
}

/** The bundle dist/ currently holds (written by vite.config.ts's build-info plugin). */
export function bundleVersion(root) {
  return readJson(join(root, "dist", "build-info.json"));
}
