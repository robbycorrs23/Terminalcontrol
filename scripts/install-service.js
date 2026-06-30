// Install a per-user auto-start service so FleetView's server comes back after a
// reboot/login. launchd on macOS, systemd --user on Linux. Opt-in (never run from
// postinstall). Paths are computed at install time, not hardcoded.
//
// THE EASY-TO-GET-WRONG PART: launchd/systemd hand a service a minimal PATH, so a
// naively-installed service can't find tmux / claude / curl and terminals silently
// fall back to non-durable shells (or claude won't launch). We capture a usable
// PATH (well-known dirs + the current PATH) into the service environment.
//
// Run with --dry-run to write the unit file but NOT load it (for inspection).

import { writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const dryRun = process.argv.includes("--dry-run") || process.env.FLEET_SERVICE_DRYRUN === "1";
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const NODE = process.execPath; // the exact node binary running this script
const ENTRY = join(REPO, "server", "index.js");
const HOME = homedir();

// Capture a PATH the service can actually use. Prepend the dirs tmux/claude/curl
// usually live in, then the current PATH, deduped.
function capturePath() {
  const wellKnown = [
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    join(HOME, ".local/bin"),
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
  const seen = new Set();
  const out = [];
  for (const d of [...wellKnown, ...(process.env.PATH || "").split(":")]) {
    if (d && !seen.has(d)) {
      seen.add(d);
      out.push(d);
    }
  }
  return out.join(":");
}

const PATH = capturePath();
const envPass = {};
if (process.env.FLEET_PORT) envPass.FLEET_PORT = process.env.FLEET_PORT;
if (process.env.FLEET_HOST) envPass.FLEET_HOST = process.env.FLEET_HOST;
if (process.env.FLEET_ALLOWED_HOSTS) envPass.FLEET_ALLOWED_HOSTS = process.env.FLEET_ALLOWED_HOSTS;

if (process.platform === "darwin") installMac();
else if (process.platform === "linux") installLinux();
else {
  console.log("auto-start not supported on this platform (need launchd or systemd --user).");
  process.exit(0);
}

// ---- macOS / launchd --------------------------------------------------
function installMac() {
  const LABEL = "com.fleetview.server";
  const plistPath = join(HOME, "Library", "LaunchAgents", `${LABEL}.plist`);
  const logPath = join(HOME, "Library", "Logs", "fleetview.log");

  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const envEntries = Object.entries({ PATH, ...envPass })
    .map(([k, v]) => `      <key>${k}</key><string>${esc(v)}</string>`)
    .join("\n");

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(NODE)}</string>
    <string>${esc(ENTRY)}</string>
  </array>
  <key>WorkingDirectory</key><string>${esc(REPO)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>EnvironmentVariables</key>
  <dict>
${envEntries}
  </dict>
  <key>StandardOutPath</key><string>${esc(logPath)}</string>
  <key>StandardErrorPath</key><string>${esc(logPath)}</string>
</dict>
</plist>
`;

  mkdirSync(dirname(plistPath), { recursive: true });
  mkdirSync(dirname(logPath), { recursive: true });
  writeFileSync(plistPath, plist);
  console.log(`[fleetview] wrote ${plistPath}`);

  if (dryRun) {
    console.log("[fleetview] --dry-run: not loading. Inspect the plist above.");
    return;
  }
  spawnSync("launchctl", ["unload", plistPath], { stdio: "ignore" }); // ignore: nothing loaded yet
  const r = spawnSync("launchctl", ["load", "-w", plistPath], { stdio: "inherit" });
  if (r.status !== 0) {
    console.error("[fleetview] launchctl load failed — see output above.");
    process.exit(1);
  }
  console.log(`[fleetview] loaded ${LABEL} ✓  logs → ${logPath}`);
  doneNote();
}

// ---- Linux / systemd --user -------------------------------------------
function installLinux() {
  const unitPath = join(HOME, ".config", "systemd", "user", "fleetview.service");
  const envLines = Object.entries({ PATH, ...envPass })
    .map(([k, v]) => `Environment="${k}=${v}"`)
    .join("\n");

  // Quote the entry (the repo path may contain spaces) so systemd parses one arg.
  const unit = `[Unit]
Description=FleetView server
After=network.target

[Service]
Type=simple
WorkingDirectory=${REPO}
ExecStart=${NODE} "${ENTRY}"
Restart=on-failure
RestartSec=2
${envLines}

[Install]
WantedBy=default.target
`;

  mkdirSync(dirname(unitPath), { recursive: true });
  writeFileSync(unitPath, unit);
  console.log(`[fleetview] wrote ${unitPath}`);

  if (dryRun) {
    console.log("[fleetview] --dry-run: not enabling. Inspect the unit above.");
    return;
  }
  spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
  const r = spawnSync("systemctl", ["--user", "enable", "--now", "fleetview.service"], { stdio: "inherit" });
  if (r.status !== 0) {
    console.error("[fleetview] systemctl enable failed — see output above.");
    process.exit(1);
  }
  console.log("[fleetview] enabled fleetview.service ✓");
  console.log("[fleetview] to keep it running across logout: loginctl enable-linger $USER");
  doneNote();
}

function doneNote() {
  console.log(
    "\nFleetView will now start on login and restart if it crashes.\n" +
      "⚠  Don't ALSO run `npm start` / `npm run go` by hand — two servers will\n" +
      "   fight for the port. Use `npm run service:uninstall` to stop auto-start.\n" +
      "Note: a reboot returns the SERVER, not live sessions — recovered boxes are\n" +
      "fresh shells in the same folders (a reboot kills the tmux server)."
  );
}
