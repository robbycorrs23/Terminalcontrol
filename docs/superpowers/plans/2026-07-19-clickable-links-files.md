# Clickable Links & File Paths Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make URLs and file paths in FleetView terminal output clickable — URLs open in the browser, file paths open in an editor at their line number.

**Architecture:** Load xterm's official web-links addon for URLs. Add a custom xterm link provider (`client/src/links.ts`) that regex-matches file-path tokens and, on click, POSTs to a new `POST /api/panes/:id/open` endpoint. The server resolves the path against the pane's `cwd`, `fs.stat`s it (missing → silent no-op), and opens it via a detached editor process (`server/open-file.js`).

**Tech Stack:** TypeScript client bundled by Vite + xterm.js 5.5; Node ESM server (Express, `node:child_process`).

## Global Constraints

- ESM everywhere (`import`/`export`, `.js` extensions in server import specifiers).
- Server binds `127.0.0.1` by default; no auth — do not add any network exposure.
- No committed tests / no test framework: verify with throwaway scripts run under the scratchpad dir, never committed. Scratchpad: `/private/tmp/claude-501/-Users-stevenschopp-Repositories-terminal-control/040b16f7-4387-4bd1-a5f1-4a1ccc65835d/scratchpad`.
- `vite build` does NOT typecheck — run `npm run typecheck` (`tsc --noEmit`) separately.
- Match surrounding code style and comment density (explain *why*, not *what*).
- Commit only the source changes listed per task (never `dist/`, `sessions.json`, `layouts.json`, `tasks.json`, or scratchpad files).

---

## File Structure

| File | Responsibility |
|------|----------------|
| `server/open-file.js` (new) | Decide the editor command (`editorCommand`) and launch it detached (`openInEditor`). |
| `server/index.js` (modify) | New `POST /api/panes/:id/open` endpoint: resolve + stat + open. |
| `client/src/links.ts` (new) | `parseFileLink` (pure) + `installFileLinks` (registers the xterm link provider). |
| `client/src/terminal.ts` (modify) | Load web-links addon; call `installFileLinks`; add `openFile` POST helper. |
| `package.json` (modify) | Add `@xterm/addon-web-links` dev dependency. |

---

## Task 1: Editor-launch helper (`server/open-file.js`)

**Files:**
- Create: `server/open-file.js`
- Test: throwaway `scratchpad/test-open-file.mjs` (not committed)

**Interfaces:**
- Produces:
  - `editorCommand(absPath: string, line?: number, opts?: { env?: object, has?: (cmd: string) => boolean }): { cmd: string, args: string[] }` — pure; decides which editor + argv.
  - `openInEditor(absPath: string, line?: number): void` — spawns the command detached, swallows errors.

- [ ] **Step 1: Write the failing throwaway test**

Create `scratchpad/test-open-file.mjs`:

```js
import { editorCommand } from "../server/open-file.js";
import assert from "node:assert";

// NOTE: adjust the relative import path to the repo's server/open-file.js absolute path if needed.

// 1. FLEET_EDITOR override, with a line number → append :line to the target.
assert.deepStrictEqual(
  editorCommand("/a/b.js", 42, { env: { FLEET_EDITOR: "code -g" }, has: () => false }),
  { cmd: "code", args: ["-g", "/a/b.js:42"] }
);

// 2. FLEET_EDITOR override, no line → bare path.
assert.deepStrictEqual(
  editorCommand("/a/b.js", undefined, { env: { FLEET_EDITOR: "cursor -g" }, has: () => false }),
  { cmd: "cursor", args: ["-g", "/a/b.js"] }
);

// 3. No env → auto-detect: first editor found on PATH wins (here: subl only).
assert.deepStrictEqual(
  editorCommand("/a/b.js", 7, { env: {}, has: (c) => c === "subl" }),
  { cmd: "subl", args: ["/a/b.js:7"] }
);

// 4. No env, nothing detected → macOS `open` fallback (no line jump).
assert.deepStrictEqual(
  editorCommand("/a/b.js", 7, { env: {}, has: () => false }),
  { cmd: "open", args: ["/a/b.js"] }
);

console.log("ok");
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node "<scratchpad>/test-open-file.mjs"`
Expected: FAIL — `Cannot find module '.../server/open-file.js'` (file not created yet).

