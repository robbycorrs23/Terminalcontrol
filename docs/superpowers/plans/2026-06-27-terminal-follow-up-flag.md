# Terminal Follow-up Flag Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a sticky, user-controlled "follow-up" flag to each terminal box, with a steady visual marker and a top-bar chip list to jump back to flagged terminals.

**Architecture:** The flag mirrors the existing `attention` pane state end-to-end: server-side pane field persisted to `sessions.json`, mutated via a REST route, broadcast over the per-session control WebSocket, and rendered by the client both on the box (border + active button) and as a clickable chip strip in the top bar. It is independent of and stacks with the automatic attention/waiting system.

**Tech Stack:** Node + Express + `ws` (server), TypeScript + xterm + Vite (client), plain CSS. No test framework exists in this repo; verification is type-checking (`npx tsc --noEmit`) plus a bundle (`npm run build`) plus manual smoke testing through `npm run go`.

## Global Constraints

- Follow the existing `attention`/`cleared` patterns exactly — do not introduce new abstractions.
- Flag state is on/off only. No notes, labels, counts, timers, sounds, or notifications.
- Flag is scoped to the owning window/session, like all other pane state.
- Flag must be visually distinct from the pulsing yellow `waiting` / green `done` glow: steady, non-animated, purple (`--flag`).
- Verification commands: `npx tsc --noEmit -p tsconfig.json` (type-checks `client/src` — `vite build` alone does NOT type-check, it strips types via esbuild) and `npm run build` (bundles). Do not start a long-running server inside an automated step.
- This repo is **not** a git repository. If `git status` errors, skip the commit step of each task and instead note completion; do not run `git init` unless the user asks.

---

### Task 1: Server — flag as persisted pane state

**Files:**
- Modify: `server/pty-manager.js` (`create`, `_restore`, `_persistState`, `info`, add `setFollowUp`)
- Modify: `server/index.js` (add `POST /api/panes/:id/followup` route)

**Interfaces:**
- Produces: `ptys.setFollowUp(id, on)` → void (persists state). `info(id)` now returns an object including `followUp: boolean`. Route `POST /api/panes/:id/followup` with JSON body `{ on: boolean }` → `204`, or `404 {error}` if no such pane. Control-socket broadcast message shape: `{ t: "followup", pane: <id>, on: <boolean> }`.

- [ ] **Step 1: Add `followUp` to the pane object in `create()`**

In `server/pty-manager.js`, inside `create({ cwd, cmd, session })`, the `pane` object literal currently ends with `attention: { waiting: false, kind: null }, createdAt: Date.now(),`. Add the field:

```js
    const pane = {
      id,
      cwd: dir,
      cmd: startup,
      session: session || null,
      order: this.seq++,
      pty: null,
      buffer: "",
      clients: new Set(),
      attention: { waiting: false, kind: null },
      followUp: false,
      createdAt: Date.now(),
    };
```

- [ ] **Step 2: Seed `followUp` from saved state in `_restore()`**

In the `pane` object built inside `_restore()`'s loop, add `followUp` seeded from the saved record `m`:

```js
      const pane = {
        id: m.id,
        cwd: m.cwd,
        cmd: m.cmd,
        session: m.session || null,
        order: m.order ?? this.seq,
        pty: null,
        buffer: "",
        clients: new Set(),
        attention: { waiting: false, kind: null },
        followUp: !!m.followUp,
        createdAt: m.createdAt || Date.now(),
      };
```

- [ ] **Step 3: Persist `followUp` in `_persistState()`**

In `_persistState()`, the mapped record currently has `id, session, order, cwd, cmd, createdAt`. Add `followUp`:

```js
    const data = [...this.panes.values()].map((p) => ({
      id: p.id,
      session: p.session,
      order: p.order,
      cwd: p.cwd,
      cmd: p.cmd,
      followUp: p.followUp,
      createdAt: p.createdAt,
    }));
```

- [ ] **Step 4: Include `followUp` in `info()`**

In `info(id)`, add `followUp` to the returned object:

```js
    return {
      id: p.id,
      cwd: p.cwd,
      cmd: p.cmd,
      session: p.session,
      attention: p.attention,
      followUp: p.followUp,
      createdAt: p.createdAt,
    };
```

- [ ] **Step 5: Add the `setFollowUp` method**

Add this method to `PtyManager`, immediately after `clearAttention(id)`:

