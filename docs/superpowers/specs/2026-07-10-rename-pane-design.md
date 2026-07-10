# Click-to-edit terminal names — design

**Date:** 2026-07-10
**Status:** approved by user ("good to build it that way? — yes")

## Goal

Click the folder name in a box's title bar to give the terminal a custom name.
The name replaces the cwd basename everywhere that identity appears, persists,
and syncs to every open window.

## Behavior

- **Edit:** clicking the title text swaps it for an inline text input,
  prefilled with the current display name, text selected. Enter or blur saves;
  Esc cancels. Saving an empty string clears the custom name, reverting the
  display to the cwd basename.
- **Display:** `name || basename(cwd)` on the box title, top-bar attention
  chips, tray chips (minimized boxes), the zoom/tab title, the layout-replace
  list, and the recovery bar (dormant panes). The box-title tooltip stays the
  full cwd.
- **Interaction carve-outs:** clicking the name no longer zooms the box
  (everywhere else on the box still does). The title bar remains the drag
  handle, but a pointer-down on the name/input never starts a drag —
  otherwise selecting text in the input would fling the box around.
  Esc inside the input must not un-zoom a zoomed box.

## Architecture (mirrors the existing color-tint feature)

- **`server/pty-manager.js`:** pane metadata gains `name` (trimmed, capped at
  60 chars, default `""`). Included in `info()`, `_dormantInfo()`, persisted
  in `_persistState()`, restored in `_restore()`. New `setName(id, name)`.
- **`server/index.js`:** `POST /api/panes/:id/name {name}` → `setName` →
  broadcast `{t:"renamed", pane, name}` to the pane's session windows
  (identical shape to `/color`).
- **`client/src/terminal.ts`:** `PaneInfo.name?`; `displayName(info)` helper
  (exported); `setName()` on Term (optimistic update, like color); the
  click-to-edit input.
- **`client/src/main.ts`:** all `basenameOf(info.cwd)` display sites switch to
  `displayName(info)`; control-socket handler for `renamed` updates the Term
  and any visible chip/tray text; drag start ignores pointerdowns on
  `.path`/the rename input.
- **`client/src/styles.css`:** the rename input styled to sit flush in the
  title bar; `cursor: text` on the title text as the edit affordance.

## Testing

Live-server drive on a scratch pane: POST a name → info shows it; empty name
→ reverts; >60 chars → capped; server restart → name survives; `renamed`
broadcast observed on a `/control` socket. Manual: click-edit in the UI,
drag-by-title still works, Esc cancels without un-zooming.
