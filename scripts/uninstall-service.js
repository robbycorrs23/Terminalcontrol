// Remove the FleetView auto-start service. Idempotent: succeeds (exit 0) whether or
// not it was installed. Does NOT stop a server you started by hand with `npm start`.

import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const HOME = homedir();

if (process.platform === "darwin") uninstallMac();
else if (process.platform === "linux") uninstallLinux();
else {
  console.log("auto-start not supported on this platform — nothing to remove.");
  process.exit(0);
}

function uninstallMac() {
  const plistPath = join(HOME, "Library", "LaunchAgents", "com.fleetview.server.plist");
  // unload first (ignore errors if not loaded), then remove the plist.
  spawnSync("launchctl", ["unload", plistPath], { stdio: "ignore" });
  spawnSync("launchctl", ["remove", "com.fleetview.server"], { stdio: "ignore" }); // belt + suspenders
  if (existsSync(plistPath)) {
    rmSync(plistPath, { force: true });
    console.log(`[fleetview] removed ${plistPath}`);
  } else {
    console.log("[fleetview] no launchd agent installed — nothing to remove.");
  }
  console.log("[fleetview] auto-start disabled. (Any server started by hand is still running.)");
}

function uninstallLinux() {
  const unitPath = join(HOME, ".config", "systemd", "user", "fleetview.service");
  spawnSync("systemctl", ["--user", "disable", "--now", "fleetview.service"], { stdio: "ignore" });
  if (existsSync(unitPath)) {
    rmSync(unitPath, { force: true });
    console.log(`[fleetview] removed ${unitPath}`);
  } else {
    console.log("[fleetview] no systemd unit installed — nothing to remove.");
  }
  spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
  console.log("[fleetview] auto-start disabled. (Any server started by hand is still running.)");
}
