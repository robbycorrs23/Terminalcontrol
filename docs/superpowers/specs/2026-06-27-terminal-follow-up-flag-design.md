# Mark a terminal for follow-up

## Goal

Let the user mark any terminal box for follow-up. The flag is **user-controlled
and sticky**: it turns on with a click and stays on until the user turns it off
(or closes the terminal). It is entirely independent of the existing *automatic*
"needs you / done" attention system, and must be visually distinct from it.

Confirmed decisions:
- **Jump affordance:** flagged terminals collect as clickable chips in a top-bar
  strip (mirrors the existing attention `#queue`), so they can be found and
  jumped to even when minimized or scrolled off-screen.
- **Visual style:** a steady (non-animated) accent border + an active 🚩 button
  in the title bar.
- **Persistence:** stored as pane state on the server, written to
  `sessions.json`, so it survives page refresh and server restart. Scoped to the
  window/session that owns the terminal, like all other pane state.

## Non-goals (YAGNI)

- No notifications, sounds, or badges-with-counts.
- No auto-expiry / timers.
- No notes, labels, colors, or priorities on the flag — strictly on/off.

## Architecture

The flag follows the **exact same shape** as the existing `attention` state so it
slots into the established patterns (server state → persistence → broadcast →
control-socket message → client render).

### 1. Server: flag as pane state

**`server/pty-manager.js`**
- Add `followUp: false` to the pane object in both `create()` and the restore
  branch of `_restore()`. In `_restore()`, seed it from the saved record:
  `followUp: !!m.followUp`.
- Add `followUp: p.followUp` to the persisted record in `_persistState()`.
- Add `followUp: p.followUp` to the object returned by `info(id)`.
- New method:
  ```js
  setFollowUp(id, on) {
    const pane = this.panes.get(id);
    if (!pane) return;
    pane.followUp = !!on;
    this._persistState();
  }
  ```
  (No event emit needed — the route broadcasts directly, matching how
  `clearAttention` is handled by the route rather than an emitter.)

**`server/index.js`**
- New route:
  ```js
  app.post("/api/panes/:id/followup", (req, res) => {
    const id = req.params.id;
    if (!ptys.info(id)) return res.status(404).json({ error: "no such pane" });
    const on = !!(req.body && req.body.on);
    ptys.setFollowUp(id, on);
    broadcast(ptys.sessionOf(id), { t: "followup", pane: id, on });
    res.status(204).end();
  });
  ```

### 2. Client: per-box marker

**`client/src/terminal.ts`**
- Extend `PaneInfo` with `followUp?: boolean`.
- Extend `TermHost` with `onToggleFollowUp(t: Term): void`.
- Add a 🚩 button to the title-bar control group, placed **before** the `–`
  minimize button:
  `<button class="ctl flag" title="Mark for follow-up">🚩</button>`.
  Wire its click (with `stopPropagation`) to `host.onToggleFollowUp(this)`.
- Add methods:
  ```js
  isFlagged() { return this.el.classList.contains("flagged"); }
  setFollowUp(on) {
    this.el.classList.toggle("flagged", on);
    this.titleBar.querySelector(".flag").classList.toggle("active", on);
  }
  ```
- In the constructor, after building the DOM, apply the initial state:
  `if (info.followUp) this.setFollowUp(true);`

### 3. Client: top-bar jump list + wiring

**`client/index.html`**
- Add `<span id="followups"></span>` in the top bar next to `#queue`.

**`client/src/main.ts`**
- Grab `const followupsEl = document.getElementById("followups")!;`.
- Track `const flagged = new Set<string>();` (pane ids).
- Implement the host callback:
  ```js
  onToggleFollowUp: (t) => {
    const on = !t.isFlagged();
    t.setFollowUp(on);            // optimistic
    setFlagged(t.id, on);
    fetch(`/api/panes/${t.id}/followup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ on }),
    });
  },
  ```
- `setFlagged(id, on)`: add/remove from the `flagged` set and re-render the strip.
- `renderFollowups()`: rebuild `#followups` from `flagged`, one `.fchip` per id
  showing `basenameOf(t.info.cwd)`; clicking a chip calls `zoom(t)`. Hide the
  strip when empty (same approach as the attention queue / `nextBtn`).
- In `addTerm()`, seed from the snapshot: `if (info.followUp) { term flagged on +
  setFlagged }`. (The `Term` already renders its own border/button from
  `info.followUp`; `addTerm` just needs to register it in the strip.)
- In `removeTerm()`, `flagged.delete(id)` and re-render the strip.
- In the control-socket `onmessage` switch, add:
  ```js
  case "followup": {
    const t = terms.get(m.pane);
    if (t) t.setFollowUp(m.on);
    setFlagged(m.pane, m.on);
    break;
  }
  ```

### 4. Styling

**`client/src/styles.css`**
- Define a flag color CSS var (both dark and light themes if applicable):
  `--flag: #a371f7;`.
- `.term.flagged` — steady border + soft ring, **no animation**:
  `border-color: var(--flag); box-shadow: 0 0 0 1px var(--flag);`
  This must not override the pulsing `.waiting` glow when both apply — `.waiting`
  rules are more specific/animated and should win for the ring while the flag
  remains identifiable via the title-bar button. (Verify visually that a box
  which is both flagged and waiting still reads correctly.)
- `.term .ctl.flag.active` — filled/active look:
  `background: var(--flag); color: #000;` (and keep it visible on hover).
- `#followups` — `display: flex; gap: 6px;` (mirror `#queue`).
- `.fchip` — purple chip mirroring `.qchip` but using `var(--flag)`:
  `background: var(--flag); color: #000; border-radius: 10px; padding: 1px 9px;
  font-size: 11px; font-weight: 700; cursor: pointer;`.
- Add `.fchip` to the `body.big` font-size bump rule alongside `.qchip`.

## Data flow

```
user clicks 🚩
  → terminal.ts host.onToggleFollowUp
  → main.ts: optimistic setFollowUp + setFlagged, POST /api/panes/:id/followup
  → server: setFollowUp() persists to sessions.json
  → server: broadcast {t:"followup", pane, on} to the owning session
  → every window for that session: control socket → setFollowUp + setFlagged
refresh / reconnect
  → server _restore() reads followUp from sessions.json
  → control socket sends {t:"panes", panes:[...info with followUp...]}
  → addTerm() seeds box border/button + strip chip
```

## Testing / verification

This is a small UI feature on a local tool with no existing automated test
harness. Verify manually after building (`npm run go`):

1. Click 🚩 on a box → border turns steady purple, button goes active, a purple
   chip appears in the top bar.
2. Click the chip → that terminal zooms to center.
3. Click 🚩 again → border/button/chip all clear.
4. Refresh the page → flagged terminals come back flagged (border + button +
   chip) from server state.
5. Trigger an attention event (Claude needs-you) on a flagged box → it pulses
   yellow for attention while still reading as flagged; clearing attention
   leaves the flag intact.
6. Minimize a flagged box → its top-bar chip still works to restore+zoom it.
7. Close a flagged box → its chip disappears; no stale entry after refresh.
```
