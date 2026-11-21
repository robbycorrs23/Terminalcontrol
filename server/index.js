import express from "express";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { fileURLToPath } from "node:url";
import { basename, dirname, join, extname, resolve } from "node:path";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, statSync, existsSync, unlinkSync, chmodSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { PtyManager } from "./pty-manager.js";
import { AgentManager } from "./agent-manager.js";
import { createRegistry } from "./pane-registry.js";
import * as machine from "./machine-config.js";
import { SecretVault } from "./secret-vault.js";
import { gateConfigured, verifyStepUpToken } from "./step-up-token.js";
import { collectSnapshot, saveSnapshot, SNAPSHOT_DIR } from "./snapshot.js";
import { openInEditor, openFolder } from "./open-file.js";
import { findPathLinks } from "./path-links.js";
import { LayoutStore } from "./layout-store.js";
import { TaskStore } from "./task-store.js";
import { PushStore } from "./push-store.js";
import { VapidKeys } from "./push-vapid.js";
import { createSender } from "./push-send.js";
import { createPushNotifier } from "./push-notifier.js";
import { createIdentity, ICON_COLORS } from "./identity.js";
import { SshProfileStore } from "./ssh-profiles.js";
import { listSshConfigHosts } from "./ssh-hosts.js";
import { UsageMonitor } from "./usage-monitor.js";
import { normalizeCodexSnapshot, normalizeClaudeEvent } from "./usage.js";
import { ensureHooks } from "./setup-hooks.js";
import { ensureCodexHooks } from "./setup-codex-hooks.js";
import { listDirs, makeDir } from "./fs-browse.js";
import { preflight } from "../scripts/preflight.js";

// Check for tmux / curl / claude / codex FIRST, so any missing-dependency warning is the
// most prominent thing the user sees — not buried under later startup logs.
preflight({ quietIfOk: true });

const PORT = Number(process.env.FLEET_PORT) || 4280;
// Bind to loopback by default. This server spawns REAL shells with NO auth, so a
// process that can reach the port can run arbitrary commands on this machine —
// it must never be exposed to the network casually. Opt in explicitly (e.g.
// FLEET_HOST=0.0.0.0) only on a trusted/firewalled network, and understand the risk.
const HOST = process.env.FLEET_HOST || "127.0.0.1";
const isLoopback = HOST === "127.0.0.1" || HOST === "::1" || HOST === "localhost";
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DIST = join(ROOT, "dist");

// Make sure Claude Code / Codex know how to phone home before any terminal starts.
ensureHooks(PORT);
// A second Claude Code account (the "claude (work)" picker option) reads its own
// settings.json from an isolated CLAUDE_CONFIG_DIR — only install hooks there if
// that directory already exists, so machines that never set up a work account
// don't get a ~/.claude-work directory created out of nowhere.
const workConfigDir = join(homedir(), ".claude-work");
if (existsSync(workConfigDir)) ensureHooks(PORT, workConfigDir);
ensureCodexHooks(PORT);
// Same idea for a second Codex account (the "codex (work)" picker option):
// only install hooks into ~/.codex-work if that directory already exists, so
// machines that never set up a work account don't get one created out of nowhere.
const codexWorkConfigDir = join(homedir(), ".codex-work");
if (existsSync(codexWorkConfigDir)) ensureCodexHooks(PORT, codexWorkConfigDir);

const ptys = new PtyManager(PORT, join(ROOT, "sessions.json"));
// SDK-driven "chat" panes (see the plan) — `broadcast` is a hoisted function
// declaration (defined further down), safe to pass here since AgentManager
// only calls it later, never during construction.
const agents = new AgentManager(join(ROOT, "agent-sessions.json"), broadcast);
// Façade over the two pane managers. Route handlers below call `registry.*`
// wherever the operation is generic pane metadata; `ptys.*`/`agents.*` stay
// direct only for the kind-specific surface (`attach`, `tmux`, `on()` for
// ptys) the registry deliberately doesn't cover.
const registry = createRegistry(ptys, agents);

// Ephemeral, per-pane secrets ("give Claude a code without it ending up in the
// transcript") — see secret-vault.js for the full model. Works for both PTY
// (tmux env injection) and agent/chat (temp file + one chat message) panes.
const secrets = new SecretVault(ptys, agents, join(ROOT, "pane-secrets.json"));
secrets.restore();

// --- Subscription limit monitor ----------------------------------------
// Reading limits costs nothing (verified: no tokens, no quota — see usage.js),
// so this polls on a timer AND takes free pushes from live drivers. Rows are
// per ACCOUNT, not per pane: ten claude boxes share one 5-hour bucket.
const usage = new UsageMonitor(broadcastAll, (row, window) => {
  broadcastAll({
    t: "usage-reset",
    account: row.id,
    label: row.label,
    window: window.label,
    resetsAt: window.resetsAt,
  });
  console.log(`[fleetview] ${row.label}: fresh ${window.label} window`);
});
// Live limit updates ride along with work the panes were doing anyway. The key
// is the pane's cmd, which is exactly the account id the monitor uses.
agents.onRateLimit = (accountId, data) => {
  const win = accountId.startsWith("codex")
    ? normalizeCodexSnapshot(data)?.primary
    : normalizeClaudeEvent(data);
  if (win) usage.applyPush(accountId, win);
};
const layouts = new LayoutStore(join(ROOT, "layouts.json"));
const tasks = new TaskStore(join(ROOT, "tasks.json"));
// User-added SSH server profiles (key/agent auth only — see ssh-profiles.js).
// Never contains password/secret material, so unlike pane-secrets.json this
// is safe to keep as a plain JSON file alongside layouts/tasks.
const sshProfiles = new SshProfileStore(join(ROOT, "ssh-profiles.json"));
// Web Push state lives in ~/.fleetview/ at 0600, not here in the repo root: a
// push endpoint is a capability URL and the VAPID private key can mint messages
// to your devices, so both belong with passkeys.json rather than layouts.json.
const FLEET_DIR = join(homedir(), ".fleetview");
const pushStore = new PushStore(join(FLEET_DIR, "push-subscriptions.json"));
const vapid = new VapidKeys(join(FLEET_DIR, "vapid.json"));
// Which machine this is, for the app name / icon colour / in-app label. Reads
// from DIST because that's where vite copies client/public/icons/.
const identity = createIdentity(DIST);
// The loud "tmux missing" warning is handled by preflight() above; here we just
// confirm the durable path when it IS available.
if (ptys.tmux) console.log("[fleetview] tmux-backed terminals — they survive server restarts.");

