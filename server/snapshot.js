/**
 * A point-in-time dump of what every pane was doing — the thing you want taken
 * BEFORE the server bounces, not after.
 *
 * Terminal panes are tmux-backed and survive a restart on their own, so their
 * scrollback is only ever a convenience here. Agent panes are the fragile ones:
 * their live driver dies with the process and their on-screen log lives in an
 * in-memory ring buffer (see agent-manager.js), so without a snapshot the only
 * record of the last exchange is the SDK's own transcript file — which is fine
 * for *resuming* but tells you nothing at a glance about which of a dozen boxes
 * was mid-task.
 *
 * Written as both JSON (machine) and Markdown (you, at 2am, wondering what the
 * hell everything was doing). Best-effort throughout: a snapshot must never be
 * the reason a shutdown hangs or a request 500s.
 */
import { writeFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { stripTermQueries } from "./pty-manager.js";

export const SNAPSHOT_DIR = join(homedir(), ".fleetview", "snapshots");

const SCREEN_CHARS = 4000; // tail of a terminal's scrollback to keep
const EVENT_COUNT = 40; // tail of an agent pane's event ring buffer to keep
const KEEP = 20; // snapshots retained on disk before the oldest are dropped

/**
 * Build the snapshot object. Takes the two managers directly rather than the
 * registry façade because it deliberately reaches past `info()` for the two
 * things `info()` doesn't expose: the PTY scrollback and the agent event ring.
 */
export function collectSnapshot(ptys, agents, reason = "manual") {
  const panes = [];

  for (const p of ptys.panes.values()) {
    panes.push({
      id: p.id,
      kind: "pty",
      cwd: p.cwd,
      cmd: p.cmd,
      name: p.name || "",
      session: p.session,
      attention: p.attention,
      working: !!(p.work?.hook || p.work?.out),
      lastInput: p.lastInput || "",
      // Stripped for the same reason the WS replay strips it — raw terminal
      // queries in a saved file are noise at best (see stripTermQueries).
      screen: stripTermQueries(p.buffer || "").slice(-SCREEN_CHARS),
    });
  }

  for (const p of agents.panes.values()) {
    panes.push({
      id: p.id,
      kind: "agent",
      cwd: p.cwd,
      cmd: p.cmd,
      name: p.name || "",
      session: p.session,
      attention: p.attention,
      working: p.status === "working",
      status: p.status,
      mode: p.mode,
      lastInput: p.lastInput || "",
      // The resume handle: with this, the conversation is recoverable even if
      // this snapshot is all you have left.
      sdkSessionId: p.sdkSessionId || null,
      events: (p.events || []).slice(-EVENT_COUNT),
    });
  }

  return { takenAt: new Date().toISOString(), reason, paneCount: panes.length, panes };
}

/** A human-readable digest — one section per pane, newest activity last. */
export function renderSnapshotMarkdown(snap) {
  const lines = [
    `# FleetView snapshot`,
    ``,
    `- **taken:** ${snap.takenAt}`,
    `- **reason:** ${snap.reason}`,
    `- **panes:** ${snap.paneCount}`,
    ``,
  ];

  for (const p of snap.panes) {
    const flags = [
      p.working ? "working" : "idle",
      p.attention?.waiting ? `needs-you(${p.attention.kind})` : null,
    ].filter(Boolean);
    lines.push(`## ${p.name || p.cwd} \`${p.id}\` (${p.kind})`, ``);
    lines.push(`- cwd: \`${p.cwd}\``);
    lines.push(`- cmd: \`${p.cmd}\` — ${flags.join(", ")}`);
    if (p.sdkSessionId) lines.push(`- resume id: \`${p.sdkSessionId}\``);
    if (p.lastInput) lines.push(`- last prompt: ${JSON.stringify(p.lastInput.slice(0, 300))}`);
    lines.push(``);

    if (p.kind === "pty" && p.screen) {
      lines.push("```", p.screen.slice(-1500).trimEnd(), "```", ``);
    } else if (p.kind === "agent" && p.events?.length) {
      lines.push(`Last ${Math.min(p.events.length, 12)} events:`, ``);
      for (const ev of p.events.slice(-12)) {
        const detail = ev.text || ev.name || ev.state || ev.title || "";
        lines.push(`- \`${ev.t}\` ${String(detail).replace(/\s+/g, " ").slice(0, 160)}`);
      }
      lines.push(``);
    }
  }

  return lines.join("\n");
}

/**
 * Write the pair of files and prune old ones. Returns the JSON path.
 * Synchronous on purpose: this is called from process-exit handlers, where an
 * async write would simply never land.
 */
export function saveSnapshot(snap, dir = SNAPSHOT_DIR) {
  mkdirSync(dir, { recursive: true });
  const stamp = snap.takenAt.replace(/[:.]/g, "-");
  const jsonPath = join(dir, `${stamp}.json`);
  writeFileSync(jsonPath, JSON.stringify(snap, null, 2));
  writeFileSync(join(dir, `${stamp}.md`), renderSnapshotMarkdown(snap));

  try {
    const stamps = [...new Set(readdirSync(dir).map((f) => f.replace(/\.(json|md)$/, "")))].sort();
    for (const old of stamps.slice(0, Math.max(0, stamps.length - KEEP))) {
      for (const ext of ["json", "md"]) {
        try {
          unlinkSync(join(dir, `${old}.${ext}`));
        } catch {}
      }
    }
  } catch {}

  return jsonPath;
}
