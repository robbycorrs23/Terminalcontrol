/**
 * Rebuilds an agent pane's on-screen log from the SDK's own transcript file.
 *
 * An agent pane's conversation is already durable — `sdkSessionId` is persisted
 * and `_ensureDriver` resumes from it, so the *model* remembers everything after
 * a restart. What did not survive is `pane.events`, the in-memory ring buffer
 * the client replays into the chat log, so the box came back blank and you had
 * no way to see what it had been doing. The transcript on disk holds exactly
 * that history; this module translates it back into AgentEvents.
 *
 * The mapping mirrors claude-driver.js's `handleMessage` deliberately and
 * exactly — same event names, same id fields — so a replayed conversation is
 * indistinguishable from one that streamed live. Anything the driver drops
 * (thinking blocks, its own prompt echoes) is dropped here too.
 *
 * Claude only: codex stores threads in a different layout (`~/.codex/sessions`
 * plus an index), and guessing at it is a bigger job than it's worth here — a
 * codex pane simply comes back with an empty log, exactly as before.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Mirrors claude-driver.js's stringifyBlockContent — tool output as flat text. */
function stringifyBlockContent(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
  }
  return String(content);
}

/**
 * Locate `<sid>.jsonl` under a config dir's projects tree. The per-project
 * folder name is a mangled cwd, and a session can legitimately live under a
 * folder that no longer matches the pane's current cwd (renamed/moved repo),
 * so scan rather than compute the name — the same approach, for the same
 * reason, as agent-manager.js's `_resumableSessionId`.
 */
export function findTranscript(configDir, sdkSessionId) {
  if (!configDir || !sdkSessionId) return null;
  const projects = join(configDir, "projects");
  try {
    for (const proj of readdirSync(projects)) {
      const p = join(projects, proj, `${sdkSessionId}.jsonl`);
      if (existsSync(p)) return p;
    }
  } catch {}
  return null;
}

/**
 * Parse a transcript into AgentEvents, newest last.
 *
 * `limit` caps the returned events so a long conversation can't blow past the
 * server's ring buffer (which would silently `shift()` the oldest away and
 * orphan tool results whose calls fell off the front). We slice to the tail and
 * then drop any tool_result left without its tool_call inside that window,
 * because the client renders an unmatched result as a bare "tool result" card.
 */
export function eventsFromTranscript(file, limit = 250) {
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }

  const events = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      continue; // a torn last line while the SDK is mid-write
    }
    // Sub-agent (Task tool) conversations live in the same file flagged as
    // sidechains. They never reached the pane's live log, so they don't belong
    // in its replay either.
    if (d.isSidechain) continue;

    const msg = d.message;
    if (d.type === "user" && msg) {
      if (typeof msg.content === "string") {
        if (msg.content.trim()) events.push({ t: "user", id: d.uuid, text: msg.content });
      } else if (Array.isArray(msg.content)) {
        for (const b of msg.content) {
          if (b.type !== "tool_result") continue;
          events.push({
            t: "tool_result",
            id: b.tool_use_id,
            output: stringifyBlockContent(b.content),
            isError: !!b.is_error,
          });
        }
      }
    } else if (d.type === "assistant" && msg && Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (b.type === "text" && b.text) {
          events.push({ t: "assistant_done", id: d.uuid, text: b.text });
        } else if (b.type === "tool_use") {
          events.push({ t: "tool_call", id: b.id, name: b.name, input: b.input });
        }
        // `thinking` blocks are dropped, matching the live driver.
      }
    }
  }

  const tail = events.slice(-limit);
  const calls = new Set(tail.filter((e) => e.t === "tool_call").map((e) => e.id));
  const clean = tail.filter((e) => e.t !== "tool_result" || calls.has(e.id));

  // The transcript ends wherever the last turn ended; without this the chat
  // would come back still showing "● Working…" from a mid-turn status.
  if (clean.length) clean.push({ t: "status", state: "idle" });
  return clean;
}

/** Convenience: locate + parse in one step. Returns [] when there's nothing to restore. */
export function restoreEvents(configDir, sdkSessionId, limit) {
  const file = findTranscript(configDir, sdkSessionId);
  return file ? eventsFromTranscript(file, limit) : [];
}
