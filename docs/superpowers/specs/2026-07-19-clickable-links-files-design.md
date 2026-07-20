# Clickable links & file paths in terminal output — design

## Goal

Make URLs and file paths that appear in a FleetView terminal (typically Claude's
replies) clickable:

- **URLs** (`http://`, `https://`) → open in a new browser tab.
- **File paths** (e.g. `server/index.js:42`) → open the file in an editor, at the
  line number when one is present.

Nothing in the terminal is clickable today — no xterm link addon is loaded.

## Approach

### 1. URLs — `@xterm/addon-web-links`

Add the official `@xterm/addon-web-links` dependency and load it in the `Term`
constructor after `term.open()`. Its default handler opens matched http/https
links in a new tab. No custom code.

### 2. File paths — custom xterm link provider

A new client module `client/src/links.ts` registers a link provider on the xterm
instance (via `term.registerLinkProvider`). For each rendered line it regex-matches
path-shaped tokens and returns them as links (underlined on hover).

**What counts as a path (noise control).** A token is only offered as a link if it
either contains a `/` **or** ends in a known file extension. It may carry a trailing
`:line` or `:line:col` suffix (Claude's usual `path:42` / `path:42:5` form), which
is parsed off and passed to the open call. Leading `./`, `~/`, and absolute `/` are
supported.

**Optimistic matching.** No per-hover server validation — matching is regex-only, so
hovering is instant. Whether the file actually exists is checked on click.

### 3. Click → open in editor (server round-trip)

On click the client `POST`s `{ path, line }` to a new endpoint
`POST /api/panes/:id/open`. The server:

1. Looks up the pane's `cwd` (`ptys.info(id).cwd`); 404 if no such pane.
2. Resolves `path` against that `cwd` (absolute paths pass through; `~` expands to
   home).
3. `fs.stat`s the resolved path. If it is not an existing regular file → **silent
   no-op** (respond `204`, open nothing). This absorbs false-positive matches.
4. Otherwise opens it via the `server/open-file.js` helper and responds `204`.

The client ignores the response body either way (silent no-op on the UI side too).

### Editor resolution — `server/open-file.js`

A small helper `openInEditor(absPath, line)`:

1. **`FLEET_EDITOR` env override.** If set (e.g. `code -g`, `cursor -g`, `zed`,
   `subl`), split it into command + base args and spawn
   `cmd [...args] <target>`, where `<target>` is `absPath:line` when a line is
   given, else `absPath`.
2. **Auto-detect.** Else probe PATH (via the shell / `which`) for `code`, `cursor`,
   `zed`, `subl` in that order; use the first found, launched with its line-number
   syntax (`code -g file:line`, `cursor -g file:line`, `zed file:line`,
   `subl file:line`).
3. **Fallback.** Else macOS `open <file>` (no line jump).

The editor is spawned **detached** (`spawn(..., { detached: true, stdio: "ignore" })`
then `unref()`) so it never blocks or ties its lifetime to the server. GUI editors
are the target; terminal editors (vim/nvim) are intentionally unsupported because the
server has no terminal to attach them to.

## Security

The server already spawns arbitrary shells on localhost with no auth — reaching the
port is already RCE. Opening a file is strictly less capability than that, so this
adds no meaningful new exposure. The path is **not** sandboxed to the cwd subtree
(Claude legitimately prints absolute and parent-directory paths); the `fs.stat`
existence check is the only guard, and it exists to avoid acting on false-positive
matches, not as a security boundary. Binding stays `127.0.0.1` by default as before.

## Files touched

| File | Change |
|------|--------|
| `package.json` | + `@xterm/addon-web-links` dependency |
| `client/src/terminal.ts` | load web-links addon; call `installFileLinks(term, {...})` after `open()`; POST helper for opening files |
| `client/src/links.ts` | **new** — file-path link provider + regex + parse |
| `server/open-file.js` | **new** — `openInEditor(absPath, line)` with env/detect/fallback |
| `server/index.js` | **new** endpoint `POST /api/panes/:id/open` |

No changes to the tmux durability model, persistence, WebSocket protocol, or
attention/hook flow.

## Testing (per project conventions — no committed tests)

- Throwaway Node script exercising `server/open-file.js` resolution: with
  `FLEET_EDITOR` set, with it unset (detect), and the `open` fallback — assert the
  spawned argv without actually launching an editor (inject/stub the spawn).
- Manual: build, refresh a browser tab, have a pane print a URL and a `file:line`
  path; click each; confirm the browser tab opens and the editor jumps to the line.
- Manual false-positive: click a path-shaped token that doesn't exist; confirm
  nothing happens.
