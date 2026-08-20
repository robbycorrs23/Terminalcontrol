// Read subscription limit status for each agent account.
//
// KEY FACT (verified live, 2026-08-20): reading limits costs NOTHING — no
// tokens, no quota. Both providers expose it as account metadata, never an
// inference call:
//   - claude: a control-channel method on the Agent SDK, which reads the
//     claude.ai usage endpoint. Probed with a session that sends no prompt:
//     `session.total_cost_usd === 0` and `model_usage === {}` afterwards.
//   - codex: a plain `account/rateLimits/read` JSON-RPC to `codex app-server`.
//     No thread, no turn.
// So polling frequency is bounded by process-spawn cost (~1s each), not by
// anything that eats into the user's plan.
//
// Both providers ALSO push updates during normal work (see claude-driver.js /
// codex-driver.js), so an account you're actively using refreshes for free and
// the poll timer only really exists to cover idle accounts.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { query } from "@anthropic-ai/claude-agent-sdk";

const TIMEOUT_MS = 20000;

/**
 * The accounts this machine could have. `configDir` null = that provider's
 * default dir. Mirrors accountConfigDirFor() in agent-manager.js — the same
 * `-work` suffix convention, resolved the same way.
 */
export function knownAccounts() {
  const home = homedir();
  return [
    { id: "claude", provider: "claude", account: "personal", label: "claude", configDir: null },
    { id: "claude-work", provider: "claude", account: "work", label: "claude (work)", configDir: join(home, ".claude-work") },
    { id: "codex", provider: "codex", account: "personal", label: "codex", configDir: null },
    { id: "codex-work", provider: "codex", account: "work", label: "codex (work)", configDir: join(home, ".codex-work") },
  ];
}

/**
 * Only the accounts that actually exist here. A work account is "present" when
 * its config dir exists — the same test index.js uses before installing hooks
 * into it, so we never invent an account the user doesn't have (this machine
 * has ~/.claude-work but no ~/.codex-work, and must show 3 rows, not 4).
 */
export function detectAccounts() {
  const home = homedir();
  return knownAccounts().filter((a) => {
    if (a.account === "work") return existsSync(a.configDir);
    return existsSync(join(home, a.provider === "codex" ? ".codex" : ".claude"));
  });
}

