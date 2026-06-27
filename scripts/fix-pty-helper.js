// node-pty ships a prebuilt `spawn-helper` binary that MUST be executable, but in
// some npm installs its post-install step doesn't set the exec bit, and every
// pty.spawn() then fails with "posix_spawnp failed" (permission denied).
// This runs as our postinstall to guarantee the bit is set on every install.
import { chmodSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const base = join(here, "..", "node_modules", "node-pty", "prebuilds");

// Only unix prebuilds have a spawn-helper; harmless if a path is absent.
const candidates = [
  join(base, "darwin-arm64", "spawn-helper"),
  join(base, "darwin-x64", "spawn-helper"),
  join(base, "linux-x64", "spawn-helper"),
  join(base, "linux-arm64", "spawn-helper"),
];

for (const p of candidates) {
  if (existsSync(p)) {
    try {
      chmodSync(p, 0o755);
      console.log("[fleetview] ensured executable:", p.replace(base + "/", ""));
    } catch (e) {
      console.warn("[fleetview] could not chmod", p, e.message);
    }
  }
}
