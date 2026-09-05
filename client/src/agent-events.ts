/**
 * Mirrors server/agents/event-schema.js by hand — the same convention
 * PaneInfo already uses between server and client with no codegen. Every
 * agent driver (claude-driver.js today, codex-driver.js later) maps its
 * provider-specific messages into this shape, so agent-chat.ts never needs
 * to know which provider is behind a given pane.
 */
export type AgentEvent =
  | { t: "user"; id: string; text: string }
  | { t: "assistant_delta"; id: string; delta: string }
  | { t: "assistant_done"; id: string; text: string; aborted?: boolean }
  | { t: "tool_call"; id: string; name: string; input: unknown }
  | { t: "tool_result"; id: string; output: string; isError: boolean; diff?: string }
  | {
      t: "permission_request";
      requestId: string;
      tool: string;
      input: unknown;
      title?: string;
      description?: string;
    }
  | { t: "permission_resolved"; requestId: string; decision: "allow" | "deny" | "always" }
  | { t: "question"; requestId: string; questions: AgentQuestion[] }
  | { t: "question_resolved"; requestId: string; answers: Record<string, string> }
  | {
      t: "status";
      state: "idle" | "working" | "waiting_permission" | "error" | "aborted";
      detail?: string;
    }
  | { t: "mode"; mode: "default" | "acceptEdits" | "auto" | "plan" | "bypassPermissions" };

// `assistant_done.aborted` (claude only — codex's protocol has no per-message
// truncation signal) and `status.state === "aborted"` (both providers) both
// mean the turn was cut off before a natural stop (interrupt, restart, rate
// limit, API error), not that the model actually finished. Kept distinct
// from `"error"`: not necessarily a failure to fix, just an incomplete turn
// the user should know is incomplete — see claude-driver.js/codex-driver.js.

/** One question in an AskUserQuestion tool call — see the `question` AgentEvent. */
export type AgentQuestion = {
  question: string;
  header: string;
  multiSelect: boolean;
  options: { label: string; description?: string }[];
};
