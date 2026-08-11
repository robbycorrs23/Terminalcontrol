import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Any hook command we install contains this token, so we can find and replace
// our own entries on re-run without disturbing the user's other hooks.
const MARKER = "FLEET_PANE_ID";

/**
 * The shell command Claude Code runs for the hook. It is guarded so it is a true
 * no-op in any shell that is NOT a FleetView terminal: $FLEET_PANE_ID is only set
 * for shells we spawn, so elsewhere the `[ -n ... ]` test fails and nothing runs.
 * Inside FleetView it POSTs the pane id + kind to the local server.
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
 * UserPromptSubmit hook: Claude puts the submitted prompt on stdin as JSON, so we
 * forward stdin verbatim and let the server pull out `.prompt`. The pane id rides
 * in the query string. Guarded so it's a no-op outside FleetView terminals.
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
 * Idempotently merge the Notification (needs-you) and Stop (turn-finished) hooks
 * into <configDir>/settings.json. Safe to run every server start: it strips any
 * previously-installed FleetView hooks first, then re-adds the current ones, and
 * never touches unrelated hooks or settings.
 *
 * `configDir` defaults to `~/.claude`, but any `claude` process launched with
 * `CLAUDE_CONFIG_DIR` pointed elsewhere (e.g. the "claude (work)" picker option,
 * which uses `~/.claude-work` to keep a second account's login separate) reads
 * its settings.json from THAT directory instead — so it needs its own copy of
 * these hooks, or that account's terminals never get attention notifications.
 */
export function ensureHooks(port = 4280, configDir = join(os.homedir(), ".claude")) {
  const dir = configDir;
  const file = join(dir, "settings.json");

  let settings = {};
  if (existsSync(file)) {
    try {
      settings = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      console.warn(
        "[fleetview] ~/.claude/settings.json is not valid JSON; skipping hook install."
      );
      return;
    }
  }

  settings.hooks = settings.hooks || {};
  const events = { Notification: "question", Stop: "done" };
  for (const [event, kind] of Object.entries(events)) {
    const existing = settings.hooks[event] || [];
    // Drop our own previously-installed groups, keep everything else.
    const kept = existing.filter((g) => !JSON.stringify(g).includes(MARKER));
    kept.push({ hooks: [{ type: "command", command: hookCommand(kind) }] });
    settings.hooks[event] = kept;
  }

  // UserPromptSubmit uses a different command (forwards the prompt), same
  // strip-our-own-then-re-add idempotency.
  {
    const existing = settings.hooks.UserPromptSubmit || [];
    const kept = existing.filter((g) => !JSON.stringify(g).includes(MARKER));
    kept.push({ hooks: [{ type: "command", command: promptHookCommand() }] });
    settings.hooks.UserPromptSubmit = kept;
  }

  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(settings, null, 2));
  console.log(
    `[fleetview] NOTE: updated ${file} with 3 hooks\n` +
      "           (Notification / Stop / UserPromptSubmit). They are guarded and a\n" +
      "           no-op outside FleetView terminals. To remove them, see the README\n" +
      "           section \"Removing the hooks\"."
  );
}

// Allow `npm run setup` / `node server/setup-hooks.js` to install standalone.
const invokedDirectly =
  process.argv[1] &&
  fileURLToPath(import.meta.url) ===
    join(dirname(fileURLToPath(import.meta.url)), "setup-hooks.js") &&
  process.argv[1].endsWith("setup-hooks.js");
if (invokedDirectly) {
  ensureHooks(Number(process.env.FLEET_PORT) || 4280);
}