```js
  setFollowUp(id, on) {
    const pane = this.panes.get(id);
    if (!pane) return;
    pane.followUp = !!on;
    this._persistState();
  }
```

- [ ] **Step 6: Add the REST route**

In `server/index.js`, immediately after the `app.post("/api/panes/:id/clear", ...)` handler, add:

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

- [ ] **Step 7: Sanity-check the server parses**

Run: `node --check server/pty-manager.js && node --check server/index.js`
Expected: no output, exit 0 (both files are syntactically valid).

- [ ] **Step 8: Commit**

```bash
git add server/pty-manager.js server/index.js
git commit -m "feat(server): persist and expose per-pane follow-up flag"
```

---

### Task 2: Client terminal box — flag toggle button + marker

**Files:**
- Modify: `client/src/terminal.ts` (`PaneInfo`, `TermHost`, title-bar markup, methods, constructor seeding)

**Interfaces:**
- Consumes: `PaneInfo.followUp?: boolean` from the server snapshot (Task 1).
- Produces: `TermHost.onToggleFollowUp(t: Term): void` (host implements in Task 4). `Term.isFlagged(): boolean`. `Term.setFollowUp(on: boolean): void` — toggles the `.flagged` class on `this.el` and the `.active` class on the title-bar `.flag` button.

- [ ] **Step 1: Add `followUp` to `PaneInfo`**

In `client/src/terminal.ts`, add the optional field to the `PaneInfo` interface:

```ts
export interface PaneInfo {
  id: string;
  cwd: string;
  cmd: string;
  attention?: { waiting: boolean; kind: "question" | "done" | null };
  followUp?: boolean;
  createdAt: number;
}
```

- [ ] **Step 2: Add `onToggleFollowUp` to `TermHost`**

```ts
export interface TermHost {
  onOpen(t: Term): void; // user clicked the box → zoom it
  onClose(t: Term): void; // × → kill it
  onMinimize(t: Term): void; // – → send to tray
  onToggleFollowUp(t: Term): void; // 🚩 → toggle the follow-up flag
}
```

- [ ] **Step 3: Add the 🚩 button to the title bar**

In the constructor's `this.titleBar.innerHTML = ...` template, add a `flag` control **before** the `min` button:

```ts
    this.titleBar.innerHTML =
      `<span class="dot">●</span>` +
      `<span class="path"></span>` +
      `<span class="badge-slot"></span>` +
      `<span class="spacer"></span>` +
      `<button class="ctl img" title="Add image to prompt">🖼</button>` +
      `<button class="ctl flag" title="Mark for follow-up">🚩</button>` +
      `<button class="ctl min" title="Minimize">–</button>` +
      `<button class="ctl close" title="Close">✕</button>`;
```

- [ ] **Step 4: Wire the button's click handler**

Next to the existing `.min` / `.close` click handlers in the constructor, add:

```ts
    this.titleBar.querySelector(".flag")!.addEventListener("click", (e) => {
      e.stopPropagation();
      host.onToggleFollowUp(this);
    });
```

- [ ] **Step 5: Add `isFlagged` and `setFollowUp` methods**

Add these methods to the `Term` class, near `isWaiting()` / `setWaiting()`:

```ts
  isFlagged() {
    return this.el.classList.contains("flagged");
  }

  setFollowUp(on: boolean) {
    this.el.classList.toggle("flagged", on);
    (this.titleBar.querySelector(".flag") as HTMLElement)?.classList.toggle("active", on);
  }
```

- [ ] **Step 6: Seed the box from initial state in the constructor**

At the end of the constructor, after the existing `if (info.attention?.waiting ...)` block, add:

```ts
    if (info.followUp) this.setFollowUp(true);
```

