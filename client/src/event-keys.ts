import type { AgentEvent } from "./agent-events";

/**
 * Identity of an event shared by the live stream and the on-disk transcript —
 * how "load earlier" tells the server where this log begins. MIRRORS
 * server/transcript.js's `eventKey`.
 */
export function eventKey(e: AgentEvent): string | null {
  if (e.t === "tool_call" || e.t === "tool_result") return `${e.t}:${e.id}`;
  if (e.t === "user") return `user:${e.text}`;
  if (e.t === "assistant_done") return `a:${e.text}`;
  if (e.t === "thinking") return `th:${e.text}`;
  return null;
}
export function headKeysOf(events: AgentEvent[], n = 40): string[] {
  const out: string[] = [];
  for (const e of events) {
    const k = eventKey(e);
    if (k) out.push(k);
    if (out.length >= n) break;
  }
  return out;
}
