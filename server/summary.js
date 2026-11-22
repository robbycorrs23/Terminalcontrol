import { basename, relative, isAbsolute } from "node:path";
import { statSync } from "node:fs";
import { findTranscript, allTranscriptEvents } from "./transcript.js";
import { oneShot } from "./auto-title.js";

/**
 * Session summaries: when a turn ends, a short digest of what it did —
 *   { headline, changed: [files], needsYou: string|null, at }
 * shown in the "finished" notification (push-notifier.js) and on the inbox's
 * Finished cards (inbox.ts), so you can tell whether to open a session without
 * opening it.
 *
 * Built from the session's own transcript — works for chat AND terminal panes
 * (a terminal claude reports its session id through the Stop hook) — scoped to
 * the LAST turn: everything after the last user message. One Haiku call
 * (oneShot: no tools, no settings, no saved session) turns the request, the
 * files it edited and its final reply into a headline + an optional "needs
 * you"; a plain-text heuristic stands in if that fails or is slow.
 *
 * One summary per turn, shared: the notifier and the inbox both ask, and get
 * the same cached promise. Keyed on the transcript's size+mtime, so a new turn
 * is a new summary and a re-ask for the same turn is free.
 */

const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

/** The last turn of a transcript: request, files edited, commands run, final reply. */
export function lastTurn(events, cwd = "") {
  let start = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].t === "user" && String(events[i].text || "").trim()) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;
  const turn = events.slice(start + 1);
  const files = [];
  let commands = 0;
  let reply = "";
  for (const e of turn) {
    if (e.t === "tool_call" && EDIT_TOOLS.has(e.name)) {
      const p = e.input?.file_path || e.input?.notebook_path;
      if (typeof p === "string") {
        const rel = cwd && isAbsolute(p) ? relative(cwd, p) : p;
        const name = rel && !rel.startsWith("..") ? rel : basename(p);
        if (!files.includes(name)) files.push(name);
      }
    } else if (e.t === "tool_call" && e.name === "Bash") commands++;
    else if (e.t === "assistant_done" && String(e.text || "").trim()) reply = String(e.text);
  }
  return { request: String(events[start].text || ""), files, commands, reply };
}

/** No model: the reply's first sentence; a closing question becomes "needs you". */
export function heuristic(turn) {
  const text = turn.reply.replace(/```[\s\S]*?```/g, " ").replace(/[#*_`>|]/g, "").replace(/\s+/g, " ").trim();
  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  let headline = sentences[0] || (turn.files.length ? `Edited ${turn.files.length} file${turn.files.length === 1 ? "" : "s"}` : "Finished");
  if (headline.length > 90) headline = headline.slice(0, 89).replace(/\s+\S*$/, "") + "…";
  const last = sentences[sentences.length - 1] || "";
  const needsYou = sentences.length > 1 && /\?$/.test(last) ? (last.length > 90 ? last.slice(0, 89) + "…" : last) : null;
  return { headline, needsYou };
}

function parseModel(text) {
  const m = /\{[\s\S]*\}/.exec(text || "");
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    const clip = (s) => (typeof s === "string" && s.trim() ? s.trim().replace(/\s+/g, " ").slice(0, 110) : null);
    const headline = clip(j.headline);
    if (!headline) return null;
    const needs = clip(j.needsYou);
    return { headline, needsYou: needs && !/^(null|none|no)$/i.test(needs) ? needs : null };
  } catch {
    return null;
  }
}

/**
 * @param {{ ctxOf: (paneId: string) => ({cwd: string, configDir: string, sdkSessionId: string|null, env?: object, remote?: boolean} | null),
 *           fallbackReply?: (paneId: string) => string }} deps
 */
export function createSummaries({ ctxOf, fallbackReply = () => "" }) {
  const byPane = new Map(); // paneId -> { key, promise, value }

  async function build(ctx, file, paneId) {
    let turn = lastTurn(allTranscriptEvents(file), ctx.cwd);
    // The final reply can land on disk a beat after the turn-end signal.
    if (turn && !turn.reply) {
      await new Promise((r) => setTimeout(r, 1200));
      turn = lastTurn(allTranscriptEvents(file), ctx.cwd) || turn;
    }
    if (!turn) return null;
    if (!turn.reply) turn.reply = fallbackReply(paneId) || "";
    const base = { changed: turn.files.slice(0, 12), at: Date.now() };
    const text = await oneShot(
      'You summarize what a coding agent just did in ONE turn, for a phone notification. Reply with JSON only: {"headline": "...", "needsYou": "..." or null}. headline: past tense, at most 80 characters, specific (what changed or what was found), no preamble, no quotes. needsYou: ONLY if the final message asks the user a question or needs a decision/action from them, say what in at most 80 characters; otherwise null.',
      `The user's request:\n${turn.request.slice(0, 1500)}\n\nFiles edited: ${turn.files.join(", ") || "none"}\nShell commands run: ${turn.commands}\n\nThe agent's final message:\n${turn.reply.slice(-3000)}`,
      { env: ctx.env, cwd: ctx.cwd, timeoutMs: 15000 }
    );
    return { ...base, ...(parseModel(text) || heuristic(turn)) };
  }

  /** The summary of the pane's latest turn (cached per turn). Null when there's nothing to summarize. */
  function summarize(paneId) {
    const ctx = ctxOf(paneId);
    if (!ctx || ctx.remote || !ctx.sdkSessionId) return Promise.resolve(null);
    const file = findTranscript(ctx.configDir, ctx.sdkSessionId);
    if (!file) return Promise.resolve(null);
    let key;
    try {
      const st = statSync(file);
      key = `${file}:${st.size}:${st.mtimeMs}`;
    } catch {
      return Promise.resolve(null);
    }
    const cur = byPane.get(paneId);
    if (cur && cur.key === key) return cur.promise;
    const entry = { key, value: null, promise: null };
    entry.promise = build(ctx, file, paneId)
      .then((v) => (entry.value = v))
      .catch(() => null);
    byPane.set(paneId, entry);
    return entry.promise;
  }

  /**
   * Make sure the latest turn is being summarized, and call `onReady` once when
   * a NEW summary lands. Unlike summarize() it never re-fires for a turn it has
   * already tried — the inbox calls it on every listing, and a null result
   * must not turn into a refresh loop.
   */
  function ensure(paneId, onReady) {
    const before = byPane.get(paneId);
    const p = summarize(paneId);
    const after = byPane.get(paneId);
    if (after && after !== before) p.then((v) => v && onReady?.(paneId, v));
  }

  /** Whatever's already known — never triggers work (for the inbox listing). */
  function peek(paneId) {
    return byPane.get(paneId)?.value || null;
  }

  function forget(paneId) {
    byPane.delete(paneId);
  }

  return { summarize, ensure, peek, forget };
}
