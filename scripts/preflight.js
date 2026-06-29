// Dependency preflight / doctor. Imported by the server (warn-only, runs before
// anything binds) and runnable directly as `npm run doctor` (report + optional
// consented install). The whole point: `npm run go` either gives you a fully
// durable setup, or tells you the exact command to fix what's missing — loudly.

import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createInterface } from "node:readline";

// Resolve a binary by scanning PATH (+ common dirs Homebrew/system use), so we
// don't depend on `which`/`command -v` being present or a login shell's PATH.
function has(bin) {
  const dirs = [
    ...(process.env.PATH || "").split(delimiter),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ];
  return dirs.some((d) => d && existsSync(join(d, bin)));
}

// The package manager + how it installs a package on this platform.
function pkgManager() {
  if (process.platform === "darwin") {
    if (has("brew")) return { install: (p) => `brew install ${p}`, canAuto: true };
    return { install: () => null, canAuto: false, hint: "install Homebrew (https://brew.sh), then" };
  }
  const mgrs = [
    ["apt-get", (p) => `sudo apt install -y ${p}`],
    ["dnf", (p) => `sudo dnf install -y ${p}`],
    ["pacman", (p) => `sudo pacman -S --noconfirm ${p}`],
    ["zypper", (p) => `sudo zypper install -y ${p}`],
    ["apk", (p) => `sudo apk add ${p}`],
  ];
  for (const [bin, fn] of mgrs) if (has(bin)) return { install: fn, canAuto: true };
  return { install: () => null, canAuto: false };
}

const DEPS = [
  {
    bin: "tmux",
    pkg: "tmux",
    level: "durability",
    why: "terminals will NOT survive a server restart",
  },
  {
    bin: "curl",
    pkg: "curl",
    level: "alerts",
    why: "the attention hooks (glow / ding) can't phone home",
  },
  {
    bin: "claude",
    pkg: null,
    level: "agents",
    why: "windows can't run `claude` (plain shells still work)",
    installCmd: "npm install -g @anthropic-ai/claude-code",
  },
];

export function checkDeps() {
  const pm = pkgManager();
  return DEPS.map((d) => {
    const present = has(d.bin);
    let fix = d.installCmd || null;
    if (!present && !fix) {
      const cmd = pm.install(d.pkg);
      fix = cmd
        ? (pm.hint ? `${pm.hint} ${cmd}` : cmd)
        : `install ${d.pkg} with your package manager`;
    }
    return { ...d, present, fix, pm };
  });
}

const ICON = { durability: "⚠", alerts: "•", agents: "•" };

// Print missing-dependency warnings. quietIfOk → say nothing when all present
// (used at server start so a healthy boot stays clean).
export function preflight({ quietIfOk = false } = {}) {
  const results = checkDeps();
  const missing = results.filter((r) => !r.present);
  if (missing.length === 0) {
    if (!quietIfOk) console.log("[fleetview] preflight ✓  tmux, curl, claude all found.");
    return results;
  }
  const bar = "─".repeat(66);
  console.warn("\n" + bar);
  console.warn("  FleetView preflight — missing dependencies:");
  console.warn(bar);
  for (const m of missing) {
    console.warn(`${ICON[m.level] || "•"}  ${m.bin} not found — ${m.why}.`);
    console.warn(`   Fix:  ${m.fix}${m.bin === "tmux" ? "   (then restart FleetView)" : ""}`);
  }
  console.warn(bar + "\n");
  return results;
}

// ---- CLI (`npm run doctor`): report, then offer to install tmux ----------
function confirm(question) {
  return new Promise((res) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (a) => {
      rl.close();
      res(/^y(es)?$/i.test(a.trim()));
    });
  });
}

async function main() {
  const results = preflight();
  const tmux = results.find((r) => r.bin === "tmux");
  if (tmux.present) return;
  if (!tmux.pm.canAuto) return; // no package manager → the fix was already printed

  // Auto-install only with explicit consent: FLEET_AUTO_INSTALL=1, or an
  // interactive yes. Never invoke a package manager silently.
  let go = process.env.FLEET_AUTO_INSTALL === "1";
  if (!go && process.stdin.isTTY) go = await confirm(`\nInstall tmux now via \`${tmux.fix}\`? [y/N] `);
  if (!go) {
    console.log(`\nLeaving it to you:  ${tmux.fix}`);
    return;
  }
  console.log(`[fleetview] installing tmux…  (${tmux.fix})`);
  const r = spawnSync("bash", ["-c", tmux.fix], { stdio: "inherit" });
  if (r.status === 0 && has("tmux")) {
    console.log("[fleetview] tmux installed ✓ — start FleetView with `npm start`.");
  } else {
    console.warn(`[fleetview] tmux install didn't complete; run it manually:\n  ${tmux.fix}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
