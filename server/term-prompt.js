/**
 * Read an interactive prompt off a terminal screen — so the fleet inbox can
 * answer a terminal pane's "Do you want to proceed?" without you opening it.
 *
 * Shaped on Claude Code's real prompts (verified against the CLI in tmux):
 *
 *   ─────────────────────────────          ← solid rule
 *    Bash command                          ← title
 *    Create empty file made-by-bash.txt    ← description ("Tip:" lines skipped)
 *   ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌          ← dashed rule
 *    touch made-by-bash.txt                ← the command / detail
 *   ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 *    Do you want to proceed?               ← question
 *    ❯ 1. Yes                              ← options; ❯ marks the cursor
 *      2. Yes, and always allow …
 *      4. No
 *    Esc to cancel · Tab to amend          ← footer
 *
 * Options are NOT always numbered (the folder-trust prompt isn't), so the
 * answer is given by moving the ❯ cursor with arrow keys and pressing Enter —
 * see keysFor(). Returns null when the screen isn't showing such a prompt.
 */

const FOOTER = /(Esc to cancel|Enter to confirm|esc to interrupt|↑\/↓ to (navigate|select))/i;
const SOLID = /^\s*─{8,}\s*$/;
const DASHED = /^\s*[╌┄-]{8,}\s*$/;
const OPTION = /^\s{0,4}(❯|›|>)?\s*(?:(\d{1,2})[.)]\s+)?(\S.*?)\s*$/;

/** The option lines just above the footer: a run indented under the question, one carrying ❯. */
export function parsePrompt(screen) {
  const lines = String(screen || "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""));
  // Search from the bottom for the footer; prompts are drawn at the bottom.
  let footer = -1;
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 25); i--) {
    if (FOOTER.test(lines[i])) {
      footer = i;
      break;
    }
  }
  if (footer < 0) return null;

  // The cursor line (❯) nearest above the footer anchors the option block:
  // the other options are aligned to the cursor line's LABEL column (three
  // spaces in, beside the ❯). That's what separates them from ordinary text
  // in the prompt, which is indented by one space and would otherwise look
  // like options (the folder-trust prompt's "Security guide" line, say).
  let cur = -1;
  for (let k = footer - 1; k >= Math.max(0, footer - 20); k--) {
    if (/^\s{0,4}[❯›]\s/.test(lines[k])) {
      cur = k;
      break;
    }
  }
  if (cur < 0) return null;
  const col = lines[cur].search(/[❯›]\s+\S/) + lines[cur].slice(lines[cur].search(/[❯›]/) + 1).search(/\S/) + 1;
  const isOption = (l) => l.trim() && (/^\s{0,4}[❯›]\s/.test(l) || (l.search(/\S/) === col && !SOLID.test(l) && !DASHED.test(l)));
  let first = cur;
  while (first - 1 >= 0 && isOption(lines[first - 1]) && !/^\s{0,4}[❯›]\s/.test(lines[first - 1])) first--;
  let last = cur;
  while (last + 1 < footer && isOption(lines[last + 1])) last++;
  const opts = [];
  for (let k = first; k <= last; k++) {
    const m = OPTION.exec(lines[k]);
    if (!m) continue;
    opts.push({ label: m[3].replace(/^\d+[.)]\s+/, ""), number: m[2] ? Number(m[2]) : null, cursor: k === cur });
  }
  if (opts.length < 2) return null;
  let i = first - 1;

  // The question: the nearest line ending in "?" just above the options
  // (within a few lines), else simply the nearest non-empty line.
  let qi = -1;
  for (let k = i; k >= Math.max(0, i - 6) && !SOLID.test(lines[k]); k--) {
    if (/\?\s*$/.test(lines[k])) {
      qi = k;
      break;
    }
  }
  while (i >= 0 && !lines[i].trim()) i--;
  if (qi < 0) qi = i;
  const question = qi >= 0 && !SOLID.test(lines[qi]) && !DASHED.test(lines[qi]) ? lines[qi].trim() : "";
  i = qi;

  // Title + details: from the last solid rule above, down to the question.
  let top = i - 1;
  while (top >= 0 && !SOLID.test(lines[top])) top--;
  const body = lines
    .slice(top + 1, i)
    .map((l) => l.trim())
    .filter((l) => l && !DASHED.test(l) && !/^Tip:/i.test(l));
  const title = body.shift() || "";
  return {
    title,
    detail: body.join("\n").slice(0, 2000),
    question,
    options: opts.map((o, idx) => ({ index: idx, label: o.label, number: o.number })),
    cursor: opts.findIndex((o) => o.cursor),
  };
}

/**
 * Keystrokes (tmux send-keys names) that choose option `index` from a prompt
 * whose cursor is at `cursor`: arrow to it, then Enter. Works whether or not
 * the options are numbered.
 */
export function keysFor(prompt, index) {
  const keys = [];
  const delta = index - prompt.cursor;
  for (let k = 0; k < Math.abs(delta); k++) keys.push(delta > 0 ? "Down" : "Up");
  keys.push("Enter");
  return keys;
}
