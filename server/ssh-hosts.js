import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

/** True for a Host pattern that's a wildcard/negation, not a literal alias
 * you'd pick from a list (e.g. "Host *" catch-all defaults blocks). */
function isWildcardPattern(tok) {
  return !tok || tok.includes("*") || tok.includes("?") || tok.startsWith("!");
}

/**
 * Read-only discovery of the user's own ~/.ssh/config. FleetView never writes
 * here — this only surfaces what's already there so it can be offered
 * alongside FleetView-managed profiles in the picker. Parses the main file
 * only (no `Include` recursion, deliberately, to keep this a small trusted
 * read rather than an ssh_config re-implementation); each `Host` block's
 * non-wildcard patterns become one discoverable alias, carrying along
 * whatever HostName/User/Port were set for that block (informational only —
 * connecting is just `ssh <alias>`, letting ssh itself apply the real config).
 */
export function listSshConfigHosts(configPath = join(os.homedir(), ".ssh", "config")) {
  if (!existsSync(configPath)) return [];
  let text;
  try {
    text = readFileSync(configPath, "utf8");
  } catch {
    return [];
  }

  const hosts = [];
  let current = null; // { aliases: string[], hostName, user, port }

  const flush = () => {
    if (!current) return;
    for (const alias of current.aliases) {
      hosts.push({
        alias,
        hostName: current.hostName || alias,
        user: current.user || "",
        port: current.port || 22,
      });
    }
    current = null;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    // "Key value..." — ssh_config also allows "Key=value"; normalize both.
    const m = line.match(/^([A-Za-z][A-Za-z0-9]*)\s*[= ]\s*(.+)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const rest = m[2].trim();

    if (key === "host") {
      flush();
      const aliases = rest.split(/\s+/).filter((t) => !isWildcardPattern(t));
      current = aliases.length ? { aliases, hostName: "", user: "", port: 0 } : null;
      continue;
    }
    if (!current) continue; // inside a wildcard-only / Match block we don't surface
    if (key === "hostname") current.hostName = rest.replace(/^["']|["']$/g, "");
    else if (key === "user") current.user = rest.replace(/^["']|["']$/g, "");
    else if (key === "port") current.port = parseInt(rest, 10) || 22;
  }
  flush();

  return hosts;
}
