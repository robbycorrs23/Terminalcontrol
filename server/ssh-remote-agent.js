import { spawn } from "node:child_process";

/**
 * Shared plumbing for running a chat-view agent (claude/codex) OVER SSH on a
 * remote host, instead of as a local subprocess. Used by claude-driver.js
 * (via the SDK's `spawnClaudeCodeProcess` hook) and codex-driver.js (which
 * spawns its own `codex app-server` process directly) — see the plan.
 *
 * Deliberately NEVER requests a pty (no `-t`): both drivers speak a clean
 * newline-delimited protocol (NDJSON / hand-rolled JSON-RPC) over stdin/
 * stdout, and a pty would corrupt that framing with terminal echo/CR
 * translation. This is the opposite of the PTY "and run — there" feature
 * (client/src/main.ts's remoteAgentCmd/buildSshCommand), which DOES need
 * `-t` because it's driving an interactive TUI, not a structured stream.
 */

// POSIX single-quote escaping — mirrors client/src/main.ts's shQuote() so a
// value with spaces/special characters still arrives as one literal argument
// on the remote shell's command line.
export function shQuote(s) {
  return "'" + String(s).replace(/'/g, `'\\''`) + "'";
}

/**
 * ssh connection flags for a NON-interactive, no-pty subprocess whose local
 * stdin/stdout must stay a byte-clean pipe to the remote command.
 * `BatchMode=yes` makes an unknown host key or a password prompt fail FAST
 * instead of hanging the pane forever waiting on a prompt nothing can
 * answer — the target's host key must already be trusted (e.g. via a prior
 * terminal-view connection) before this will connect. `ConnectTimeout`
 * bounds an unreachable host the same way.
 */
export function sshArgs(remote) {
  const args = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"];
  if (remote.port) args.push("-p", String(remote.port));
  if (remote.identityFile) args.push("-o", "IdentitiesOnly=yes", "-i", remote.identityFile);
  args.push(remote.target);
  return args;
}

/**
 * One shell-safe command string for the REMOTE end: an optional literal env
 * prefix (e.g. `CLAUDE_CONFIG_DIR="$HOME/.claude-work" `) followed by each
 * argv token individually quoted. `envPrefix` is always server-constructed
 * from fixed strings (see agent-manager.js's remoteEnvPrefix) — never user
 * input — so it's deliberately left unquoted; quoting it would turn a real
 * env-var assignment into an inert literal string on the remote shell.
 */
export function remoteCommandString(envPrefix, argv) {
  return (envPrefix || "") + argv.map(shQuote).join(" ");
}

/**
 * Spawns `ssh <remote> <remoteCommandString>` as a plain (non-shell) child
 * process with fully piped stdio — a drop-in `SpawnedProcess`/`ChildProcess`
 * for claude-driver.js's `spawnClaudeCodeProcess` hook, or a direct
 * replacement for codex-driver.js's local `spawn("codex", ...)` call.
 */
export function spawnOverSsh(remote, envPrefix, argv, extra = {}) {
  return spawn("ssh", [...sshArgs(remote), remoteCommandString(envPrefix, argv)], {
    stdio: ["pipe", "pipe", "pipe"],
    ...extra,
  });
}
