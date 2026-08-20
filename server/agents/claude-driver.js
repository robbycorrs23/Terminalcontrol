import { randomUUID } from "node:crypto";
import { query } from "@anthropic-ai/claude-agent-sdk";

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
 *   onEvent: (ev: import("./event-schema.js").AgentEvent) => void,
 *   onSessionId: (id: string) => void,
 * }} opts
 */
export function startClaudeSession({ cwd, resume, env, mode, onEvent, onSessionId, onRateLimit }) {
  const promptQueue = new PushQueue();
  const pendingPermissions = new Map(); // requestId -> (decision: "allow"|"deny"|"always") => void
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
    });
    onEvent({ t: "status", state: "waiting_permission" });
    return new Promise((resolve) => {
      pendingPermissions.set(opts.requestId, (decision) => {
        if (decision === "deny") {
          resolve({ behavior: "deny", message: "Denied by user" });
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
      permissionMode: mode || "default",
      canUseTool,
      abortController,
      // `env` REPLACES the subprocess env entirely per the SDK's own docs —
      // omit it to inherit process.env untouched (the common case); the
      // -work path builds an explicit CLAUDE_CONFIG_DIR-bearing env in
      // agent-manager.js, which also strips ANTHROPIC_API_KEY so a stray
      // key in the parent env can never silently switch this off subscription
      // billing.
      ...(env ? { env } : {}),
    },
  });
  // Tell whoever's attached (including a client reconnecting mid-session,
  // via the replay ring buffer in agent-manager.js) what mode this session
  // actually started in — the FleetView UI's mode selector has nothing to
  // show otherwise until the first user message.
  onEvent({ t: "mode", mode: mode || "default" });

  function handleMessage(msg) {
    switch (msg.type) {
      case "system":
        if (msg.subtype === "init") onSessionId(msg.session_id);
        break;
      case "assistant":
        for (const block of msg.message.content || []) {
          if (block.type === "text" && block.text) {
            onEvent({ t: "assistant_done", id: msg.uuid, text: block.text });
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
              // Diff rendering for file-edit tools is a follow-up, not part
              // of the Phase 1 MVP acceptance bar — left undefined for now.
            });
          }
        }
        break;
      case "result":
        onEvent({
          t: "status",
          state: msg.is_error ? "error" : "idle",
          detail: msg.is_error ? msg.result : undefined,
        });
        break;
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
      onEvent({ t: "user", id: randomUUID(), text });
      onEvent({ t: "status", state: "working" });
      promptQueue.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null });
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
    approve(requestId, decision) {
      const resolve = pendingPermissions.get(requestId);
      if (!resolve) return false;
      pendingPermissions.delete(requestId);
      onEvent({ t: "permission_resolved", requestId, decision });
      resolve(decision);
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
