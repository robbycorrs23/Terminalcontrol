import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

// Client → server decision values are our own "allow"|"deny"|"always"
// vocabulary (same as claude-driver.js, so agent-chat.ts's UI never needs to
// know which provider it's talking to). Codex's own wire vocabulary —
// confirmed against `codex app-server generate-ts` ground truth, not
// guessed — is "accept" | "acceptForSession" | "decline" | "cancel".
const DECISION_MAP = { allow: "accept", always: "acceptForSession", deny: "decline" };

/** `ThreadItem` (commandExecution/fileChange) → our tool_call event fields, or null to ignore. */
function toolCallFromItem(item) {
  if (item.type === "commandExecution") {
    return { name: "Bash", input: { command: item.command, cwd: item.cwd } };
  }
  if (item.type === "fileChange") {
    return { name: "Edit", input: { paths: (item.changes || []).map((c) => c.path) } };
  }
  return null;
}

/** `ThreadItem` (commandExecution/fileChange), once `item/completed`, → our tool_result event fields. */
function toolResultFromItem(item) {
  if (item.type === "commandExecution") {
    return {
      output: item.aggregatedOutput || "",
      isError: item.status === "failed" || item.status === "declined",
    };
  }
  if (item.type === "fileChange") {
    const changes = item.changes || [];
    return {
      output: changes.map((c) => c.path).join(", "),
      isError: item.status === "failed" || item.status === "declined",
      diff: changes.map((c) => c.diff).filter(Boolean).join("\n") || undefined,
    };
  }
  return null;
}

/**
 * Wraps one `codex app-server --stdio` subprocess as a long-lived session,
 * mirroring claude-driver.js's external contract exactly (`send`/`approve`/
 * `interrupt`/`dispose`, same normalized `AgentEvent`s out) so agent-manager.js
 * and the client need zero changes to support this provider — see the plan.
 *
 * Every method/field name and the approval decision vocabulary below was
 * verified against `codex app-server generate-ts` (the CLI's own generated
 * TypeScript bindings, ground truth for the exact installed version) AND a
 * live empirical protocol probe against the real binary — not guessed from
 * documentation, which turned out to be an unreliable source for this
 * protocol (a web fetch during research fabricated a plausible-looking but
 * nonexistent approval example — caught and discarded, see the plan).
 *
 * @param {{
 *   cwd: string,
 *   resume?: string,
 *   env?: Record<string,string|undefined>,
 *   onEvent: (ev: import("./event-schema.js").AgentEvent) => void,
 *   onSessionId: (id: string) => void,
 * }} opts
 */
