import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Any hook command we install contains this token, so we can find and replace
// our own entries on re-run without disturbing the user's other hooks.
const MARKER = "FLEET_PANE_ID";

/**
 * Same guarded shell command Claude Code's hooks run (see setup-hooks.js):
 * a true no-op outside a FleetView terminal. Codex's PermissionRequest and
 * Stop hooks receive the same "event happened" shape Claude's do, so this
 * command is identical — only the config file and event names differ.
 */
function hookCommand(kind) {
  return (
    '[ -n "$FLEET_PANE_ID" ] && ' +
    'curl -s -X POST "http://localhost:${FLEET_PORT:-4280}/hook" ' +
    "-H 'content-type: application/json' " +
    '-d "{\\"pane\\":\\"$FLEET_PANE_ID\\",\\"kind\\":\\"' +
    kind +
    '\\"}" >/dev/null 2>&1 || true'
  );
}

/**
 * UserPromptSubmit: Codex puts the submitted prompt on stdin as JSON under
 * `.prompt` — same field name Claude Code uses — so we forward stdin verbatim,
 * same as setup-hooks.js's promptHookCommand.
 */
function promptHookCommand() {
  return (
    '[ -n "$FLEET_PANE_ID" ] && ' +
    'curl -s -X POST ' +
    '"http://localhost:${FLEET_PORT:-4280}/hook/prompt?pane=$FLEET_PANE_ID" ' +
    "-H 'content-type: application/json' --data-binary @- >/dev/null 2>&1 || true"
  );
}

/**
 * Idempotently merge FleetView's hooks into <configDir>/hooks.json. Mirrors
 * ensureHooks() in setup-hooks.js: Codex's PermissionRequest ~= Claude Code's
 * Notification (approval needed), Stop and UserPromptSubmit are named the
 * same in both. Safe to run every server start; never touches unrelated hooks.
 *
 * `configDir` defaults to `~/.codex`, but a `codex` process launched with
 * `CODEX_HOME` pointed elsewhere (e.g. the "codex (work)" picker option,
 * which uses `~/.codex-work` to keep a second account's auth.json separate)
 * reads its hooks.json from THAT directory instead — so it needs its own copy
 * of these hooks, or that account's terminals never get attention notifications.
 *
 * NOTE: Codex requires non-managed command hooks to be reviewed and trusted
 * once per machine (`/hooks` inside a `codex` session, or launch with
 * `codex --dangerously-bypass-hook-trust`) before they fire — writing this
 * file alone does not make them active.
 */
export function ensureCodexHooks(port = 4280, configDir = join(os.homedir(), ".codex")) {
  const dir = configDir;
  const file = join(dir, "hooks.json");

  let config = {};
  if (existsSync(file)) {
    try {
      config = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      console.warn(
        `[fleetview] ${file} is not valid JSON; skipping Codex hook install.`
      );
      return;
    }
  }

  config.hooks = config.hooks || {};
  const events = { PermissionRequest: "question", Stop: "done" };
  for (const [event, kind] of Object.entries(events)) {
    const existing = config.hooks[event] || [];
    const kept = existing.filter((g) => !JSON.stringify(g).includes(MARKER));
    kept.push({ hooks: [{ type: "command", command: hookCommand(kind) }] });
    config.hooks[event] = kept;
  }

  {
    const existing = config.hooks.UserPromptSubmit || [];
    const kept = existing.filter((g) => !JSON.stringify(g).includes(MARKER));
    kept.push({ hooks: [{ type: "command", command: promptHookCommand() }] });
    config.hooks.UserPromptSubmit = kept;
  }

  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(config, null, 2));
  console.log(
    `[fleetview] NOTE: updated ${file} with 3 hooks (PermissionRequest\n` +
      "           / Stop / UserPromptSubmit). They are guarded and a no-op outside\n" +
      "           FleetView terminals. Codex won't run them until you trust them\n" +
      "           once — run `/hooks` inside a `codex` session, or start Codex\n" +
      "           panes with `codex --dangerously-bypass-hook-trust`."
  );
}

// Allow `node server/setup-codex-hooks.js` to install standalone.
const invokedDirectly =
  process.argv[1] &&
  fileURLToPath(import.meta.url) ===
    join(dirname(fileURLToPath(import.meta.url)), "setup-codex-hooks.js") &&
  process.argv[1].endsWith("setup-codex-hooks.js");
if (invokedDirectly) {
  ensureCodexHooks(Number(process.env.FLEET_PORT) || 4280);
}
