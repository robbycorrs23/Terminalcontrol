import { query } from "@anthropic-ai/claude-agent-sdk";

/**
 * Short session titles ("Fix push notifications") instead of folder names,
 * the way the Claude app names conversations.
 *
 * One tiny, isolated model call per session: Haiku, one turn, no tools, no
 * settings/hooks loaded (`settingSources: []`), and `persistSession: false`
 * so it never shows up as a junk conversation in Claude Code's history. If
 * that fails for any reason (no login, offline, rate limit) a plain-text
 * fallback built from the prompt itself is used instead — a title is a
 * nicety, never worth an error.
 */

const SYSTEM =
  "You write titles for coding-assistant conversations. Reply with ONLY a 2-6 word title in sentence case " +
  "describing the task — no quotes, no trailing punctuation, no preamble.";

/** Free fallback: the prompt's first clause, minus conversational filler, capped at 6 words. */
export function heuristicTitle(text) {
  let t = String(text || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\S+\.(png|jpe?g|gif|webp|heic)\b/gi, " ") // attached image paths
    .replace(/https?:\/\/\S+/g, " ")
    .split(/[\n.?!]/)
    .map((s) => s.trim())
    .find((s) => s.split(/\s+/).length >= 2) || "";
  t = t
    .replace(/^(hey|hi|ok(ay)?|so|please|pls|yo)[,\s]+/i, "")
    .replace(/^(can|could|would|will) (you|we) (please )?/i, "")
    .replace(/^(i (want|need|would like) (you )?to|let'?s|help me( to)?|i'?d like (you )?to)\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
  const words = t.split(" ").filter(Boolean).slice(0, 6);
  if (!words.length) return "";
  const s = words.join(" ").replace(/[,:;]+$/, "");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function clean(raw) {
  return String(raw || "")
    .split("\n")[0]
    .replace(/^["'`*#\s]+|["'`*.\s]+$/g, "")
    .replace(/^title:\s*/i, "")
    .slice(0, 60)
    .trim();
}

/**
 * One isolated Haiku turn — no tools, no settings/hooks (`settingSources: []`),
 * nothing saved to Claude Code's history (`persistSession: false`). Shared by
 * session titles and the Changes panel's commit/PR drafts (ship.js). Returns
 * "" on any failure; callers always have a fallback.
 */
export async function oneShot(system, prompt, { env, cwd, timeoutMs = 20000 } = {}) {
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), timeoutMs);
  try {
    const q = query({
      prompt,
      options: {
        model: "haiku",
        systemPrompt: system,
        maxTurns: 1,
        tools: [],
        settingSources: [],
        persistSession: false,
        abortController,
        ...(cwd ? { cwd } : {}),
        ...(env ? { env } : {}),
      },
    });
    let text = "";
    for await (const msg of q) {
      if (msg.type === "assistant") {
        for (const b of msg.message?.content || []) if (b.type === "text") text += b.text;
      } else if (msg.type === "result") break;
    }
    return text.trim();
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {string} prompt the session's first real message
 * @param {{ env?: Record<string,string|undefined>, cwd?: string, timeoutMs?: number }} opts
 * @returns {Promise<string>} a title ("" only if even the fallback has nothing)
 */
export async function generateTitle(prompt, { env, cwd, timeoutMs = 20000 } = {}) {
  const fallback = heuristicTitle(prompt);
  const title = clean(await oneShot(SYSTEM, `Title this request:\n\n${String(prompt).slice(0, 2000)}`, { env, cwd, timeoutMs }));
  return title && title.split(/\s+/).length <= 10 ? title : fallback;
}
