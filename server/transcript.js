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
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
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
    const ts = d.timestamp ? Date.parse(d.timestamp) || undefined : undefined;
    // Mirrors the driver's compact_boundary → { t: "compact" }. On disk the
    // metadata is camelCased; accept either spelling.
    if (d.type === "system" && d.subtype === "compact_boundary") {
      const m = d.compactMetadata || d.compact_metadata || {};
      events.push({ t: "compact", trigger: m.trigger || "auto", preTokens: m.preTokens ?? m.pre_tokens, postTokens: m.postTokens ?? m.post_tokens, ts });
      continue;
    }
    if (d.type === "user" && msg) {
      if (typeof msg.content === "string") {
        if (msg.content.trim()) events.push({ t: "user", id: d.uuid, text: msg.content, ts });
      } else if (Array.isArray(msg.content)) {
        for (const b of msg.content) {
          if (b.type !== "tool_result") continue;
          events.push({
            t: "tool_result",
            id: b.tool_use_id,
            output: stringifyBlockContent(b.content),
            isError: !!b.is_error,
            ts,
          });
        }
      }
    } else if (d.type === "assistant" && msg && Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (b.type === "thinking" && b.thinking) {
          events.push({ t: "thinking", id: `${d.uuid}:th`, text: b.thinking, ts });
        } else if (b.type === "text" && b.text) {
          events.push({ t: "assistant_done", id: d.uuid, text: b.text, ts });
        } else if (b.type === "tool_use") {
          events.push({ t: "tool_call", id: b.id, name: b.name, input: b.input, ts });
        }
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

/**
 * A stable identity for an event across the live stream and the transcript,
 * so the client can say "I have everything from HERE on". Tool ids are the
 * SDK's own (`toolu_…`) and identical in both; text events fall back to
 * their text. Events the transcript never holds (status, mode, permission…)
 * have no key. MIRRORED in client/src/agent-chat.ts's `eventKey`.
 */
export function eventKey(e) {
  if (e.t === "tool_call" || e.t === "tool_result") return `${e.t}:${e.id}`;
  if (e.t === "user") return `user:${e.text}`;
  if (e.t === "assistant_done") return `a:${e.text}`;
  if (e.t === "thinking") return `th:${e.text}`;
  return null;
}

/**
 * The page of history just before what the client already shows (scrolling
 * up past the replay ring's start). `anchors` = keys of the client's oldest
 * events, oldest first. A unique tool key locates the spot exactly (minus how
 * many anchors precede it); text keys are only a fallback, since "yes" can
 * appear many times. Returns `{ events, more }`.
 */
export function olderEvents(configDir, sdkSessionId, anchors, limit = 150) {
  const none = { events: [], more: false };
  const file = findTranscript(configDir, sdkSessionId);
  if (!file || !Array.isArray(anchors) || !anchors.length) return none;
  const all = parsedAll(file);
  const first = new Map();
  all.forEach((e, i) => {
    const k = eventKey(e);
    if (k && !first.has(k)) first.set(k, i);
  });
  let end = -1;
  const toolAt = anchors.findIndex((k) => typeof k === "string" && k.startsWith("tool_") && first.has(k));
  if (toolAt !== -1) end = first.get(anchors[toolAt]) - toolAt;
  else {
    const textAt = anchors.findIndex((k) => first.has(k));
    if (textAt !== -1) end = first.get(anchors[textAt]) - textAt;
  }
  if (end <= 0) return none;
  let start = Math.max(0, end - limit);
  // Don't open the page on a result whose call is just outside it — widen
  // back to the call instead of dropping the result (dropping it lost it for
  // good: the NEXT page ends before it).
  while (start > 0 && all[start].t === "tool_result") start--;
  return { events: all.slice(start, end), more: start > 0 };
}

// Paging re-reads the whole transcript (tens of MB for a long session) once
// per page, so keep the last parse until the file changes.
let cache = null;
function parsedAll(file) {
  let st;
  try {
    st = statSync(file);
  } catch {
    return [];
  }
  if (cache && cache.file === file && cache.size === st.size && cache.mtime === st.mtimeMs) return cache.events;
  const events = eventsFromTranscript(file, Infinity).filter((e) => e.t !== "status");
  cache = { file, size: st.size, mtime: st.mtimeMs, events };
  return events;
}

/** Every event in a transcript (no tail limit), from the same cache history paging uses. */
export function allTranscriptEvents(file) {
  return parsedAll(file);
}
