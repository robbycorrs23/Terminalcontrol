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
 *   | { t: "thinking_delta", id: string, delta: string }
 *   | { t: "thinking", id: string, text: string }
 *   | { t: "tool_call", id: string, name: string, input: unknown, parent?: string }
 *   | { t: "tool_result", id: string, output: string, isError: boolean, diff?: string, parent?: string }
 *   | { t: "tool_progress", id: string, seconds: number }
 *   | { t: "permission_request", requestId: string, tool: string, input: unknown, title?: string, description?: string, toolUseId?: string, canAlways?: boolean, blockedPath?: string }
 *   | { t: "permission_resolved", requestId: string, decision: "allow"|"deny"|"always", message?: string }
 *   | { t: "question", requestId: string, questions: AgentQuestion[] }
 *   | { t: "question_resolved", requestId: string, answers: Record<string,string> }
 *   | { t: "status", state: "idle"|"working"|"waiting_permission"|"error"|"aborted", detail?: string, durationMs?: number }
 *   | { t: "mode", mode: "default"|"acceptEdits"|"auto"|"plan"|"bypassPermissions" }
 *   | { t: "commands", commands: { name: string, description: string, argumentHint: string }[] }
 *   | { t: "models", models: { value: string, label: string, description: string, resolved?: string }[] }
 *   | { t: "suggestion", text: string }
 *   | { t: "retry", attempt: number, max: number, delayMs: number, status: number|null }
 *   | { t: "compact", trigger: "auto"|"manual", preTokens?: number, postTokens?: number }
 *   | { t: "context", percent: number, used: number, max: number }
 *   | { t: "task", task: { id: string, description: string, status: string, backgrounded?: boolean, toolUseId?: string, kind?: string, lastTool?: string, summary?: string, toolUses?: number, durationMs?: number } }
 * } AgentEvent
 *
 * Every event also carries `ts` (ms epoch), stamped by agent-manager.js.
 * `*_delta`, `tool_progress`, `commands`, `models` and `suggestion` are
 * LIVE-ONLY (never in the replay ring) — see LIVE_ONLY in agent-manager.js.
 * `parent` on tool events = the Task/Agent call a subagent made them under.
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