/** Env for a usage read: never leak the ambient account, never bill an API key. */
function envFor(acct) {
  const env = { ...process.env };
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CODEX_HOME;
  delete env.ANTHROPIC_API_KEY; // a stray key flips subscription → pay-per-token
  if (acct.configDir) {
    env[acct.provider === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"] = acct.configDir;
  }
  return env;
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Codex reports a window length in minutes; name it the way the UI should. */
function windowLabel(mins) {
  if (!mins) return "limit";
  if (mins % 10080 === 0) return `${mins / 10080}-week`.replace("1-week", "7-day");
  if (mins % 1440 === 0) return `${mins / 1440}-day`;
  if (mins % 60 === 0) return `${mins / 60}-hour`;
  return `${mins}-min`;
}

const pct = (n) => (typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : null);

// --- claude ------------------------------------------------------------

/**
 * The SDK method is flagged EXPERIMENTAL and its docstring says the NAME WILL
 * CHANGE when stabilized. That is a real upgrade hazard, so it's isolated to
 * this one call: if a future SDK renames it, this throws, the row degrades to
 * "unavailable", and nothing else in FleetView notices.
 */
const CLAUDE_USAGE_METHOD = "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET";

async function readClaude(acct) {
  const ac = new AbortController();
  // A prompt that never yields: the session starts (so the control channel is
  // live) but no turn is ever run, which is why this costs zero tokens.
  const idle = (async function* () {
    await new Promise(() => {});
  })();
  const q = query({ prompt: idle, options: { abortController: ac, env: envFor(acct), cwd: homedir() } });
  try {
    if (typeof q[CLAUDE_USAGE_METHOD] !== "function") {
      throw new Error("SDK usage method missing (renamed in this SDK version?)");
    }
    const u = await withTimeout(q[CLAUDE_USAGE_METHOD](), TIMEOUT_MS, "claude usage");
    if (!u?.rate_limits_available || !u.rate_limits) {
      // API key / Bedrock / Vertex sessions have no plan limits to report.
      return { available: false, plan: u?.subscription_type || null, reason: "no plan limits on this auth" };
    }
    const rl = u.rate_limits;
    const win = (w, label) => (w && pct(w.utilization) !== null
      ? { label, percent: pct(w.utilization), resetsAt: w.resets_at ? Date.parse(w.resets_at) : null }
      : null);
    return {
      available: true,
      plan: u.subscription_type || null,
      primary: win(rl.five_hour, "5-hour"),
      secondary: win(rl.seven_day, "7-day"),
    };
  } finally {
    ac.abort();
  }
}

// --- codex -------------------------------------------------------------

/** One-shot JSON-RPC against `codex app-server`: initialize, read, exit. */
function codexRpc(acct) {
  return new Promise((resolve, reject) => {
    const proc = spawn("codex", ["app-server", "--stdio"], { env: envFor(acct), stdio: ["pipe", "pipe", "pipe"] });
    let buf = "";
    let id = 0;
    const pending = new Map();
    let settled = false;
    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      try { proc.kill(); } catch {}
      fn(arg);
    };
    const send = (method, params, wants = true) => {
      const rid = ++id;
      proc.stdin.write(JSON.stringify(wants ? { method, id: rid, params } : { method, params }) + "\n");
      if (!wants) return Promise.resolve();
      return new Promise((res, rej) => pending.set(rid, { res, rej }));
    };
    proc.on("error", (e) => done(reject, e));
    proc.on("exit", (code) => {
      if (!settled) done(reject, new Error(`codex app-server exited (code ${code})`));
    });
    proc.stdout.on("data", (d) => {
      buf += d.toString();
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        if (m.id !== undefined && pending.has(m.id)) {
          const { res, rej } = pending.get(m.id);
          pending.delete(m.id);
          m.error ? rej(new Error(m.error?.message || "codex rpc error")) : res(m.result);
        }
      }
    });
    (async () => {
      try {
        await send("initialize", {
          clientInfo: { name: "fleetview", title: "FleetView", version: "1.0.0" },
          capabilities: { experimentalApi: false, requestAttestation: false },
        });
        await send("initialized", undefined, false);
        done(resolve, await send("account/rateLimits/read", undefined));
      } catch (e) {
        done(reject, e);
      }
    })();
  });
}

async function readCodex(acct) {
  const res = await withTimeout(codexRpc(acct), TIMEOUT_MS, "codex rateLimits");
  return normalizeCodexSnapshot(res?.rateLimits);
}

/**
 * Shared by the poll path and the live `account/rateLimits/updated` push, so a
 * pushed snapshot and a polled one produce byte-identical rows.
 */
export function normalizeCodexSnapshot(s) {
  if (!s) return { available: false, plan: null, reason: "no rate-limit data" };
  const win = (w) => (w && pct(w.usedPercent) !== null
    ? { label: windowLabel(w.windowDurationMins), percent: pct(w.usedPercent), resetsAt: w.resetsAt ? w.resetsAt * 1000 : null }
    : null);
  return {
    available: true,
    plan: s.planType && s.planType !== "unknown" ? s.planType : null,
    primary: win(s.primary),
    secondary: win(s.secondary),
    reached: s.rateLimitReachedType || null,
  };
}

/** Normalize the claude SDK's pushed `rate_limit_event` into a partial row. */
export function normalizeClaudeEvent(info) {
  if (!info || pct(info.utilization) === null) return null;
  const label = info.rateLimitType === "five_hour" ? "5-hour"
    : info.rateLimitType?.startsWith("seven_day") ? "7-day"
    : null;
  if (!label) return null;
  return { label, percent: pct(info.utilization), resetsAt: info.resetsAt ? info.resetsAt * 1000 : null };
}

// --- public ------------------------------------------------------------

/** Read one account. Never throws — failures come back as `error` on the row. */
export async function readAccount(acct) {
  const base = { id: acct.id, provider: acct.provider, account: acct.account, label: acct.label, fetchedAt: Date.now() };
  try {
    const data = acct.provider === "codex" ? await readCodex(acct) : await readClaude(acct);
    return { ...base, ...data, error: null };
  } catch (e) {
    return { ...base, available: false, plan: null, primary: null, secondary: null, error: e?.message || String(e) };
  }
}

/** Read every detected account concurrently. */
export async function readAll(accounts = detectAccounts()) {
  return Promise.all(accounts.map(readAccount));
}
