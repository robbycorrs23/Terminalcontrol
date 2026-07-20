import { spawn, spawnSync } from "node:child_process";

// GUI editors we can launch detached, in detection order. Each accepts a
// `file:line` target (VS Code / Cursor need `-g` for that to jump to the line).
const DETECT = [
  { cmd: "code", args: ["-g"] },
  { cmd: "cursor", args: ["-g"] },
  { cmd: "zed", args: [] },
  { cmd: "subl", args: [] },
];

// Is `cmd` on PATH? (`which` exits 0 when found.)
function onPath(cmd) {
  try {
    return spawnSync("which", [cmd], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

/**
 * Decide the editor command + argv. Pure — `opts.env`/`opts.has` are injectable
 * for testing. FLEET_EDITOR (e.g. "code -g") wins; else the first GUI editor on
 * PATH; else macOS `open` (which ignores the line number).
 */
export function editorCommand(absPath, line, opts = {}) {
  const env = opts.env || process.env;
  const has = opts.has || onPath;
  let ed = null;
  const fe = (env.FLEET_EDITOR || "").trim();
  if (fe) {
    const parts = fe.split(/\s+/);
    ed = { cmd: parts[0], args: parts.slice(1) };
  } else {
    ed = DETECT.find((d) => has(d.cmd)) || null;
  }
  if (ed) {
    const target = line ? `${absPath}:${line}` : absPath;
    return { cmd: ed.cmd, args: [...ed.args, target] };
  }
  return { cmd: "open", args: [absPath] }; // macOS fallback, no line jump
}

/** Launch the chosen editor detached so it never blocks or outlives-tie the server. */
export function openInEditor(absPath, line) {
  const { cmd, args } = editorCommand(absPath, line);
  const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
  child.on("error", () => {}); // a missing editor must never throw into the request
  child.unref();
}