- [ ] **Step 3: Implement `server/open-file.js`**

```js
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node "<scratchpad>/test-open-file.mjs"`
Expected: prints `ok`.

- [ ] **Step 5: Commit**

```bash
git add server/open-file.js
git commit -m "feat(server): editor-launch helper for opening files"
```

---

## Task 2: Open endpoint (`POST /api/panes/:id/open`)

**Files:**
- Modify: `server/index.js` (add import + endpoint; add `resolve` to the `node:path` import and `homedir` to the `node:os` import)
- Test: throwaway `scratchpad/test-open-endpoint.mjs` (not committed)

**Interfaces:**
- Consumes: `openInEditor` from `./open-file.js`; `ptys.info(id).cwd`.
- Produces: `POST /api/panes/:id/open` accepting JSON `{ path: string, line?: number }`. 404 if no such pane; 400 if no path; 204 otherwise (including missing-file no-op).

- [ ] **Step 1: Add imports**

In `server/index.js`, extend the existing `node:path` and `node:os` imports, and import the helper. Change:

```js
import { dirname, join, extname } from "node:path";
import { tmpdir } from "node:os";
```

to:

```js
import { dirname, join, extname, resolve } from "node:path";
import { tmpdir, homedir } from "node:os";
```

and add alongside the other local imports (after `import { PtyManager } from "./pty-manager.js";`):

```js
import { openInEditor } from "./open-file.js";
```

Also add `statSync` to the existing `node:fs` import. Change:

```js
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
```

to:

```js
import { mkdtempSync, writeFileSync, mkdirSync, statSync } from "node:fs";
```

- [ ] **Step 2: Add the endpoint**

Insert after the `POST /api/panes/:id/name` handler (near line 282), matching the surrounding handler style:

```js
// A file path clicked in the terminal → open it in an editor. The path is
// resolved against the pane's cwd (Claude prints relative paths like
// "server/index.js:42"); a non-existent target is a silent no-op so a
// false-positive link match never launches anything. See server/open-file.js.
app.post("/api/panes/:id/open", (req, res) => {
  const info = ptys.info(req.params.id);
  if (!info) return res.status(404).json({ error: "no such pane" });
  const raw = req.body && typeof req.body.path === "string" ? req.body.path : "";
  if (!raw) return res.status(400).json({ error: "no path" });
  const line = req.body && Number.isInteger(req.body.line) ? req.body.line : undefined;
  const expanded = raw.startsWith("~") ? join(homedir(), raw.slice(1)) : raw;
  const abs = resolve(info.cwd, expanded);
  try {
    if (!statSync(abs).isFile()) return res.status(204).end(); // dir/other → no-op
  } catch {
    return res.status(204).end(); // doesn't exist → no-op (absorbs bad matches)
  }
  openInEditor(abs, line);
  res.status(204).end();
});
```

- [ ] **Step 3: Typecheck / syntax check the server**

Run: `node --check server/index.js`
Expected: no output (exit 0).

- [ ] **Step 4: Write and run a throwaway integration test**

Create `scratchpad/test-open-endpoint.mjs`. It stubs the editor by setting `FLEET_EDITOR` to a harmless command and starts the real Express app on a unique port pointed at an isolated sessions file. Simpler: exercise the resolution + stat logic against a temp file via an in-process fetch. Use this self-contained script:

