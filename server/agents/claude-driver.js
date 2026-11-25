import { randomUUID } from "node:crypto";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { spawnOverSsh } from "../ssh-remote-agent.js";

/**
 * A minimal push-based async iterable — feeds `query()`'s streaming `prompt`
 * input. Never signals `done`; the caller controls the session's lifetime via
 * `options.abortController` instead (see `startClaudeSession`'s `dispose`).
 */
class PushQueue {
  #items = [];
  #waiters = [];
  push(item) {
    const waiter = this.#waiters.shift();
    if (waiter) waiter(item);
    else this.#items.push(item);
  }
  next() {
    if (this.#items.length) return Promise.resolve({ value: this.#items.shift(), done: false });
    return new Promise((resolve) => this.#waiters.push((v) => resolve({ value: v, done: false })));
  }
  [Symbol.asyncIterator]() {
    return { next: () => this.next() };
  }
}

/** `{type:'text',text} | {type:'tool_result',...}` content → a flat string for the chat UI. */
function stringifyBlockContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c) => (c && c.type === "text" ? c.text : `[${c?.type || "content"}]`)).join("\n");
  }
  return content == null ? "" : String(content);
}

/**
 * Wraps one `query()` call (which spawns the real `claude` CLI as a
 * subprocess and talks to it over stdio — see the plan) as a long-lived
 * session: push user messages in via `send()`, get normalized `AgentEvent`s
 * out via `onEvent`, resolve permission prompts via `approve()`.
 *
 * @param {{
 *   cwd: string,
 *   resume?: string,
 *   env?: Record<string,string|undefined>,
 *   mode?: "default"|"acceptEdits"|"auto"|"plan"|"bypassPermissions",
 *   remote?: { target: string, port?: number, identityFile?: string, envPrefix?: string },
 *   onEvent: (ev: import("./event-schema.js").AgentEvent) => void,
 *   onSessionId: (id: string) => void,
 *   onModel?: (model: string) => void,
 * }} opts
 */