- [ ] **Step 7: Type-check**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: the ONLY error is in `main.ts` — `Property 'onToggleFollowUp' is missing in type ... but required in type 'TermHost'` (the `host` literal doesn't satisfy the widened interface yet). This is fixed in Task 4. There must be **no** error originating in `terminal.ts` itself.

- [ ] **Step 8: Commit**

```bash
git add client/src/terminal.ts
git commit -m "feat(client): add follow-up toggle button and state to terminal box"
```

---

### Task 3: Top-bar markup + CSS

**Files:**
- Modify: `client/index.html` (add `#followups` strip)
- Modify: `client/src/styles.css` (flag color var, `.term.flagged`, `.ctl.flag.active`, `#followups`, `.fchip`, `body.big .fchip`)

**Interfaces:**
- Produces: a `#followups` element in the top bar (queried by `main.ts` in Task 4). CSS classes `.term.flagged`, `.ctl.flag.active`, `.fchip`.

- [ ] **Step 1: Add the `#followups` strip to the top bar**

In `client/index.html`, find the existing `#queue` element in the top bar. Add a sibling `#followups` span immediately after it:

```html
        <span id="queue"></span>
        <span id="followups"></span>
```

(Match the surrounding indentation. If `#queue` and the `nextBtn` are grouped in a container, place `#followups` adjacent to `#queue` inside the same container.)

- [ ] **Step 2: Define the `--flag` color variable**

In `client/src/styles.css`, find the `:root` block that defines `--waiting` and `--done`. Add a flag color:

```css
  --flag: #a371f7;
```

If there is a `body.light` block that overrides `--waiting`/`--done`, add `--flag: #8250df;` there too so it reads on a light background.

- [ ] **Step 3: Style the flagged box (steady, non-animated)**

Add after the `.term.waiting.done .badge { ... }` rule (and before the `@keyframes pulse`):

```css
/* Follow-up flag: a steady, non-animated purple marker. Distinct from the
   pulsing attention glow, and left intact when a box is also waiting. */
.term.flagged {
  border-color: var(--flag);
  box-shadow: 0 0 0 1px var(--flag);
}
/* When a box is both flagged and waiting, the animated attention glow wins the
   ring; the flag stays identifiable via the active title-bar button. */
.term.flagged.waiting {
  border-color: var(--waiting);
}
.term.flagged.waiting.done {
  border-color: var(--done);
}
```

- [ ] **Step 4: Style the active flag button**

Add near the `.term .ctl.close:hover` rule:

```css
.term .ctl.flag.active {
  background: var(--flag);
  color: #000;
}
.term .ctl.flag.active:hover {
  background: var(--flag);
  color: #000;
}
```

- [ ] **Step 5: Style the top-bar follow-up strip + chips**

Add after the `.qchip.done { ... }` rule:

```css
/* ---- Follow-up chips ---- */
#followups {
  display: flex;
  gap: 6px;
}
.fchip {
  background: var(--flag);
  color: #000;
  border-radius: 10px;
  padding: 1px 9px;
  font-size: 11px;
  font-weight: 700;
  cursor: pointer;
}
```

- [ ] **Step 6: Include `.fchip` in the large-text rule**

Find the `body.big` rule that lists `.qchip` (near the top of the file). Add `.fchip` to that selector list so large-text mode bumps both:

```css
body.big .qchip,
body.big .fchip {
```

(Append `.fchip` to whatever the existing `body.big .qchip` selector group is, preserving the other selectors in that group.)

- [ ] **Step 7: Verify it bundles**

Run: `npm run build`
Expected: `vite build` succeeds (esbuild does not type-check, so the pending `main.ts` type gap does not block it). No CSS/HTML parse errors.

- [ ] **Step 8: Commit**

```bash
git add client/index.html client/src/styles.css
git commit -m "feat(client): add follow-up strip markup and steady flag styling"
```

---

### Task 4: Client orchestration — host callback, strip rendering, control message

**Files:**
- Modify: `client/src/main.ts` (host callback, `flagged` set, `setFlagged`/`renderFollowups`, `addTerm`/`removeTerm`, control `onmessage`)

**Interfaces:**
- Consumes: `Term.isFlagged()`, `Term.setFollowUp(on)` (Task 2); `#followups` element + `.fchip` class (Task 3); `POST /api/panes/:id/followup` + `{t:"followup", pane, on}` broadcast (Task 1).
- Produces: complete wiring; this task removes the `onToggleFollowUp` type error and makes the feature functional end-to-end.

- [ ] **Step 1: Grab the `#followups` element and a `flagged` set**

Near the top of `main.ts`, next to `const queueEl = document.getElementById("queue")!;`, add:

```ts
const followupsEl = document.getElementById("followups")!;
```

And next to `const minimized = new Set<string>();`, add:

```ts
const flagged = new Set<string>(); // pane ids marked for follow-up
```

- [ ] **Step 2: Implement the host callback**

In the `host: TermHost = { ... }` object, add `onToggleFollowUp`:

```ts
  onToggleFollowUp: (t) => {
    const on = !t.isFlagged();
    t.setFollowUp(on); // optimistic; server broadcast confirms
    setFlagged(t.id, on);
    fetch(`/api/panes/${t.id}/followup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ on }),
    });
  },