```js
// Verifies the endpoint's resolve+stat+response behavior without launching an editor.
import express from "express";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { statSync } from "node:fs";
import assert from "node:assert";

// Minimal re-creation of the handler with a fake pane cwd + a capture instead of spawn.
const dir = mkdtempSync(join(tmpdir(), "fleet-open-"));
writeFileSync(join(dir, "real.js"), "// hi\n");
let opened = null;
const app = express();
app.use(express.json());
const info = { cwd: dir };
app.post("/api/panes/:id/open", (req, res) => {
  if (!info) return res.status(404).json({ error: "no such pane" });
  const raw = typeof req.body.path === "string" ? req.body.path : "";
  if (!raw) return res.status(400).json({ error: "no path" });
  const line = Number.isInteger(req.body.line) ? req.body.line : undefined;
  const expanded = raw.startsWith("~") ? join(homedir(), raw.slice(1)) : raw;
  const abs = resolve(info.cwd, expanded);
  try {
    if (!statSync(abs).isFile()) return res.status(204).end();
  } catch {
    return res.status(204).end();
  }
  opened = { abs, line };
  res.status(204).end();
});

const server = app.listen(0);
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${server.address().port}`;
const post = (b) =>
  fetch(`${base}/api/panes/x/open`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(b),
  });

// real relative file → 204 + captured resolve/line
let r = await post({ path: "real.js", line: 42 });
assert.strictEqual(r.status, 204);
assert.deepStrictEqual(opened, { abs: join(dir, "real.js"), line: 42 });

// missing file → 204 no-op, nothing captured
opened = null;
r = await post({ path: "nope.js", line: 1 });
assert.strictEqual(r.status, 204);
assert.strictEqual(opened, null);

// empty path → 400
r = await post({ path: "" });
assert.strictEqual(r.status, 400);

server.close();
console.log("ok");
```

Run: `node "<scratchpad>/test-open-endpoint.mjs"`
Expected: prints `ok`.

> Note: this reproduces the handler logic to avoid booting the real server (which would touch live `sessions.json` / tmux — forbidden per CLAUDE.md). It guards the resolve/stat/response contract; the actual wiring is covered by the manual smoke test in Task 4.

- [ ] **Step 5: Commit**

```bash
git add server/index.js
git commit -m "feat(server): POST /api/panes/:id/open to open a clicked file"
```

---

## Task 3: File-path link provider (`client/src/links.ts`)

**Files:**
- Create: `client/src/links.ts`
- Test: throwaway `scratchpad/test-links.mjs` (esbuild the module, then assert `parseFileLink`) — not committed

**Interfaces:**
- Consumes: `Terminal` from `@xterm/xterm` (type-only).
- Produces:
  - `parseFileLink(raw: string): { file: string; line?: number; text: string } | null` — pure; given a whitespace-delimited token, returns the file path, optional line, and the exact matched substring (a prefix of `raw`), or `null` if it isn't path-shaped.
  - `installFileLinks(term: Terminal, open: (path: string, line?: number) => void): void` — registers the link provider.

- [ ] **Step 1: Write the failing throwaway test**

Create `scratchpad/test-links.mjs`:

```js
import { execSync } from "node:child_process";
import assert from "node:assert";

// esbuild the TS module to plain ESM (type-only xterm import is erased, so no xterm needed at runtime).
execSync(
  `npx esbuild client/src/links.ts --bundle --format=esm --outfile="<scratchpad>/links.built.mjs"`,
  { stdio: "inherit" }
);
const { parseFileLink } = await import("<scratchpad>/links.built.mjs");

const file = (t) => parseFileLink(t);

// relative path with line
assert.deepStrictEqual(file("server/index.js:42"), { file: "server/index.js", line: 42, text: "server/index.js:42" });
// line:col — column ignored, link text still covers it
assert.deepStrictEqual(file("a/b.ts:10:5"), { file: "a/b.ts", line: 10, text: "a/b.ts:10:5" });
// bare filename with extension, no slash
assert.deepStrictEqual(file("README.md"), { file: "README.md", line: undefined, text: "README.md" });
// absolute path
assert.deepStrictEqual(file("/etc/hosts"), { file: "/etc/hosts", line: undefined, text: "/etc/hosts" });
// trailing sentence punctuation stripped, line still parsed
assert.deepStrictEqual(file("src/app.ts:9."), { file: "src/app.ts", line: 9, text: "src/app.ts:9" });
// plain word → not a link
assert.strictEqual(file("hello"), null);
// number → not a link
assert.strictEqual(file("42"), null);
// bare extension with no name → not a link
assert.strictEqual(file(".js"), null);
// a URL is left to the web-links addon
assert.strictEqual(file("https://example.com/a.js"), null);