export function startClaudeSession({ cwd, resume, resumeAt, env, mode, remote, chrome, onEvent, onSessionId, onModel, onRateLimit }) {
  const promptQueue = new PushQueue();
  const pendingPermissions = new Map(); // requestId -> (decision: "allow"|"deny"|"always", message?: string) => void
  const pendingQuestions = new Map(); // requestId -> (answers|null) => void
  const abortController = new AbortController();
  let disposed = false;

  /** @type {import("@anthropic-ai/claude-agent-sdk").CanUseTool} */
  const canUseTool = (toolName, input, opts) => {
    // AskUserQuestion is not a real permission gate — it's an interactive
    // prompt. The tool's own implementation echoes an `answers` map straight
    // from its input (verified against the CLI binary: `call(e){let{answers}=e
    // ...return {data:{answers}}}`), which the interactive CLI injects after
    // the user picks. Headless there's no picker, so `answers` stays empty and
    // the model reads it as "no answer". We do the injecting ourselves:
    // surface the questions, collect the choices, and allow the tool with an
    // `updatedInput` carrying `answers` — the SDK's documented input-override.
    if (toolName === "AskUserQuestion" && Array.isArray(input?.questions)) {
      onEvent({
        t: "question",
        requestId: opts.requestId,
        questions: input.questions.map((q) => ({
          question: q.question,
          header: q.header,
          multiSelect: q.multiSelect === true,
          options: (q.options || []).map((o) => ({ label: o.label, description: o.description })),
        })),
      });
      onEvent({ t: "status", state: "waiting_permission" });
      return new Promise((resolve) => {
        pendingQuestions.set(opts.requestId, (answers) => {
          if (!answers) {
            // Dismissed (pane disposed / interrupted) — let the model move on
            // rather than hang the turn on a prompt no one will answer.
            resolve({ behavior: "deny", message: "The user dismissed the question without answering." });
          } else {
            resolve({ behavior: "allow", updatedInput: { ...input, answers } });
          }
        });
      });
    }

    onEvent({
      t: "permission_request",
      requestId: opts.requestId,
      tool: toolName,
      input,
      title: opts.title,
      description: opts.description,
      // Ties the prompt to its tool row, so the client can mark that row
      // instead of guessing. `canAlways` = the SDK offered a rule to persist;
      // without one "don't ask again" would silently behave like plain Allow,
      // so the client only offers that option when this is true.
      toolUseId: opts.toolUseID,
      canAlways: !!opts.suggestions?.length && !opts.suppressAlwaysAllowRule,
      ...(opts.blockedPath ? { blockedPath: opts.blockedPath } : {}),
    });
    onEvent({ t: "status", state: "waiting_permission" });
    return new Promise((resolve) => {
      pendingPermissions.set(opts.requestId, (decision, message) => {
        if (decision === "deny") {
          // The CLI's "No, and tell Claude what to do differently": the typed
          // text goes back as the denial reason, so the model can change
          // course in the same turn instead of just stopping.
          const why = typeof message === "string" && message.trim() ? message.trim() : "";
          resolve({
            behavior: "deny",
            message: why ? `The user denied this tool call and said: ${why}` : "Denied by user",
          });
        } else if (decision === "always" && opts.suggestions?.length) {
          // "Always allow" persists via the SDK's own suggested permission-rule
          // update (session-scoped) — we don't invent our own always-allow list.
          resolve({ behavior: "allow", updatedPermissions: opts.suggestions });
        } else {
          resolve({ behavior: "allow" });
        }
      });
    });
  };

  const q = query({
    prompt: promptQueue,
    options: {
      cwd,
      resume,
      // Rewind (agent-manager.js rewind()): restart the conversation at an
      // earlier point as a FORK — a new session id, the original transcript
      // left untouched, so the rewind itself can be undone. `dropsTurn` arms
      // the CLI's guard when exactly one turn is being discarded.
      ...(resume && resumeAt?.at
        ? {
            resumeSessionAt: resumeAt.at,
            forkSession: true,
            ...(resumeAt.dropsTurn ? { resumeDropsTurn: resumeAt.dropsTurn } : {}),
          }
        : {}),
      // Back up files before Claude's file tools change them, so a rewind can
      // put them back (Query.rewindFiles). Edits made through Bash are not
      // tracked — the UI says so.
      enableFileCheckpointing: true,
      // Claude in Chrome (the CLI's --chrome): connects the claude-in-chrome
      // MCP server and its browser tools. Verified against the real SDK —
      // without it the session has none of those tools.
      ...(chrome ? { extraArgs: { chrome: null } } : {}),
      permissionMode: mode || "default",
      canUseTool,
      // Live text + thinking as they generate (the Claude app streams; a reply
      // appearing all at once after a minute of nothing reads as a hang).
      // The complete assistant message still follows each block, so replay
      // and the transcript keep working off assistant_done alone.
      includePartialMessages: true,
      // The follow-up chips the app shows after a turn ("Run the tests", …).
      promptSuggestions: true,
      // Thinking stays adaptive (the default — the model decides when and how
      // much); this only asks for the readable summaries the app shows in its
      // collapsible "Thinking" rows. Without it the SDK omits thinking text.
      thinking: { type: "adaptive", display: "summarized" },
      // We render a per-task stop control (the background-task tray), so the
      // SDK lets the turn's Stop spare background agents/shells instead of
      // killing them along with the turn.
      perTaskStopAffordance: true,
      abortController,
      // `env` REPLACES the subprocess env entirely per the SDK's own docs —
      // omit it to inherit process.env untouched (the common case); the
      // -work path builds an explicit CLAUDE_CONFIG_DIR-bearing env in
      // agent-manager.js, which also strips ANTHROPIC_API_KEY so a stray
      // key in the parent env can never silently switch this off subscription
      // billing. Irrelevant for a `remote` session below — that env object
      // would only affect the LOCAL `ssh` process, not the remote `claude`.
      ...(env ? { env } : {}),
      // Redirect the SDK's local spawn to a remote one over ssh (see
      // ssh-remote-agent.js). `opts.args` arrives pre-built by the SDK with
      // every CLI flag (--output-format/--resume/etc.) already resolved —
      // forwarded verbatim, only the transport changes. Uses a bare "claude"
      // (resolved on the REMOTE PATH), not `opts.command` (the SDK's
      // resolved LOCAL binary path, meaningless on another host).
      ...(remote
        ? {
            spawnClaudeCodeProcess: (opts) =>
              spawnOverSsh(remote, remote.envPrefix, ["claude", ...opts.args], { signal: opts.signal }),
          }
        : {}),
    },
  });
  // Tell whoever's attached (including a client reconnecting mid-session,
  // via the replay ring buffer in agent-manager.js) what mode this session
  // actually started in — the FleetView UI's mode selector has nothing to
  // show otherwise until the first user message.
  onEvent({ t: "mode", mode: mode || "default" });

  // Streaming bookkeeping. The SDK streams raw Messages-API events and then
  // ALSO sends each finished block as its own `assistant` message, with no id
  // linking the two. Blocks finish in the order they started, so a FIFO per
  // block type pairs them: each text stream gets a fresh id, and the matching
  // assistant_done reuses it so the client finalizes the streamed bubble
  // instead of appending a duplicate.
  const streamIds = new Map(); // content-block index -> { id, kind }
  const pendingText = []; // stream ids awaiting their assistant_done, oldest first
  const pendingThinking = [];

  function handleStream(msg) {
    if (msg.parent_tool_use_id) return; // subagent internals: not streamed into the main log
    const ev = msg.event;
    if (!ev) return;
    if (ev.type === "content_block_start") {
      const kind = ev.content_block?.type;
      if (kind !== "text" && kind !== "thinking") return;
      const id = randomUUID();
      streamIds.set(ev.index, { id, kind });
      (kind === "text" ? pendingText : pendingThinking).push(id);
    } else if (ev.type === "content_block_delta") {
      const s = streamIds.get(ev.index);
      if (!s) return;
      if (ev.delta?.type === "text_delta" && ev.delta.text) {
        onEvent({ t: "assistant_delta", id: s.id, delta: ev.delta.text });
      } else if (ev.delta?.type === "thinking_delta" && ev.delta.thinking) {
        onEvent({ t: "thinking_delta", id: s.id, delta: ev.delta.thinking });
      }
    } else if (ev.type === "message_start") {
      streamIds.clear();
    }
  }

  // Slash commands for the composer's "/" menu. The init frame only has bare
  // names; supportedCommands() adds descriptions + argument hints. Commands
  // bound to the local terminal (exit, statusline, …) are dropped, as the SDK
  // asks phone/remote UIs to do.
  let terminalOnly = new Set();
  let models = []; // from supportedModels(); maps a picked alias to its wire id

  // Background tasks (subagents, background shells) by task id — so a
  // progress/update frame can be merged into what we already know and the
  // client always gets the whole record.
  const tasks = new Map();
  function emitTask(id) {
    const t = tasks.get(id);
    if (t) onEvent({ t: "task", task: { ...t } });
  }

  // How full the context window is — the app shows it; nothing else here
  // knew. "summary" answers from the last response's usage, no extra API
  // calls. Best effort: an older CLI without the control request just
  // never reports.
  function reportContext() {
    q.getContextUsage({ detail: "summary" }).then(
      (u) => {
        if (u && u.maxTokens) onEvent({ t: "context", percent: Math.round(u.percentage), used: u.totalTokens, max: u.maxTokens });
      },
      () => {}
    );
  }
  function emitCommands(list) {
    const commands = (list || [])
      .filter((c) => c && c.name && !terminalOnly.has(c.name))
      .map((c) => ({ name: c.name, description: c.description || "", argumentHint: c.argumentHint || "" }));
    onEvent({ t: "commands", commands });
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case "system":
        if (msg.subtype === "init") {
          onSessionId(msg.session_id);
          // The init frame is the ONLY place the SDK names the model, so this
          // is the one chance to learn it — there is no "which model am I"
          // query. Optional so a driver wired without it still works.
          if (msg.model) onModel?.(msg.model);
          terminalOnly = new Set(msg.terminal_slash_commands || []);
          // Bare names first so the menu works immediately, then the richer list.
          emitCommands((msg.slash_commands || []).map((name) => ({ name })));
          q.supportedCommands().then(emitCommands, () => {});
          q.supportedModels().then((list) => {
            models = (list || []).map((m) => ({
              value: m.value,
              label: m.displayName || m.value,
              description: m.description || "",
              ...(m.resolvedModel ? { resolved: m.resolvedModel } : {}),
            }));
            onEvent({ t: "models", models });
          }, () => {});
        } else if (msg.subtype === "commands_changed") {
          emitCommands(msg.commands);
        } else if (msg.subtype === "api_retry") {
          // Without this an overloaded API just looks like a hang.
          onEvent({
            t: "retry",
            attempt: msg.attempt,
            max: msg.max_retries,
            delayMs: msg.retry_delay_ms,
            status: msg.error_status ?? null,
          });
        } else if (msg.subtype === "compact_boundary") {
          const m = msg.compact_metadata || {};
          onEvent({ t: "compact", trigger: m.trigger || "auto", preTokens: m.pre_tokens, postTokens: m.post_tokens });
          reportContext();
        } else if (msg.subtype === "task_started") {
          tasks.set(msg.task_id, {
            id: msg.task_id,
            description: msg.description || "",
            status: "running",
            backgrounded: !!msg.is_backgrounded,
            toolUseId: msg.tool_use_id,
            kind: msg.subagent_type || msg.task_type || "",
            // Not activity (a live-update watcher, e.g. a published artifact
            // being watched for edits/comments) — never counts as "working".
            ambient: !!msg.ambient,
          });
          emitTask(msg.task_id);
        } else if (msg.subtype === "background_tasks_changed") {
          // The SDK's LEVEL signal: every live background task, replace-semantics,
          // with `ambient` on the ones hosts must not count as activity. Safer
          // than pairing task_started/task_notification edges (a missed bookend
          // can't wedge "working" on).
          onEvent({
            t: "bg_level",
            active: (msg.tasks || []).filter((x) => !x.ambient).length,
            ambient: (msg.tasks || []).filter((x) => x.ambient).length,
          });
        } else if (msg.subtype === "task_progress") {
          const t = tasks.get(msg.task_id);
          if (t) {
            t.lastTool = msg.last_tool_name;
            t.summary = msg.summary || t.summary;
            t.toolUses = msg.usage?.tool_uses;
            t.durationMs = msg.usage?.duration_ms;
            emitTask(msg.task_id);
          }
        } else if (msg.subtype === "task_updated") {
          const t = tasks.get(msg.task_id);
          if (t && msg.patch) {
            if (msg.patch.status) t.status = msg.patch.status === "killed" ? "stopped" : msg.patch.status;
            if (msg.patch.description) t.description = msg.patch.description;
            if (msg.patch.is_backgrounded != null) t.backgrounded = !!msg.patch.is_backgrounded;
            emitTask(msg.task_id);
          }
        } else if (msg.subtype === "task_notification") {
          const t = tasks.get(msg.task_id) || { id: msg.task_id, description: "", toolUseId: msg.tool_use_id };
          t.status = msg.status;
          t.summary = msg.summary || t.summary;
          if (msg.usage) t.durationMs = msg.usage.duration_ms;
          tasks.set(msg.task_id, t);
          emitTask(msg.task_id);
          tasks.delete(msg.task_id); // finished: the client keeps it briefly, we don't
        }
        break;
      case "stream_event":
        handleStream(msg);
        break;
      case "tool_progress":
        // Live elapsed time for a running tool (long Bash, subagents) — the
        // app shows it on the running step. Live-only; never ringed.
        if (msg.tool_use_id) onEvent({ t: "tool_progress", id: msg.tool_use_id, seconds: msg.elapsed_time_seconds });
        break;
      case "prompt_suggestion":
        if (msg.suggestion) onEvent({ t: "suggestion", text: msg.suggestion });
        break;
      case "assistant":
        for (const block of msg.message.content || []) {
          // Subagent (Task/Agent) traffic: by default the SDK forwards only
          // its tool_use/tool_result blocks. Tag them with the parent so the
          // client nests them under the Agent step, as the app does, instead
          // of interleaving them with the main conversation.
          const parent = msg.parent_tool_use_id || undefined;
          if (parent) {
            if (block.type === "tool_use") onEvent({ t: "tool_call", id: block.id, name: block.name, input: block.input, parent });
            continue;
          }
          if (block.type === "thinking" && block.thinking) {
            onEvent({ t: "thinking", id: pendingThinking.shift() || randomUUID(), text: block.thinking });
          } else if (block.type === "text" && block.text) {
            // `msg.aborted`: "true when this assistant message was truncated
            // by an interrupt/abort before the stream completed — stop_reason
            // was never received and the content may end mid-word" (SDK's own
            // doc comment). Flagged on the bubble itself, not just the pane's
            // overall status — see agent-chat.ts.
            onEvent({
              t: "assistant_done",
              id: pendingText.shift() || msg.uuid,
              text: block.text,
              ...(msg.aborted ? { aborted: true } : {}),
            });
          } else if (block.type === "tool_use") {
            onEvent({ t: "tool_call", id: block.id, name: block.name, input: block.input });
          }
        }
        break;
      case "user":
        // Tool results come back on the wire as a "user" role message (the
        // same convention the raw Messages API uses) — not our own prompts
        // echoed back, those are a distinct `SDKUserMessageReplay` type we
        // don't handle here (we already emit our own `{t:"user"}` locally
        // from `send()`, synchronously, before this message could arrive).
        for (const block of Array.isArray(msg.message.content) ? msg.message.content : []) {
          if (block.type === "tool_result") {
            onEvent({
              t: "tool_result",
              id: block.tool_use_id,
              output: stringifyBlockContent(block.content),
              isError: !!block.is_error,
              ...(msg.parent_tool_use_id ? { parent: msg.parent_tool_use_id } : {}),
              // Diff rendering for file-edit tools is a follow-up, not part
              // of the Phase 1 MVP acceptance bar — left undefined for now.
            });
          }
        }
        break;
      case "result": {
        // `terminal_reason` distinguishes a clean finish ('completed') from
        // everything else the SDK can end a turn with — an interrupt/restart
        // ('aborted_streaming'/'aborted_tools') or a mid-stream API problem
        // ('api_error'/'blocking_limit'/'prompt_too_long'/'model_error'/
        // 'budget_exhausted'/…) — and can be present even when `is_error` is
        // falsy. Without this, any of those looked identical to a normal
        // completion: same "idle" status, same "done" attention, even though
        // the last visible message may end mid-word (see msg.aborted above).
        const abortedReason = msg.terminal_reason && msg.terminal_reason !== "completed";
        // Anything still queued for pairing belonged to a turn that's over.
        pendingText.length = 0;
        pendingThinking.length = 0;
        streamIds.clear();
        onEvent({
          t: "status",
          state: msg.is_error ? "error" : abortedReason ? "aborted" : "idle",
          detail: msg.is_error ? msg.result : abortedReason ? `Turn ended early (${msg.terminal_reason})` : undefined,
          // "Worked for 1m 12s" under the turn.
          ...(typeof msg.duration_ms === "number" ? { durationMs: msg.duration_ms } : {}),
        });
        reportContext();
        break;
      }
      case "rate_limit_event":
        // Subscription limit utilization, pushed by the SDK whenever it
        // changes. Deliberately NOT an AgentEvent: limits belong to the
        // ACCOUNT, not this pane (every pane on the same account shares one
        // bucket), so it goes out a separate channel to the usage monitor
        // rather than into the pane's chat log. Costs nothing — it rides
        // along with work the pane was doing anyway.
        onRateLimit?.(msg.rate_limit_info);
        break;
      default:
        break; // normalized schema is deliberately narrow — ignore the rest
    }
  }

  (async () => {
    try {
      for await (const msg of q) {
        if (disposed) break;
        handleMessage(msg);
      }
    } catch (err) {
      if (!disposed) {
        onEvent({ t: "status", state: "error", detail: err?.message || String(err) });
      }
    }
  })();

  return {
    send(text) {
      // OUR id goes into the SDK message too, so the transcript records it
      // under the same uuid the chat shows — that's what a rewind targets.
      const id = randomUUID();
      onEvent({ t: "user", id, text });
      onEvent({ t: "status", state: "working" });
      promptQueue.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, uuid: id });
    },
    /**
     * Put files back the way they were when user message `messageId` was sent
     * (only edits made by Claude's file tools, in sessions with checkpointing).
     * `dryRun` previews without touching anything.
     */
    async rewindFiles(messageId, dryRun) {
      return q.rewindFiles(messageId, dryRun ? { dryRun: true } : undefined);
    },
    /**
     * Answer an AskUserQuestion prompt. `answers` is the tool's own shape:
     * question text → chosen label(s), comma-joined for multi-select (see the
     * AskUserQuestion output schema). Returns whether a pending question with
     * that id was found.
     * @returns {boolean}
     */
    answer(requestId, answers) {
      const resolve = pendingQuestions.get(requestId);
      if (!resolve) return false;
      pendingQuestions.delete(requestId);
      onEvent({ t: "question_resolved", requestId, answers });
      resolve(answers);
      // Same reason send()/approve() re-emit working: unstick the status line
      // and let the tool call (now carrying the answers) actually run.
      onEvent({ t: "status", state: "working" });
      return true;
    },
    /** @returns {boolean} whether a pending request with that id was found */
    approve(requestId, decision, message) {
      const resolve = pendingPermissions.get(requestId);
      if (!resolve) return false;
      pendingPermissions.delete(requestId);
      const feedback = decision === "deny" && typeof message === "string" && message.trim() ? message.trim() : undefined;
      onEvent({ t: "permission_resolved", requestId, decision, ...(feedback ? { message: feedback } : {}) });
      resolve(decision, feedback);
      // Without this the UI's status line is stuck showing "Waiting on your
      // approval…" until the next unrelated status event happens to overwrite
      // it — resolving the promise here lets the tool call (or its denial)
      // proceed, so the session is genuinely back to "working" immediately,
      // same as after send(). True for a deny too: the model still gets a
      // turn to react to the denial before the turn actually ends.
      onEvent({ t: "status", state: "working" });
      return true;
    },
    async interrupt() {
      try {
        await q.interrupt();
      } catch {}
    },
    /**
     * Switch permission mode on the live session (the SDK supports this
     * without restarting the underlying `claude` subprocess — only available
     * because `prompt` is a streaming async iterable here, not a one-shot
     * string). Reports the change back via `onEvent` itself, same as
     * `send()` does for user messages, so callers don't also need to.
     */
    async setMode(newMode) {
      await q.setPermissionMode(newMode);
      onEvent({ t: "mode", mode: newMode });
    },
    /** Stop one background task (the tray's ■), leaving the turn running. */
    async stopTask(taskId) {
      try {
        await q.stopTask(taskId);
      } catch {}
    },
    /** Switch model on the live session (the composer's model picker). */
    async setModel(model) {
      await q.setModel(model);
      // Report the wire id ("claude-opus-5-5"), not the alias ("opus"), so
      // the badge and the picker's current-value match stay consistent.
      onModel?.(models.find((m) => m.value === model)?.resolved || model);
    },
    dispose() {
      disposed = true;
      for (const resolve of pendingPermissions.values()) resolve("deny");
      pendingPermissions.clear();
      for (const resolve of pendingQuestions.values()) resolve(null);
      pendingQuestions.clear();
      abortController.abort();
    },
  };
}