```

- [ ] **Step 3: Add `setFlagged` and `renderFollowups`**

Add these functions (near the attention-queue helpers `enqueue`/`renderQueue` is a natural home):

```ts
function setFlagged(id: string, on: boolean) {
  if (on) flagged.add(id);
  else flagged.delete(id);
  renderFollowups();
}

function renderFollowups() {
  followupsEl.innerHTML = "";
  for (const id of flagged) {
    const t = terms.get(id);
    if (!t) continue;
    const chip = document.createElement("span");
    chip.className = "fchip";
    chip.textContent = basenameOf(t.info.cwd);
    chip.title = "Follow-up — click to jump";
    chip.onclick = () => zoom(t);
    followupsEl.append(chip);
  }
}
```

- [ ] **Step 4: Seed flags in `addTerm`**

In `addTerm(info)`, next to the existing `if (info.attention?.waiting) enqueue(...)` line, add:

```ts
    if (info.followUp) setFlagged(info.id, true);
```

(The `Term` itself already renders its border/button from `info.followUp` via its constructor; this line registers it in the top-bar strip.)

- [ ] **Step 5: Clear flags in `removeTerm`**

In `removeTerm(id)`, next to the existing `minimized.delete(id);` line, add:

```ts
    flagged.delete(id);
    renderFollowups();
```

- [ ] **Step 6: Handle the `followup` control message**

In `connectControl()`'s `ws.onmessage` switch, add a case (e.g. after the `cleared` case):

```ts
      case "followup": {
        const t = terms.get(m.pane);
        if (t) t.setFollowUp(m.on);
        setFlagged(m.pane, m.on);
        break;
      }
```

- [ ] **Step 7: Type-check and bundle clean**

Run: `npx tsc --noEmit -p tsconfig.json && npm run build`
Expected: both succeed with **no** errors (the `onToggleFollowUp` member now satisfies `TermHost`).

- [ ] **Step 8: Commit**

```bash
git add client/src/main.ts
git commit -m "feat(client): wire follow-up toggle, top-bar strip, and broadcast"
```

---

### Task 5: Manual verification

**Files:** none (verification only).

This is a local TUI tool with no automated test harness; verify behavior by running the app.

- [ ] **Step 1: Build and start**

Run: `npm run go` and open `http://localhost:4280`. Open at least two terminals.

- [ ] **Step 2: Toggle on**

Click 🚩 on a box. Expected: the box border turns steady purple (no pulsing), the 🚩 button shows a filled/active background, and a purple chip with the folder name appears in the top bar.

- [ ] **Step 3: Jump via chip**

Click the purple chip in the top bar. Expected: that terminal zooms to center.

- [ ] **Step 4: Toggle off**

Click 🚩 again. Expected: border returns to normal, button de-activates, and the chip disappears from the top bar.

- [ ] **Step 5: Persistence across refresh**

Flag a box, then reload the page. Expected: the box comes back flagged (purple border + active button) and its chip is present in the top bar — proving the server-side state restored.

- [ ] **Step 6: Stacks with attention**

With a box flagged, trigger an attention event (e.g. let a `claude` in it ask a question, or POST `/hook` with that pane id). Expected: the box pulses yellow for attention while still reading as flagged; after clearing attention (open/zoom it), the purple flag border + active button remain.

- [ ] **Step 7: Minimize + close behavior**

Minimize a flagged box → its top-bar chip still restores+zooms it when clicked. Close a flagged box → its chip disappears, and after a refresh there is no stale chip.

- [ ] **Step 8: Commit (docs/notes only, if any)**

If you updated the README to mention the feature, commit it:

```bash
git add README.md
git commit -m "docs: note the follow-up flag in the README"
```

(If no doc changes were made, skip this step.)

---

## Notes for the implementer

- The exact location of the `:root` / `body.light` color variables, the `#queue` markup, and the `body.big` selector group must be confirmed by reading the file before editing — the steps above describe the anchor, not a line number, because surrounding code may shift.
- Do not add a separate flag *badge* element in the title `badge-slot`; that slot is owned by the attention system. The flag's in-title indicator is the active 🚩 button, per the approved design.
- Keep `renderFollowups()` iteration order = `Set` insertion order; that is fine and matches the attention queue's behavior.
