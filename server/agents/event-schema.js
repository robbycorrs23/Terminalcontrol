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
 *   | { t: "assistant_done", id: string, text: string, aborted?: boolean }
 *   | { t: "tool_call", id: string, name: string, input: unknown }
 *   | { t: "tool_result", id: string, output: string, isError: boolean, diff?: string }
 *   | { t: "permission_request", requestId: string, tool: string, input: unknown, title?: string, description?: string }
 *   | { t: "permission_resolved", requestId: string, decision: "allow"|"deny"|"always" }
 *   | { t: "question", requestId: string, questions: AgentQuestion[] }
 *   | { t: "question_resolved", requestId: string, answers: Record<string,string> }
 *   | { t: "status", state: "idle"|"working"|"waiting_permission"|"error"|"aborted", detail?: string }
 *   | { t: "mode", mode: "default"|"acceptEdits"|"auto"|"plan"|"bypassPermissions" }
 * } AgentEvent
 *
 * `assistant_done.aborted` (claude only — codex's protocol exposes no
 * per-message truncation signal) and `status.state === "aborted"` (both
 * providers) both mean the SAME underlying thing: the turn was cut off
 * before a natural stop (interrupt, restart, rate limit, API error) rather
 * than the model actually finishing — see claude-driver.js/codex-driver.js.
 * Kept distinct from `"error"`: an aborted turn isn't necessarily a failure
 * the user needs to fix, just an incomplete one they should know is
 * incomplete.
 *
 * `question` is the interactive AskUserQuestion tool surfaced for a human to
 * answer (see claude-driver.js) — distinct from `permission_request`, which
 * only gates whether a tool may run. Answering it flows back the other way as
 * a `{ t: "answer", requestId, answers }` client→driver message.
 *
 * @typedef {{
 *   question: string,
 *   header: string,
 *   multiSelect: boolean,
 *   options: { label: string, description?: string }[]
 * }} AgentQuestion
 */
export {};