console.log("ok");
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node "<scratchpad>/test-links.mjs"`
Expected: FAIL — esbuild errors (`client/src/links.ts` not found) or import fails.

- [ ] **Step 3: Implement `client/src/links.ts`**

```ts
import type { Terminal, ILinkProvider, ILink } from "@xterm/xterm";

/** Called when the user clicks a file link; `open` POSTs to the server. */
type OpenFile = (path: string, line?: number) => void;

/**
 * Turn a whitespace-delimited token into a file link, or null if it isn't one.
 * A token qualifies only if it contains a "/" or ends in a file extension —
 * this keeps ordinary words from being underlined. A trailing ":line[:col]"
 * (Claude's usual "path:42" form) is parsed off; trailing sentence punctuation
 * is trimmed. `text` is the exact substring that became the link (a prefix of
 * `raw`), so the caller can place the link's cell range.
 */
export function parseFileLink(
  raw: string
): { file: string; line?: number; text: string } | null {
  // Drop trailing sentence punctuation ("foo.js).", "foo.js:9.") but keep a real :line.
  const cleaned = raw.replace(/[).,;'"\]}>]+$/, "");
  let file: string;
  let line: number | undefined;
  let text: string;
  const suffix = cleaned.match(/:(\d+)(?::\d+)?$/); // optional :line[:col] at the end
  if (suffix) {
    file = cleaned.slice(0, suffix.index);
    line = Number(suffix[1]);
    text = cleaned; // the link covers path + :line[:col]
  } else {
    file = cleaned.replace(/:+$/, ""); // drop a stray trailing colon ("see foo.js:")
    text = file;
  }
  if (!file) return null;
  if (/^[a-z][\w+.-]*:\/\//i.test(file)) return null; // URL scheme → web-links owns it
  const hasSlash = file.includes("/");
  const hasExt = /[\w-]\.[A-Za-z0-9]{1,8}$/.test(file); // a name char before the dot
  if (!hasSlash && !hasExt) return null;
  return { file, line, text };
}

class FileLinkProvider implements ILinkProvider {
  constructor(private term: Terminal, private open: OpenFile) {}

  provideLinks(y: number, cb: (links: ILink[] | undefined) => void): void {
    const bufLine = this.term.buffer.active.getLine(y - 1);
    if (!bufLine) return cb(undefined);
    // Keep trailing spaces so string indices line up with terminal columns.
    const text = bufLine.translateToString(false);
    const links: ILink[] = [];
    const tokenRe = /\S+/g;
    let m: RegExpExecArray | null;
    while ((m = tokenRe.exec(text))) {
      // Skip a leading opener like "(" or quote so the link range is tight.
      const lead = m[0].match(/^[([{<'"]+/);
      const off = lead ? lead[0].length : 0;
      const parsed = parseFileLink(m[0].slice(off));
      if (!parsed) continue;
      const startIdx = m.index + off; // 0-based string index of the link's first char
      links.push({
        text: parsed.text,
        // xterm columns are 1-based; end.x is the (inclusive) last cell.
        range: {
          start: { x: startIdx + 1, y },
          end: { x: startIdx + parsed.text.length, y },
        },
        activate: () => this.open(parsed.file, parsed.line),
      });
    }
    cb(links);
  }
}

/** Register the file-path link provider on a terminal. */
export function installFileLinks(term: Terminal, open: OpenFile): void {
  term.registerLinkProvider(new FileLinkProvider(term, open));
}
```

> Column mapping is index-based (1 char ≈ 1 cell). Wide glyphs (emoji) earlier on the same line can shift a link's underline by a cell; acceptable for v1 since file paths in Claude output are ASCII and usually on their own lines.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node "<scratchpad>/test-links.mjs"`
Expected: prints `ok`.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors. (Fix any TS issues in `links.ts` — e.g. the `suffix`/`text` non-null handling — before continuing.)

- [ ] **Step 6: Commit**

```bash
git add client/src/links.ts
git commit -m "feat(client): file-path link provider for xterm"
```

---

## Task 4: Wire addons into the terminal + add dependency

**Files:**
- Modify: `package.json` (add `@xterm/addon-web-links`)
- Modify: `client/src/terminal.ts` (imports, load addons after `open()`, `openFile` helper)

**Interfaces:**
- Consumes: `installFileLinks` from `./links`; `WebLinksAddon` from `@xterm/addon-web-links`; existing `POST /api/panes/:id/open`.

- [ ] **Step 1: Add the dependency**

Run: `npm install --save-dev @xterm/addon-web-links@^0.11.0`
Expected: `package.json` gains `@xterm/addon-web-links` under `devDependencies`; `package-lock.json`/`node_modules` update. (0.11.x pairs with xterm 5.5.)

- [ ] **Step 2: Add imports to `client/src/terminal.ts`**

After the existing addon imports (near line 3), add:

```ts
import { WebLinksAddon } from "@xterm/addon-web-links";
import { installFileLinks } from "./links";
```

- [ ] **Step 3: Load the addons after `term.open`**

In the constructor, immediately after `this.term.open(this.xtEl);` (line 114), add:

```ts
// Make URLs clickable (open in a new tab) and file paths clickable (open in
// an editor via the server). Must come after open() so the DOM layer exists.
this.term.loadAddon(new WebLinksAddon());
installFileLinks(this.term, (path, line) => this.openFile(path, line));
```

- [ ] **Step 4: Add the `openFile` helper method**

Add a private method to the `Term` class (e.g. just after `dropFiles`, near line 476):

```ts
/**
 * A file path was clicked in the terminal. Ask the server to open it in an
 * editor; the server resolves it against this pane's cwd and stats it, so a
 * bad match is a silent no-op. Any failure here is ignored on purpose.
 */
private openFile(path: string, line?: number) {
  fetch(`/api/panes/${this.id}/open`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, line }),
  }).catch(() => {});
}
```

- [ ] **Step 5: Typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: typecheck clean; Vite build succeeds and writes `dist/`.

- [ ] **Step 6: Manual smoke test**

Restart the server and refresh a browser tab:

Run: `npm run go`

Then in a live pane:
1. Print a URL: `echo "see https://example.com"` → the URL underlines on hover and opens in a new tab on click.
2. Print a real path with a line: `echo "server/index.js:42"` (from a pane whose cwd is this repo) → clicking opens it in your editor at line 42. Set `FLEET_EDITOR="code -g"` (or your editor) before `npm run go` if auto-detect doesn't pick your editor.
3. Print a bogus path: `echo "does/not/exist.js:9"` → clicking does nothing (silent no-op).

Expected: all three behave as described. If a click does nothing for a real file, check the server log and `FLEET_EDITOR`.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json client/src/terminal.ts
git commit -m "feat(client): wire clickable URLs and file paths into terminals"
```

---

## Self-Review Notes

- **Spec coverage:** URLs (Task 4 web-links) ✓; file-path matching (Task 3) ✓; resolve-against-cwd + stat + silent no-op (Task 2) ✓; editor resolution FLEET_EDITOR → detect → open (Task 1) ✓; `:line[:col]` parsing (Task 3) ✓.
- **Types:** `parseFileLink` shape `{ file, line?, text }` is consistent across Task 3 and its test; `openFile(path, line?)` matches the `OpenFile` type and the endpoint body `{ path, line }`.
- **`<scratchpad>`** in commands is a placeholder for the absolute scratchpad path in Global Constraints — substitute it when running.