// Grid events go to EVERY open window — see the "one workspace per machine"
// note in pane-registry.js. The `session` argument is kept because callers all
// have one to hand and it still identifies the pane's owner for secret release,
// but it no longer selects an audience: a phone and a laptop looking at the
// same FleetView are looking at the same fleet, so they must see the same
// events. (broadcastAll below is now equivalent; it's kept for the handful of
// call sites that never had a session to pass.)
const controlClients = new Set();
// Assigned just below, once broadcast/broadcastAll are defined. Declared here
// (rather than constructed inline) so that broadcast() — which is hoisted and
// handed to AgentManager well above this line — can never hit a temporal dead
// zone if something ever broadcasts during startup.
let pushes = null;
function broadcast(session, msg) {
  const s = JSON.stringify(msg);
  for (const ws of controlClients) {
    try {
      ws.send(s);
    } catch {}
  }
  // Web Push piggybacks here, and this spot is deliberate: it is the ONLY
  // choke point that sees attention from both pane kinds. PTY panes arrive via
  // ptys.on("attention") below, but agent/chat panes call broadcast() directly
  // from agent-manager.js, so hooking the emitter would miss every chat pane.
  // Fire-and-forget — never await, this function is hot for `work` events on a
  // pane streaming megabytes.
  if (msg && msg.t === "attention") {
    try {
      pushes?.onAttention(msg.pane, msg.kind, session);
    } catch (e) {
      console.warn(`[fleetview] push notify failed: ${e.message}`);
    }
  }
}
// Layouts are global (shared across windows), so their changes go to everyone.
function broadcastAll(msg) {
  const s = JSON.stringify(msg);
  for (const ws of controlClients) {
    try {
      ws.send(s);
    } catch {}
  }
}
// "Only while I'm here" (see secret-vault.js) has to survive the client
// deliberately dropping its own control socket: main.ts re-opens it on wake
// from sleep, on `online`, on bfcache restore, and whenever a hidden tab's
// throttled heartbeat looks like a suspend. A close is therefore NOT proof the
// window is gone — so hold injected secrets for a grace period and only expire
// them if no control socket for that session comes back. Anything shorter
// silently ate 15-minute secrets seconds after they were set.
const SESSION_GRACE_MS = 45_000;
const pendingSecretRelease = new Map(); // session -> timer

function sessionIsConnected(session) {
  for (const ws of controlClients) if (ws.fleetSession === session) return true;
  return false;
}
function cancelSecretRelease(session) {
  const t = pendingSecretRelease.get(session);
  if (t) clearTimeout(t);
  pendingSecretRelease.delete(session);
}
function scheduleSecretRelease(session) {
  if (session == null) return;
  cancelSecretRelease(session);
  // Another socket for this window is still open (two tabs sharing a
  // ?session=, or a reconnect that raced ahead of this close) — nothing to do.
  if (sessionIsConnected(session)) return;
  const t = setTimeout(() => {
    pendingSecretRelease.delete(session);
    if (sessionIsConnected(session)) return; // it came back
    secrets.releaseAllForSession(session);
  }, SESSION_GRACE_MS);
  t.unref?.();
  pendingSecretRelease.set(session, t);
}

// Web Push fan-out, now that broadcast() and the stores all exist.
pushes = createPushNotifier({
  registry,
  prefs: () => layouts.prefs(),
  store: pushStore,
  send: createSender(vapid),
});

ptys.on("attention", (pane, kind) => broadcast(registry.sessionOf(pane), { t: "attention", pane, kind }));
// A pane started/stopped working (see PtyManager's work-detection notes). Edge-
// triggered, so this is cheap even while a pane is streaming output.
ptys.on("work", (pane, on) => broadcast(registry.sessionOf(pane), { t: "work", pane, on }));
ptys.on("exit", (pane, session) => broadcast(session, { t: "closed", pane }));
// A pane's tmux session vanished unexpectedly — it's now dormant (recoverable),
// not gone. Tell the window so it can offer a respawn instead of dropping the box.
ptys.on("died", (pane, session, info) => broadcast(session, { t: "died", pane: info }));
// The tmux session (and with it, anything setPaneEnv put in its env table)
// is gone either way once a pane dies — drop our own bookkeeping so a
// pointless timer doesn't sit around trying to unset a var that's already
// unreachable.
ptys.on("died", (pane) => secrets.releaseAllForPane(pane));

// Dropped images are written here so Claude can read them by absolute path —
// the same contract as dragging a file into a native terminal.
const UPLOAD_DIR = join(tmpdir(), "fleetview-uploads");
try {
  mkdirSync(UPLOAD_DIR, { recursive: true });
} catch {}

const app = express();

