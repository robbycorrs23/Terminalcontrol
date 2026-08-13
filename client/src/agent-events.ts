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
  | { t: "assistant_done"; id: string; text: string }
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
  | { t: "status"; state: "idle" | "working" | "waiting_permission" | "error"; detail?: string };
