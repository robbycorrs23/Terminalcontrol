#!/usr/bin/env node
/**
 * Capture what every pane is doing, right now, WITHOUT touching the server.
 *
 * Deliberately external: it talks to the running server over its existing REST
 * API and otherwise reads the same on-disk sources the server would. That
 * matters because the moment you most want a snapshot is right before a
 * restart — and a snapshot you can only take by first restarting to install
 * the endpoint is worthless. It also means this works against a server running
 * older code, or (for the on-disk half) against no server at all.
 *
 * Sources, per pane kind:
 *   pty   — `tmux capture-pane` against the pane's session on the stable socket
 *   agent — sdkSessionId from agent-sessions.json → the SDK transcript on disk
 *
 * Usage:  npm run snapshot            (writes to ~/.fleetview/snapshots/)
 *         npm run snapshot -- --print (also dumps the Markdown to stdout)
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { renderSnapshotMarkdown, saveSnapshot, SNAPSHOT_DIR } from "../server/snapshot.js";
import { restoreEvents } from "../server/transcript.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = process.env.FLEET_PORT || 4280;
const SOCK = join(homedir(), ".fleetview", `tmux-${PORT}.sock`);
const SCROLLBACK_LINES = 200;

/** Mirrors agent-manager.js's accountConfigDirFor — "-work" panes use a separate account. */
const configDirFor = (cmd, provider = "claude") =>
  String(cmd || "").endsWith("-work") ? join(homedir(), `.${provider}-work`) : join(homedir(), `.${provider}`);

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

/** The pane's visible screen, straight from tmux — works even if the server is down. */
function capturePane(id) {
  if (!existsSync(SOCK)) return "";
  const r = spawnSync("tmux", ["-S", SOCK, "capture-pane", "-p", "-S", `-${SCROLLBACK_LINES}`, "-t", `fleet_${id}`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return r.status === 0 ? (r.stdout || "").trimEnd() : "";
}

const panes = await fetch(`http://localhost:${PORT}/api/panes`)
  .then((r) => r.json())
  .catch(() => {
    console.error(
      `[snapshot] no server on :${PORT} — falling back to on-disk state only ` +
        `(terminal scrollback will still be captured from tmux).`
    );
    return null;
  });

// Without a server, reconstruct the pane list from the two state files it owns.
const live =
  panes ??
  [
    ...readJson(join(ROOT, "sessions.json"), []).map((p) => ({ ...p, kind: "pty" })),
    ...readJson(join(ROOT, "agent-sessions.json"), []).map((p) => ({ ...p, kind: "agent" })),
  ];

const agentState = readJson(join(ROOT, "agent-sessions.json"), []);
const bySdkId = new Map(agentState.map((p) => [p.id, p]));

const out = [];
for (const p of live) {
  const base = {
    id: p.id,
    kind: p.kind,
    cwd: p.cwd,
    cmd: p.cmd,
    name: p.name || "",
    session: p.session ?? null,
    attention: p.attention ?? { waiting: false, kind: null },
    working: !!p.working,
    lastInput: p.lastInput || "",
  };

  if (p.kind === "agent") {
    const rec = bySdkId.get(p.id) || {};
    const sdkSessionId = rec.sdkSessionId || null;
    const events = sdkSessionId
      ? restoreEvents(configDirFor(p.cmd, rec.provider || "claude"), sdkSessionId, 60)
      : [];
    out.push({ ...base, mode: p.mode || rec.mode, sdkSessionId, events });
  } else {
    out.push({ ...base, screen: capturePane(p.id) });
  }
}

const snap = {
  takenAt: new Date().toISOString(),
  reason: process.argv.includes("--reason") ? process.argv[process.argv.indexOf("--reason") + 1] : "manual",
  paneCount: out.length,
  panes: out,
};

const path = saveSnapshot(snap);
if (process.argv.includes("--print")) console.log(renderSnapshotMarkdown(snap));

const agents = out.filter((p) => p.kind === "agent");
const restorable = agents.filter((p) => p.events.length).length;
console.log(
  `[snapshot] ${snap.paneCount} panes captured → ${path}\n` +
    `           ${out.length - agents.length} terminal(s) via tmux, ` +
    `${restorable}/${agents.length} agent chat(s) with recoverable history.\n` +
    `           Snapshots live in ${SNAPSHOT_DIR} (last 20 kept).`
);