export function startCodexSession({ cwd, resume, env, onEvent, onSessionId, onRateLimit }) {
  const proc = spawn("codex", ["app-server", "--stdio"], {
    cwd,
    env: env || process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let nextId = 0;
  const pending = new Map(); // our request id -> {resolve, reject}
  const pendingApprovals = new Map(); // our requestId (stringified) -> the server's original RequestId (string|number)
  const itemsById = new Map(); // itemId -> latest known ThreadItem (fileChange approvals don't carry path/diff inline — see handleServerRequest)
  let threadId = null;
  let currentTurnId = null;
  let disposed = false;
  let buf = "";

  let resolveReady, rejectReady;
  const ready = new Promise((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });
  ready.catch(() => {}); // never let this be the source of an unhandled rejection

  function rpcSend(method, params, wantsResponse = true) {
    const id = wantsResponse ? nextId++ : undefined;
    const msg = wantsResponse ? { method, id, params } : { method, params };
    try {
      proc.stdin.write(JSON.stringify(msg) + "\n");
    } catch {}
    if (!wantsResponse) return;
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  }
  function rpcRespond(id, result) {
    try {
      proc.stdin.write(JSON.stringify({ id, result }) + "\n");
    } catch {}
  }

  function handleNotification(method, params) {
    switch (method) {
      case "item/started": {
        itemsById.set(params.item.id, params.item);
        const call = toolCallFromItem(params.item);
        if (call) onEvent({ t: "tool_call", id: params.item.id, name: call.name, input: call.input });
        break;
      }
      case "item/completed": {
        itemsById.set(params.item.id, params.item);
        if (params.item.type === "agentMessage") {
          onEvent({ t: "assistant_done", id: params.item.id, text: params.item.text });
        } else {
          const res = toolResultFromItem(params.item);
          if (res) onEvent({ t: "tool_result", id: params.item.id, ...res });
        }
        break;
      }
      case "item/agentMessage/delta":
        onEvent({ t: "assistant_delta", id: params.itemId, delta: params.delta });
        break;
      case "turn/started":
        currentTurnId = params.turn.id;
        onEvent({ t: "status", state: "working" });
        break;
      case "turn/completed":
        onEvent({
          t: "status",
          state: params.turn.status === "failed" ? "error" : "idle",
          detail: params.turn.error?.message,
        });
        break;
      case "error":
        onEvent({ t: "status", state: "error", detail: params.error?.message });
        break;
      case "account/rateLimits/updated":
        // Account-level limit snapshot, pushed for free during normal turns.
        // Like claude's rate_limit_event this is NOT an AgentEvent — limits are
        // per-account, not per-pane — so it bypasses the chat log entirely.
        onRateLimit?.(params?.rateLimits);
        break;
      default:
        // The full notification surface is enormous (mcp servers, account,
        // thread settings, realtime audio, ...) — deliberately narrow, per
        // the plan's Phase 2 scope-discipline note. Ignore the rest.
        break;
    }
  }

  function handleServerRequest(method, id, params) {
    if (method === "item/commandExecution/requestApproval") {
      const requestId = String(id);
      pendingApprovals.set(requestId, id);
      const item = itemsById.get(params.itemId);
      const command = params.command || item?.command;
      onEvent({
        t: "permission_request",
        requestId,
        tool: "Bash",
        input: { command, cwd: params.cwd || item?.cwd },
        title: command ? `Run: ${command}` : "Run a shell command",
        description: params.reason || undefined,
      });
      onEvent({ t: "status", state: "waiting_permission" });
    } else if (method === "item/fileChange/requestApproval") {
      // Unlike the command-exec approval, this params shape carries no
      // path/diff itself (confirmed against generated types) — look the
      // item up by id, populated at its earlier item/started.
      const requestId = String(id);
      pendingApprovals.set(requestId, id);
      const item = itemsById.get(params.itemId);
      const paths = (item?.changes || []).map((c) => c.path);
      onEvent({
        t: "permission_request",
        requestId,
        tool: "Edit",
        input: { paths, changes: item?.changes },
        title: paths.length ? `Edit ${paths.join(", ")}` : "Change files",
        description: params.reason || undefined,
      });
      onEvent({ t: "status", state: "waiting_permission" });
    } else {
      // Unhandled server request (mcp elicitation, dynamic tool call, user
      // input, ...) — respond rather than leave the server blocked forever
      // waiting on an id we'll never answer for real.
      rpcRespond(id, {});
    }
  }

  proc.stdout.on("data", (chunk) => {
    buf += chunk.toString();
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      if (m.method && m.id !== undefined) {
        handleServerRequest(m.method, m.id, m.params);
      } else if (m.method) {
        handleNotification(m.method, m.params);
      } else if (m.id !== undefined && pending.has(m.id)) {
        const { resolve, reject } = pending.get(m.id);
        pending.delete(m.id);
        if (m.error) reject(new Error(m.error?.message || "codex app-server error"));
        else resolve(m.result);
      }
    }
  });
  proc.on("exit", (code) => {
    if (!disposed && code !== 0) {
      onEvent({ t: "status", state: "error", detail: `codex app-server exited (code ${code})` });
    }
  });
  proc.stderr.on("data", () => {}); // swallow — nothing user-facing belongs on stderr here

  (async () => {
    try {
      await rpcSend("initialize", {
        clientInfo: { name: "fleetview", title: "FleetView", version: "1.0.0" },
        capabilities: { experimentalApi: false, requestAttestation: false },
      });
      rpcSend("initialized", undefined, false);
      const threadRes = resume
        ? await rpcSend("thread/resume", { threadId: resume, cwd })
        : await rpcSend("thread/start", { cwd });
      threadId = threadRes.thread.id;
      onSessionId(threadId);
      resolveReady();
    } catch (err) {
      rejectReady(err);
      onEvent({ t: "status", state: "error", detail: err?.message || String(err) });
    }
  })();

  return {
    async send(text) {
      onEvent({ t: "user", id: randomUUID(), text });
      onEvent({ t: "status", state: "working" });
      try {
        await ready;
        const res = await rpcSend("turn/start", {
          threadId,
          input: [{ type: "text", text, text_elements: [] }],
        });
        currentTurnId = res.turn.id;
      } catch (err) {
        onEvent({ t: "status", state: "error", detail: err?.message || String(err) });
      }
    },
    /** @returns {boolean} whether a pending request with that id was found */
    approve(requestId, decision) {
      const originalId = pendingApprovals.get(requestId);
      if (originalId === undefined) return false;
      pendingApprovals.delete(requestId);
      rpcRespond(originalId, { decision: DECISION_MAP[decision] || "decline" });
      onEvent({ t: "permission_resolved", requestId, decision });
      // Same staleness fix as claude-driver.js's approve(): without this the
      // status line is stuck on "Waiting on your approval…" until the next
      // unrelated status event overwrites it, even though the item/turn is
      // genuinely running again immediately after this response.
      onEvent({ t: "status", state: "working" });
      return true;
    },
    async interrupt() {
      if (!threadId || !currentTurnId) return;
      try {
        await rpcSend("turn/interrupt", { threadId, turnId: currentTurnId });
      } catch {}
    },
    dispose() {
      disposed = true;
      for (const originalId of pendingApprovals.values()) {
        try {
          rpcRespond(originalId, { decision: "cancel" });
        } catch {}
      }
      pendingApprovals.clear();
      try {
        proc.kill();
      } catch {}
    },
  };
}
