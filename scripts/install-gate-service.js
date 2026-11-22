// Install the passkey gate (server/gate.js) as a per-user auto-start service,
// the gate's counterpart to install-service.js: launchd (com.fleetview.gate) on
// macOS, systemd --user (fleetview-gate.service) on Linux.
//
// Why it matters beyond "starts on login": the gate restarts ITSELF into new
// code after an auto-update (it watches its own files and exits 75) — but only
// when a supervisor is there to bring it back. A gate started by hand just logs
// "restart me" and keeps serving the old code, which is how the iOS app's
// sign-in handoff went missing on a second machine.
//
// Needs FLEET_GATE_RP_ID + FLEET_GATE_ORIGIN (your tailnet hostname / its https
// URL) in the environment when you run it: a passkey is bound to that domain,
// and the localhost defaults would make every sign-in fail. Like
// install-service.js, it REPLACES the unit/plist and bakes in only what's in
// your shell right now. --dry-run writes the file without loading it.
//
//   FLEET_GATE_RP_ID=myhost.tailXXXX.ts.net FLEET_GATE_ORIGIN=https://myhost.tailXXXX.ts.net \
//     npm run service:install-gate

import { writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const dryRun = process.argv.includes("--dry-run");
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const NODE = process.execPath;
const ENTRY = join(REPO, "server", "gate.js");
const HOME = homedir();

const KEYS = [
  "FLEET_GATE_RP_ID",
  "FLEET_GATE_ORIGIN",
  "FLEET_GATE_PORT",
  "FLEET_GATE_TARGET",
  "FLEET_GATE_TARGET_SOCKET",
  "FLEET_GATE_RP_NAME",
  "FLEET_GATE_SESSION_HOURS",
];
const env = {};
for (const k of KEYS) if (process.env[k]) env[k] = process.env[k];

if (!env.FLEET_GATE_RP_ID || !env.FLEET_GATE_ORIGIN || env.FLEET_GATE_RP_ID === "localhost") {
  console.error(
    "[fleetview-gate] set FLEET_GATE_RP_ID and FLEET_GATE_ORIGIN first — your tailnet hostname and its https URL, e.g.\n" +
      "  FLEET_GATE_RP_ID=myhost.tailXXXX.ts.net FLEET_GATE_ORIGIN=https://myhost.tailXXXX.ts.net npm run service:install-gate\n" +
      "(passkeys are bound to that domain; the localhost defaults would break every sign-in)"
  );
  process.exit(1);
}
if (!/^https:\/\//.test(env.FLEET_GATE_ORIGIN)) {
  console.error("[fleetview-gate] FLEET_GATE_ORIGIN must be the https:// URL you open FleetView at.");
  process.exit(1);
}
env.PATH = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", ...(process.env.PATH || "").split(":")]
  .filter((d, i, a) => d && a.indexOf(d) === i)
  .join(":");

if (process.platform === "darwin") mac();
else if (process.platform === "linux") linux();
else {
  console.log("auto-start not supported on this platform (need launchd or systemd --user).");
  process.exit(0);
}

function mac() {
  const LABEL = "com.fleetview.gate";
  const plistPath = join(HOME, "Library", "LaunchAgents", `${LABEL}.plist`);
  const logPath = join(HOME, "Library", "Logs", "fleetview-gate.log");
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
${Object.entries(env).map(([k, v]) => `    <key>${k}</key><string>${esc(v)}</string>`).join("\n")}
  </dict>
  <key>StandardOutPath</key><string>${esc(logPath)}</string>
  <key>StandardErrorPath</key><string>${esc(logPath)}</string>
</dict>
</plist>
`;
  mkdirSync(dirname(plistPath), { recursive: true });
  writeFileSync(plistPath, plist);
  console.log(`[fleetview-gate] wrote ${plistPath}`);
  if (dryRun) return console.log("[fleetview-gate] --dry-run: not loading.");
  spawnSync("launchctl", ["unload", plistPath], { stdio: "ignore" });
  const r = spawnSync("launchctl", ["load", "-w", plistPath], { stdio: "inherit" });
  if (r.status !== 0) process.exit(1);
  console.log(`[fleetview-gate] loaded ${LABEL} ✓  logs → ${logPath}`);
}

function linux() {
  const unitPath = join(HOME, ".config", "systemd", "user", "fleetview-gate.service");
  const unit = `[Unit]
Description=FleetView passkey gate
After=network.target fleetview.service

[Service]
Type=simple
WorkingDirectory=${REPO}
ExecStart=${NODE} "${ENTRY}"
# Always: the gate exits on purpose to pick up new code after an auto-update.
Restart=always
RestartSec=2
${Object.entries(env).map(([k, v]) => `Environment="${k}=${v}"`).join("\n")}

[Install]
WantedBy=default.target
`;
  mkdirSync(dirname(unitPath), { recursive: true });
  writeFileSync(unitPath, unit);
  console.log(`[fleetview-gate] wrote ${unitPath}`);
  if (dryRun) return console.log("[fleetview-gate] --dry-run: not enabling.");
  spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
  const r = spawnSync("systemctl", ["--user", "enable", "--now", "fleetview-gate.service"], { stdio: "inherit" });
  if (r.status !== 0) process.exit(1);
  console.log("[fleetview-gate] enabled fleetview-gate.service ✓  (logs: journalctl --user -u fleetview-gate)");
  console.log("[fleetview-gate] to keep it running across logout: loginctl enable-linger $USER");
}
