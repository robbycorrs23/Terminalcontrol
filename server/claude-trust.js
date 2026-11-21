/**
 * Mark a folder as trusted for a Claude Code account, so flipping a chat pane
 * into a terminal doesn't land on the workspace-trust dialog.
 *
 * Why this is needed at all: a chat pane drives the Agent SDK, which never
 * shows the trust dialog, so a folder you have only ever used through FleetView
 * chat is unknown to the interactive CLI. Flip it to a terminal and `claude`
 * stops on "do you trust the files in this folder?" — which reads as the view
 * switch malfunctioning, when it is really the first interactive visit.
 *
 * Why it is defensible to set: the pane being flipped was ALREADY executing in
 * that exact folder, under that exact account, usually in auto mode. The trust
 * decision was effectively made when the pane was opened; this records it where
 * the CLI looks.
 *
 * What it deliberately does NOT do: touch `enabledMcpjsonServers`. A project
 * `.mcp.json` gets its own approval prompt, and auto-approving somebody else's
 * MCP server (arbitrary code, launched on session start) is a security decision
 * that belongs to the user, not to a view toggle.
 *
 * ⚠️ Claude Code owns this file and rewrites it often, so a read-modify-write
 * here races its writes. Three things keep that small: we only write when the
 * flag is actually missing/false (the common case is a no-op), the read→write
 * window is a few milliseconds, and the write is atomic (temp file + rename)
 * so a reader never sees a half-written file. We never create the file, and
 * never touch anything but this one boolean on this one project key.
 */
import { readFileSync, writeFileSync, existsSync, renameSync, unlinkSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** `claude-work` -> ~/.claude-work, `claude` -> ~/.claude. Codex is not handled. */
function configDirFor(profile) {
  const p = String(profile || "");
  if (!p.startsWith("claude")) return null;
  return p.endsWith("-work") ? join(homedir(), ".claude-work") : join(homedir(), ".claude");
}

/**
 * @returns "already" | "trusted" | "skipped" — for logging/telemetry only; the
 * caller must not treat a failure as fatal, since the only cost is that the
 * user sees the dialog they would have seen anyway.
 */
export function trustFolder(profile, cwd) {
  const dir = configDirFor(profile);
  if (!dir || !cwd) return "skipped";
  const file = join(dir, ".claude.json");
  if (!existsSync(file)) return "skipped"; // never conjure Claude's config into being

  let cfg;
  let mode = 0o644;
  try {
    cfg = JSON.parse(readFileSync(file, "utf8"));
    mode = statSync(file).mode & 0o777;
  } catch {
    return "skipped"; // unparseable / unreadable — leave it strictly alone
  }
  if (!cfg || typeof cfg !== "object") return "skipped";

  const projects = cfg.projects && typeof cfg.projects === "object" ? cfg.projects : null;
  if (!projects) return "skipped";

  const entry = projects[cwd];
  if (entry && entry.hasTrustDialogAccepted === true) return "already";

  // Match the shape Claude Code writes for a fresh project, so we never hand it
  // a half-formed entry it then has to repair.
  projects[cwd] = {
    mcpContextUris: [],
    mcpServers: {},
    enabledMcpjsonServers: [],
    disabledMcpjsonServers: [],
    ...(entry || {}),
    hasTrustDialogAccepted: true,
  };

  const tmp = file + ".fleetview.tmp";
  try {
    writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode });
    renameSync(tmp, file); // atomic within the same directory
    return "trusted";
  } catch {
    try {
      unlinkSync(tmp);
    } catch {}
    return "skipped";
  }
}
