/**
 * The normalized event shape every agent driver (claude-driver.js, and
 * eventually codex-driver.js) maps its provider-specific messages into. The
 * client (client/src/agent-events.ts mirrors this by hand, same convention
 * PaneInfo already uses between server/client with no codegen) never sees
 * provider-specific shapes — this is what makes a second driver a
 * server-only change with zero client work.
 *
 * @typedef {
 *   | { t: "user", id: string, text: string }
 *   | { t: "assistant_delta", id: string, delta: string }
 *   | { t: "assistant_done", id: string, text: string }
 *   | { t: "tool_call", id: string, name: string, input: unknown }
 *   | { t: "tool_result", id: string, output: string, isError: boolean, diff?: string }
 *   | { t: "permission_request", requestId: string, tool: string, input: unknown, title?: string, description?: string }
 *   | { t: "permission_resolved", requestId: string, decision: "allow"|"deny"|"always" }
 *   | { t: "status", state: "idle"|"working"|"waiting_permission"|"error", detail?: string }
 * } AgentEvent
 */
export {};