// --- Same-origin guard (CSRF / DNS-rebind / WS-hijack) ----------------------
// No auth here by design, so the ONLY barrier between a random website you visit
// and your shells is origin checking — which the browser does NOT do for
// WebSockets and does NOT enforce for cross-site POST *processing*. So we do it
// ourselves. The curl alert hooks send no Origin and are allowed (they can only
// reach us from this machine); any browser request must be same-origin.
//
// Extra trusted Host/Origin authorities beyond loopback. Set this to your tailnet
// name when fronting FleetView with `tailscale serve` (the proxied request arrives
// with that hostname, not localhost), e.g.
//   FLEET_ALLOWED_HOSTS=mymac.tailnet-1234.ts.net
// Comma-separated; hostnames only (ports ignored).
const ALLOWED_HOSTS = (process.env.FLEET_ALLOWED_HOSTS || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

function hostnameOf(h) {
  return String(h || "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
}
function trustedHost(h) {
  const hn = hostnameOf(h);
  return hn === "localhost" || hn === "127.0.0.1" || hn === "::1" || ALLOWED_HOSTS.includes(hn);
}

function sameOrigin(req) {
  const host = req.headers.host;
  const origin = req.headers.origin;
  if (origin != null) {
    let oHost;
    try {
      oHost = new URL(origin).host;
    } catch {
      return false;
    }
    // CSRF: a browser request's Origin must equal our Host — OR both must be
    // hosts we explicitly trust (a reverse proxy like `tailscale serve` may
    // present a Host that differs from the browser's Origin). A cross-site
    // attacker can't forge either.
    if (oHost !== host && !(trustedHost(oHost) && trustedHost(host))) return false;
  }
  // Anti-DNS-rebinding: when bound to loopback, or whenever an allowlist is set,
  // the Host authority must be one we trust. (An explicit non-loopback bind with
  // no allowlist means the operator opted into open binding — we don't second-guess.)
  if ((isLoopback || ALLOWED_HOSTS.length) && !trustedHost(host)) return false;
  return true;
}
app.use((req, res, next) =>
  sameOrigin(req) ? next() : res.status(403).end("forbidden: cross-origin")
);

// Dropped images arrive as base64 data URLs, so allow a generous JSON body.
app.use(express.json({ limit: "30mb" }));

// --- Panes ---------------------------------------------------------------
app.get("/api/panes", (req, res) => res.json(registry.list(req.query.session)));

// Dormant panes: ones whose terminal died or was set aside, kept so the user can
// bring them back. `sessionAlive` says whether respawn will restore the live
// Claude session (true) or start a fresh shell in the same folder (false).
// What every pane is doing right now — the thing to grab before a restart.
// `?save=1` also writes it to ~/.fleetview/snapshots/ (see snapshot.js).
app.get("/api/snapshot", (req, res) => {
  const snap = collectSnapshot(ptys, agents, req.query.reason || "api");
  if (req.query.save) {
    try {
      snap.savedTo = saveSnapshot(snap);
    } catch (e) {
      snap.saveError = e.message;
    }
  }
  res.json(snap);
});

app.get("/api/dormant", (req, res) => res.json(registry.dormantList(req.query.session)));

app.post("/api/panes/:id/respawn", (req, res) => {
  const info = registry.respawn(req.params.id);
  if (!info) return res.status(404).json({ error: "no such dormant pane" });
  layouts.addRecent(info.cwd);
  broadcast(info.session, { t: "created", pane: info });
  res.json(info);
});

app.delete("/api/dormant/:id", (req, res) => {
  const session = registry.sessionOf(req.params.id);
  registry.discardDormant(req.params.id);
  broadcast(session, { t: "discarded", pane: req.params.id });
  res.status(204).end();
});

app.post("/api/panes", (req, res) => {
  // `remote` is only meaningful for kind:"agent" (a chat-view session
  // running claude/codex over ssh — see ssh-remote-agent.js); PtyManager.create
  // ignores the extra field harmlessly for kind:"pty".
  const { cwd, cmd, session, kind, remote } = req.body || {};
  let pane;
  try {
    pane = registry.create({ cwd, cmd, session, kind, remote });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  const info = registry.info(pane.id);
  layouts.addRecent(info.cwd);
  broadcast(info.session, { t: "created", pane: info });
  res.json(info);
});

/**
 * Flip ONE pane between terminal view and chat view.
 *
 * Per-pane on purpose: the two views are genuinely different processes (see
 * pane-registry.js `flip`), so this is destroy-and-recreate-resuming-the-same-
 * conversation, and that is a decision worth making one box at a time rather
 * than sweeping the whole grid.
 *
 * Refuses rather than guessing — mid-turn, plain shell, raw ssh box, remote
 * chat pane, or a terminal whose agent hasn't reported a session id yet. The
 * reason goes back to the client so it can say why instead of doing nothing
 * visible.
 */
app.post("/api/panes/:id/flip", (req, res) => {
  const before = registry.info(req.params.id);
  if (!before) return res.status(404).json({ error: "no such pane" });

  // Captured BEFORE the flip: afterwards the old pane is gone and its grid
  // position is unrecoverable. The new pane is created at the end of its
  // manager's sequence, so without this the box jumps to the back of the grid.
  const order = registry.list(before.session).map((p) => p.id);

  const r = registry.flip(req.params.id);
  if (!r.ok) return res.status(409).json({ ok: false, reason: r.reason });

  // `replaces` tells the client this is the SAME box in a different view, so it
  // reclaims the old one's grid slot instead of being appended at the end.
  broadcast(before.session, { t: "closed", pane: r.id });
  broadcast(r.info.session, { t: "created", pane: r.info, replaces: r.id });

  const at = order.indexOf(r.id);
  if (at !== -1) {
    order[at] = r.info.id;
    registry.reorder(before.session, order);
  }

  res.json({ ok: true, info: r.info, resumed: r.resumed });
});

// --- Filesystem browsing (for the folder picker) ---
app.get("/api/dirs", async (req, res) => {
  try {
    res.json(await listDirs(req.query.path));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
app.get("/api/recents", (_req, res) => res.json(layouts.recents()));

app.post("/api/mkdir", async (req, res) => {
  try {
    const { path, name } = req.body || {};
    res.json({ path: await makeDir(path, name) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// --- Per-machine settings (server/machine-config.js) ----------------------
// Which accounts THIS machine offers, what its work badge looks like, what it
// calls itself. Deliberately not in the repo: the same checkout runs on several
// machines and they want different answers, which is exactly what went wrong
// when the account list was hardcoded.
app.get("/api/machine", (_req, res) => {
  const cfg = machine.ensureSeeded();
  res.json({
    ...cfg,
    profiles: machine.ALL_PROFILES, // the catalogue, for the settings checkboxes
    installed: machine.installedProfiles(), // which are actually logged in here
    iconColors: ICON_COLORS,
    logoUrl: machine.badgeLogoPath() ? "/api/machine/logo?v=" + Date.now() : null,
  });
});

app.put("/api/machine", (req, res) => {
  const cfg = machine.update(req.body || {});
  res.json(cfg);
});

// Same base64 data-URL shape as the pane file drop, so the client needs no new
// upload plumbing. Extension-allowlisted and size-capped: this is written to
// disk and then served back, so it must never be an arbitrary file.
const LOGO_TYPES = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/svg+xml": ".svg" };
app.post("/api/machine/logo", (req, res) => {
  const m = /^data:([^;]*);base64,(.+)$/s.exec(req.body?.dataUrl || "");
  if (!m) return res.status(400).json({ error: "expected a base64 data URL" });
  const ext = LOGO_TYPES[m[1]];
  if (!ext) return res.status(400).json({ error: "use a PNG, JPEG, WebP or SVG image" });
  const buf = Buffer.from(m[2], "base64");
  if (buf.length > 512 * 1024) return res.status(400).json({ error: "image must be under 512 KB" });
  machine.saveBadgeLogo(buf, ext);
  res.json({ ok: true, logoUrl: "/api/machine/logo?v=" + Date.now() });
});

app.delete("/api/machine/logo", (_req, res) => {
  machine.clearBadgeLogo();
  res.status(204).end();
});

app.get("/api/machine/logo", (_req, res) => {
  const file = machine.badgeLogoPath();
  if (!file) return res.status(404).end();
  // Same lockdown as /api/file: this is user-supplied bytes being served back,
  // and an SVG is a script host unless it is sandboxed.
  res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.sendFile(file);
});

// Machine identity for the running UI (top bar + tab title). Separate from
// /api/prefs on purpose: prefs are YOUR settings and sync across devices,
// this is a property of the machine you happen to be connected to.
app.get("/api/identity", (_req, res) => res.json({ label: identity.label, color: identity.color }));

app.get("/api/prefs", (_req, res) => res.json(layouts.prefs()));
app.put("/api/prefs", (req, res) => res.json(layouts.setPrefs(req.body || {})));

// --- Web Push -----------------------------------------------------------
// Sits behind the same sameOrigin() guard and express.json() as everything
// above, so these inherit the CSRF/DNS-rebinding protection for free.
//
// Note there is no "enabled" flag to toggle: a device is subscribed if it has a
// row here, and unsubscribed if it doesn't.
app.get("/api/push/key", (_req, res) =>
  res.json({ key: vapid.publicKeyB64(), devices: pushStore.count() })
);
app.post("/api/push/subscribe", (req, res) => {
  const row = pushStore.upsert(req.body || {});
  if (!row) return res.status(400).json({ error: "not a valid push subscription" });
  res.json({ ok: true, devices: pushStore.count() });
});
app.post("/api/push/unsubscribe", (req, res) => {
  pushStore.remove(req.body?.endpoint);
  res.status(204).end();
});

app.delete("/api/panes/:id", (req, res) => {
  const session = registry.sessionOf(req.params.id);
  secrets.releaseAllForPane(req.params.id);
  registry.kill(req.params.id);
  broadcast(session, { t: "closed", pane: req.params.id });
  res.status(204).end();
});

// Persist this window's grid order (so a drag survives refresh).
app.post("/api/order", (req, res) => {
  const { session, ids } = req.body || {};
  if (Array.isArray(ids)) registry.reorder(session, ids);
  res.status(204).end();
});

// A dropped file: save it to a temp file and hand back the absolute path. The
// client then types that path into the pane's prompt (see terminal.ts), exactly
// like dragging a file into a real terminal. We don't touch the PTY here.
// Any file type is accepted — Claude Code reads images, PDFs, text, code, etc.
function saveDroppedFile(req, res) {
  if (!registry.info(req.params.id)) return res.status(404).json({ error: "no such pane" });
  const { name, dataUrl } = req.body || {};
  // Mime may be empty ("data:;base64,…") — browsers emit that for unknown types.
  const m = /^data:([^;]*);base64,(.+)$/s.exec(dataUrl || "");
  if (!m) return res.status(400).json({ error: "expected a base64 data URL" });
  const [, mime, b64] = m;

  // Keep the original name (sanitized) for a readable path, but give each drop a
  // unique sub-dir so identical filenames never clobber each other.
  const rawExt = extname(name || "");
  const ext = rawExt || mimeExt(mime);
  let base = (name || "file").replace(/[^a-zA-Z0-9._-]/g, "_");
  if (rawExt) base = base.slice(0, -rawExt.length);
  const dir = mkdtempSync(join(UPLOAD_DIR, "drop-"));
  const file = join(dir, (base || "file") + ext);
  try {
    writeFileSync(file, Buffer.from(b64, "base64"));
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
  res.json({ path: file });
}
app.post("/api/panes/:id/file", saveDroppedFile);
// Alias: browser tabs still running the pre-upgrade client bundle post here.
app.post("/api/panes/:id/image", saveDroppedFile);

// Derive an extension from the mime type only when the name had none and the
// type is unambiguous; otherwise leave the filename extension-less.
function mimeExt(mime) {
  return (
    {
      "image/png": ".png",
      "image/jpeg": ".jpg",
      "image/gif": ".gif",
      "image/webp": ".webp",
      "image/svg+xml": ".svg",
      "application/pdf": ".pdf",
      "application/json": ".json",
      "text/plain": ".txt",
      "text/csv": ".csv",
    }[mime] || ""
  );
}

// --- Local media -----------------------------------------------------------
// The chat view renders `![shot](/tmp/plot.png)` and bare links to video/audio
// as real embedded media (see client/src/markdown.ts). Those files live on this
// machine's disk, not under `dist/`, so the browser needs one route that can
// hand them back.
//
// This is deliberately an EXTENSION allowlist, not a directory allowlist: the
// whole point is that an agent writes a chart to `/tmp`, a screenshot to its
// own cwd, or a diagram wherever it likes, and the user sees it inline. Scoping
// it to a directory would miss the common case. That is not the security
// give-away it looks like — this server already spawns unauthenticated shells,
// so anything that can reach the port can `cat` any file anyway (see the
// Security note in CLAUDE.md); reading a .png through here grants nothing new.
// The allowlist exists to keep the route boring, not to contain it: it can't be
// pointed at `~/.ssh/id_rsa` and get text back.
const MEDIA_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".ogv": "video/ogg",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".oga": "audio/ogg",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
};
app.get("/api/file", (req, res) => {
  const raw = String(req.query.path || "");
  if (!raw) return res.status(400).end("missing path");
  const file = resolve(raw);
  const type = MEDIA_TYPES[extname(file).toLowerCase()];
  // Unknown extension → 415, never a fallback to octet-stream. The client only
  // ever points this route at media it already decided was media.
  if (!type) return res.status(415).end("not a supported media type");
  let st;
  try {
    st = statSync(file);
  } catch {
    return res.status(404).end("no such file");
  }
  if (!st.isFile()) return res.status(404).end("not a file");
  res.type(type);
  // An SVG is the one allowlisted type that can carry <script>. As an <img>
  // source that script is inert, but pasting the URL into the address bar would
  // run it on this origin — so every media response is served under a CSP that
  // permits nothing and a sandbox with no allow-* tokens (a unique opaque
  // origin, scripting disabled). Belt-and-braces with nosniff, which stops a
  // mislabelled .png from being re-interpreted as anything executable.
  res.set("Content-Security-Policy", "default-src 'none'; sandbox");
  res.set("X-Content-Type-Options", "nosniff");
  // Local files change under us (an agent re-runs a script and rewrites
  // plot.png), and the URL carries no content hash to bust — so revalidate
  // every time rather than serving a stale frame from the memory cache.
  res.set("Cache-Control", "no-cache");
  // sendFile (not readFileSync) so <video> range requests work: seeking a
  // multi-hundred-MB screen recording must not buffer the whole file first.
  res.sendFile(file, (err) => {
    if (err && !res.headersSent) res.status(500).end("read failed");
  });
});

app.post("/api/panes/:id/clear", (req, res) => {
  const session = registry.sessionOf(req.params.id);
  registry.clearAttention(req.params.id);
  broadcast(session, { t: "cleared", pane: req.params.id });
  res.status(204).end();
});

app.post("/api/panes/:id/followup", (req, res) => {
  const id = req.params.id;
  if (!registry.info(id)) return res.status(404).json({ error: "no such pane" });
  const on = !!(req.body && req.body.on);
  registry.setFollowUp(id, on);
  broadcast(registry.sessionOf(id), { t: "followup", pane: id, on });
  res.status(204).end();
});

app.post("/api/panes/:id/color", (req, res) => {
  const id = req.params.id;
  if (!registry.info(id)) return res.status(404).json({ error: "no such pane" });
  const color = (req.body && typeof req.body.color === "string" ? req.body.color : "").trim();
  registry.setColor(id, color);
  broadcast(registry.sessionOf(id), { t: "color", pane: id, color });
  res.status(204).end();
});

// A user-chosen display name for the pane ("" reverts to the cwd basename).
app.post("/api/panes/:id/name", (req, res) => {
  const id = req.params.id;
  if (!registry.info(id)) return res.status(404).json({ error: "no such pane" });
  const name = (req.body && typeof req.body.name === "string" ? req.body.name : "")
    .trim()
    .slice(0, 60);
  registry.setName(id, name);
  broadcast(registry.sessionOf(id), { t: "renamed", pane: id, name });
  res.status(204).end();
});

// --- Ephemeral secrets -----------------------------------------------------
// See secret-vault.js for the full model. PTY panes: the value goes straight
// into the pane's tmux env table, never into pane.buffer/events, so it can't
// reach the transcript, the ring buffer, or a snapshot — Claude only ever
// sees the var name it's told to reference. Agent (chat) panes have no tmux
// session, so instead: a private temp file + one chat message telling Claude
// the file's path (never the value).
app.get("/api/panes/:id/secret-status", (req, res) => {
  const id = req.params.id;
  const isChat = !!agents.info(id);
  res.json({
    mechanism: isChat ? "tmp-file" : "tmux-env",
    // tmp-file delivery has no external dependency to be missing; tmux-env
    // delivery needs a tmux binary FleetView found at startup.
    ready: isChat || !!ptys.tmux,
    gateConfigured: gateConfigured(),
    active: secrets.listForPane(id),
  });
});

app.post("/api/panes/:id/secret", (req, res) => {
  const id = req.params.id;
  if (!registry.info(id)) return res.status(404).json({ error: "no such (live) pane" });
  const { name, value, ttlMs, session, stepUpToken } = req.body || {};
  // NOT gated on `session` matching the pane's original CREATOR session
  // (registry.sessionOf(id)) — that was a holdover from before "one workspace
  // per machine" (pane-registry.js) and added no real access control, since
  // every window can already read/type into every pane once it's on the
  // fleet. It only ever succeeded in blocking injection from any window OTHER
  // than the one that happened to create the pane — which broke it entirely
  // for a PWA-only setup, since an iOS cold launch mints a fresh session every
  // time (main.ts) and can never equal an old pane's creator session. `session`
  // is still required, just not compared to anything: it's what secrets.inject()
  // records below so the secret auto-releases when THIS window disconnects
  // (see SESSION_GRACE_MS) — it identifies the injecting window, not a permission.
  if (!session) {
    return res.status(400).json({ error: "missing session" });
  }
  // Step-up is OPTIONAL, not required: if the gate was never set up, or this
  // request bypassed it entirely (reaching FleetView's port directly is
  // already "get a shell, no auth" per the server's whole threat model —
  // see the top-of-file comment), there is no token to check. But a PRESENTED
  // token must be genuine and scoped to this exact pane — a garbage or
  // mis-scoped token is more suspicious than none, so that's rejected outright.
  let stepUpVerified = false;
  if (stepUpToken) {
    if (!verifyStepUpToken(stepUpToken, `secret:${id}`)) {
      return res.status(401).json({ error: "step-up verification failed" });
    }
    stepUpVerified = true;
  }
  try {
    const result = secrets.inject({ paneId: id, name, value, ttlMs, session });
    res.json({ ...result, stepUpVerified });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete("/api/panes/:id/secret/:name", (req, res) => {
  secrets.release(req.params.id, req.params.name);
  res.status(204).end();
});

// A file path clicked in the terminal → open it in an editor. The path is
// resolved against the pane's cwd (Claude prints relative paths like
// "server/index.js:42"); a non-existent target is a silent no-op so a
// false-positive link match never launches anything. See server/open-file.js.
app.post("/api/panes/:id/open", (req, res) => {
  const info = registry.info(req.params.id);
  if (!info) return res.status(404).json({ error: "no such pane" });
  const raw = req.body && typeof req.body.path === "string" ? req.body.path : "";
  if (!raw) return res.status(400).json({ error: "no path" });
  const line = req.body && Number.isInteger(req.body.line) ? req.body.line : undefined;
  const expanded = raw.startsWith("~") ? join(homedir(), raw.slice(1)) : raw;
  const abs = resolve(info.cwd, expanded);
  let st;
  try {
    st = statSync(abs);
  } catch {
    return res.status(204).end(); // doesn't exist → no-op (absorbs bad matches)
  }
  // Files open in the editor (at the line); directories reveal in Finder.
  if (st.isFile()) openInEditor(abs, line);
  else if (st.isDirectory()) openFolder(abs);
  res.status(204).end(); // sockets/devices/etc. fall through as a no-op
});

// Resolve the clickable file/dir paths in a line of terminal text. Used by the
// client only for lines where a path may contain spaces (which it can't split
// on its own): the filesystem is the only reliable arbiter of where such a path
// ends, so we validate candidates against the pane's cwd. Returns half-open
// [start, end) string indices into the same `line` the client sent.
app.post("/api/panes/:id/resolve", (req, res) => {
  const info = registry.info(req.params.id);
  if (!info) return res.status(404).json({ error: "no such pane" });
  const line = req.body && typeof req.body.line === "string" ? req.body.line : "";
  res.json({ links: line ? findPathLinks(line, info.cwd) : [] });
});

// --- Layouts -------------------------------------------------------------
app.get("/api/layouts", (_req, res) => res.json(layouts.list()));

app.post("/api/layouts", (req, res) => {
  layouts.save(req.body);
  broadcastAll({ t: "layouts" });
  res.json(layouts.list());
});

app.delete("/api/layouts/:name", (req, res) => {
  layouts.remove(req.params.name);
  broadcastAll({ t: "layouts" });
  res.status(204).end();
});

// --- SSH profiles ----------------------------------------------------------
// Key/agent-auth-only server profiles the picker can open a pane against (see
// ssh-profiles.js). `/api/ssh-hosts` is a SEPARATE, read-only surface: it just
// reflects whatever's already in ~/.ssh/config so it can be offered alongside
// FleetView-managed profiles — FleetView never writes to that file.
app.get("/api/ssh-profiles", (_req, res) => res.json(sshProfiles.list()));

app.post("/api/ssh-profiles", (req, res) => {
  let saved;
  try {
    saved = sshProfiles.save(req.body);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  broadcastAll({ t: "ssh-profiles" });
  res.json(saved);
});

app.delete("/api/ssh-profiles/:name", (req, res) => {
  sshProfiles.remove(req.params.name);
  broadcastAll({ t: "ssh-profiles" });
  res.status(204).end();
});

app.get("/api/ssh-hosts", (_req, res) => res.json(listSshConfigHosts()));

app.post("/api/layouts/:name/open", (req, res) => {
  const layout = layouts.get(req.params.name);
  if (!layout) return res.status(404).json({ error: "no such layout" });
  const { session, mode } = req.body || {};

  // "overwrite" sets this window's existing terminals aside (non-destructively
  // for PTY panes — their tmux sessions keep running and land in the
  // dormant/recovery list, so a mis-click on Replace can be undone; agent
  // panes have no dormant tier, so for those this is a real close, see
  // pane-registry.js) — "add" keeps them on screen either way.
  if (mode === "overwrite") {
    for (const id of registry.idsOf(session)) {
      const result = registry.setAside(id);
      if (!result) continue;
      if (result.type === "died" && result.info) broadcast(session, { t: "died", pane: result.info });
      else if (result.type === "closed") broadcast(session, { t: "closed", pane: result.id });
    }
  }

  const created = [];
  for (const slot of layout.slots || []) {
    const cmd = slot.cmd ?? layout.cmd ?? machine.defaultAgentCmd();
    const kind = slot.kind ?? "pty";
    const pane = registry.create({ cwd: slot.cwd, cmd, session, kind });
    const info = registry.info(pane.id);
    layouts.addRecent(info.cwd);
    created.push(info);
    broadcast(session, { t: "created", pane: info });
  }
  res.json(created);
});

// --- Usage (subscription limits, one row per account) --------------------
app.get("/api/usage", (_req, res) => res.json(usage.snapshot()));
app.post("/api/usage/refresh", async (_req, res) => {
  await usage.refresh();
  res.json(usage.snapshot());
});

// --- Tasks (one global tree, shared across all windows) ------------------
app.get("/api/tasks", (_req, res) => res.json(tasks.tree()));
app.put("/api/tasks", (req, res) => {
  const tree = tasks.replace((req.body && req.body.tasks) || []);
  broadcastAll({ t: "tasks", tasks: tree });
  res.json(tree);
});

// --- Hook endpoint (Claude Code / Codex phone home here) -----------------
// Two shapes are accepted on purpose. The CURRENT hook (setup-hooks.js) puts
// pane+kind in the query string and forwards the agent's own hook JSON as the
// body, which is how we learn `session_id`. The OLDER hook put pane+kind in the
// body and sent nothing else; a `claude` that is still running with that
// version installed must keep working, so both are read.
app.post("/hook", (req, res) => {
  const body = req.body || {};
  const pane = req.query.pane || body.pane;
  const kind = req.query.kind || body.kind;
  if (pane) {
    registry.setAttention(pane, kind || "question");
    rememberSdkSession(pane, body);
  }
  res.status(204).end();
});

/**
 * Pin the Claude session id a PTY pane's agent is running under, so the pane can
 * later be flipped into a chat pane that RESUMES that same conversation instead
 * of starting a blank one (see pane-registry.js `flip`). Agent panes learn their
 * id from the SDK driver directly and don't need this.
 *
 * Best-effort by nature: it only lands once the agent inside the shell has fired
 * at least one hook, so a terminal pane opened and never prompted has no id yet.
 */
function rememberSdkSession(pane, body) {
  const sid = body && typeof body.session_id === "string" ? body.session_id : "";
  if (sid) ptys.setSdkSessionId(pane, sid);
}

// UserPromptSubmit hook forwards the agent's raw hook JSON here (the prompt is in
// `.prompt`); we pin it as this window's "last input".
app.post("/hook/prompt", (req, res) => {
  const id = req.query.pane;
  const prompt = req.body && typeof req.body.prompt === "string" ? req.body.prompt : "";
  if (id) rememberSdkSession(id, req.body);
  if (id && prompt) {
    registry.setLastInput(id, prompt);
    broadcast(registry.sessionOf(id), { t: "input", pane: id, text: registry.lastInputOf(id) });
    // A prompt was just submitted ⇒ this agent is now working. The matching
    // Stop/Notification hook (POST /hook above) ends it.
    registry.setWorking(id, true);
  }
  res.status(204).end();
});

// --- Static client -------------------------------------------------------
// index.html must never be cached (let alone bfcache'd): its only job is to
// point at the current content-hashed bundle filenames (index-XXXX.js/css),
// so a stale copy silently keeps loading a stale bundle forever — no error,
// no visual sign, just old code running. Bit us during mobile CSS work: the
// server had the fix, curl confirmed it, but a phone Safari tab kept
// rendering the old layout because Safari restored it from its
// back-forward cache instead of refetching. Cache-Control: no-store is also
// one of the few reliable ways to opt a page OUT of bfcache. The hashed
// assets underneath (JS/CSS/images) are unaffected and stay on Express's
// normal freshness-checked defaults, since a new build gives them new
// filenames anyway.
const noStoreIndexHtml = (res, path) => {
  if (path.endsWith("index.html")) res.setHeader("Cache-Control", "no-store");
  // The service worker script is fetched out-of-band by the browser, not via a
  // content-hashed filename, so it needs to revalidate rather than sit in the
  // HTTP cache. (Browsers already cap SW script caching at 24h, but be explicit.)
  if (path.endsWith("sw.js")) res.setHeader("Cache-Control", "no-cache");
};
// --- Per-machine identity: manifest + icons ------------------------------
// Registered BEFORE express.static so these win over any file of the same
// name, which is what lets the colour be a server-side choice while the URLs
// stay constant (see server/identity.js).
app.get("/manifest.webmanifest", (_req, res) => {
  res.type("application/manifest+json").set("Cache-Control", "no-cache").json(identity.manifest());
});

// Colour-agnostic ALIASES, kept only for client/public/sw.js, which is a static
// file and so can't know this machine's colour when it names a notification
// icon. The URLs a platform CACHES (the manifest's icons and the
// apple-touch-icon link) are colour-scoped instead — see identity.js's
// iconHref. Don't move those back here: a stable URL is what made iOS keep
// showing a stale Home Screen icon after the colour changed.
for (const file of ["icon-192.png", "badge-96.png", "apple-touch-icon.png"]) {
  app.get(`/${file}`, (_req, res, next) => {
    const p = file === "badge-96.png" ? join(DIST, file) : identity.iconPath(file);
    res.set("Cache-Control", "no-cache").sendFile(p, (err) => {
      if (err && !res.headersSent) next();
    });
  });
}

/**
 * index.html, with this machine's apple-touch-icon patched in.
 *
 * iOS reads `<link rel="apple-touch-icon">` from the markup when you Add to
 * Home Screen, and it is NOT part of the manifest — so it's the one icon
 * reference that can't be expressed as server-side data. Rewriting it here
 * keeps the built HTML colour-agnostic (nothing in the bundle knows about
 * palettes) while still handing iOS a colour-scoped, cache-proof URL.
 *
 * Cached in memory against the file's mtime so this isn't a read per request,
 * but still picks up a rebuild without a restart.
 */
let indexCache = { mtime: 0, html: "" };
function sendIndexHtml(res) {
  const file = join(DIST, "index.html");
  res.setHeader("Cache-Control", "no-store"); // see noStoreIndexHtml's comment
  try {
    const mtime = statSync(file).mtimeMs;
    if (mtime !== indexCache.mtime) {
      const html = readFileSync(file, "utf8").replace(
        /(<link\s+rel="apple-touch-icon"\s+href=")[^"]*(")/,
        `$1${identity.iconHref("apple-touch-icon.png")}$2`
      );
      indexCache = { mtime, html };
    }
    res.type("html").send(indexCache.html);
  } catch {
    // Unbuilt dist: fall back to the plain file so the error the user sees is
    // express's own "ENOENT", not a confusing empty 200.
    res.sendFile(file);
  }
}

// Ahead of express.static, and static's own index serving is disabled below, so
// every route to the app document goes through sendIndexHtml.
app.get(["/", "/index.html"], (_req, res) => sendIndexHtml(res));

app.use(express.static(DIST, { index: false, setHeaders: noStoreIndexHtml }));

// sw.js is a FILE, not an SPA route. Without this, an unbuilt or missing sw.js
// falls through to the catch-all below and comes back as index.html with
// Content-Type: text/html — which surfaces as a baffling MIME type error at
// registration ("the script has an unsupported MIME type") instead of an
// obvious 404. Costs nothing and turns a confusing failure into a clear one.
app.get("/sw.js", (_req, res) =>
  res.status(404).type("text/plain").end("not found — run `npm run build`")
);

// SPA catch-all. Goes through sendIndexHtml so a deep link (e.g. the #pane=
// URL a tapped notification opens) gets the same patched document as "/".
app.get("*", (_req, res) => sendIndexHtml(res));

// --- HTTP + WebSocket wiring ---------------------------------------------
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

function handleUpgrade(req, socket, head) {
  // WebSockets bypass CORS entirely, so this is the most important origin check.
  if (!sameOrigin(req)) {
    socket.destroy();
    return;
  }
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/control") {
    const session = url.searchParams.get("session");
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.fleetSession = session;
      controlClients.add(ws);
      // This window is back (first load, refresh, or a reconnect after
      // sleep/blip) — call off any pending expiry of the secrets it injected.
      cancelSecretRelease(session);
      ws.on("close", () => {
        controlClients.delete(ws);
        // "Only while I'm here": if this window really is gone, the secrets it
        // injected expire early instead of riding out their TTL unwatched —
        // but only after a grace period, since the client re-opens this socket
        // on its own (see scheduleSecretRelease).
        scheduleSecretRelease(session);
      });
      ws.on("message", (raw) => {
        try {
          const m = JSON.parse(raw);
          if (m.t === "clear") {
            registry.clearAttention(m.pane);
            broadcast(session, { t: "cleared", pane: m.pane });
          }
        } catch {}
      });
      // Hand the new browser only its own window's terminals, plus any dormant
      // (recoverable) panes so a refresh after a crash/sleep offers to bring them back.
      ws.send(JSON.stringify({ t: "panes", panes: registry.list(session) }));
      ws.send(JSON.stringify({ t: "dormant", dormant: registry.dormantList(session) }));
      ws.send(JSON.stringify({ t: "tasks", tasks: tasks.tree() }));
      ws.send(JSON.stringify({ t: "usage", usage: usage.snapshot() }));
    });
  } else if (url.pathname === "/term") {
    const id = url.searchParams.get("pane");
    wss.handleUpgrade(req, socket, head, (ws) => ptys.attach(id, ws));
  } else if (url.pathname === "/agent") {
    const id = url.searchParams.get("pane");
    wss.handleUpgrade(req, socket, head, (ws) => agents.attach(id, ws));
  } else {
    socket.destroy();
  }
}
server.on("upgrade", handleUpgrade);

// Fail readably if the port is taken — usually the login service (or another
// `npm start`) is already running. Don't dump a raw stack.
server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error(
      `\n[fleetview] port ${PORT} is already in use — FleetView is probably already\n` +
        `running (e.g. the login auto-start service). Don't run two at once:\n` +
        `  • use the one that's up, or stop auto-start: npm run service:uninstall\n` +
        `  • or pick another port: FLEET_PORT=4281 npm start\n`
    );
    process.exit(1);
  }
  throw e;
});
// Snapshot on the way out. Agent panes are the fragile ones — their live
// driver dies with this process and their on-screen log is memory-only — so a
// shutdown is exactly when a record of "what was each box doing" is worth
// having. Sync write: an async one would never land before exit. Under the
// auto-start service (KeepAlive), launchd/systemd sends SIGTERM here on every
// restart, so this fires on the restarts you didn't type as well as the ones
// you did.
let shuttingDown = false;
function snapshotAndExit(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    const path = saveSnapshot(collectSnapshot(ptys, agents, `shutdown:${signal}`));
    console.log(`[fleetview] ${signal} — snapshot saved to ${path}`);
  } catch (e) {
    console.warn(`[fleetview] ${signal} — could not save snapshot: ${e.message}`);
  }
  process.exit(0);
}
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => snapshotAndExit(sig));

server.listen(PORT, HOST, () => {
  console.log(`\n  ▦ FleetView → http://localhost:${PORT}\n`);
  console.log(`[fleetview] pane snapshots: ${SNAPSHOT_DIR} (auto on shutdown, or \`npm run snapshot\`)`);
  // Started here, not at module load, so a slow/absent CLI can never delay boot.
  usage.start();
  if (!isLoopback) {
    console.warn(
      `  ⚠ Listening on ${HOST} — reachable from the network. This server runs\n` +
        `    shells with no authentication; anyone who can reach it gets a shell.\n`
    );
  }
});

// Optional second listener on a Unix domain socket, for the passkey gate
// (server/gate.js) to proxy through instead of the TCP port above — see
// TAILSCALE.md "Going further". A socket file's permissions are a real
// OS-enforced boundary a TCP port number can't be: chmod it 0600 right after
// binding (Node creates it with looser permissions, umask-dependent) so only
// this same OS account (intended to be the dedicated one the gate also runs
// as, not your interactive login user) can ever connect to it — anything
// else gets a permissions error at the filesystem level, not just "the app
// said no." Same request handler and upgrade wiring as the TCP server above;
// this is purely a second door into the identical app.
if (process.env.FLEET_GATE_SOCKET) {
  const socketPath = process.env.FLEET_GATE_SOCKET;
  if (existsSync(socketPath)) {
    try {
      unlinkSync(socketPath); // stale file from a previous run — listen() would EADDRINUSE on it
    } catch (e) {
      console.warn(`[fleetview] could not remove stale socket ${socketPath}: ${e.message}`);
    }
  }
  const socketServer = createServer(app);
  socketServer.on("upgrade", handleUpgrade);
  socketServer.on("error", (e) => {
    console.error(`[fleetview] gate socket ${socketPath} failed: ${e.message}`);
  });
  socketServer.listen(socketPath, () => {
    chmodSync(socketPath, 0o600);
    console.log(`[fleetview] also listening on ${socketPath} (for server/gate.js)`);
  });
}
