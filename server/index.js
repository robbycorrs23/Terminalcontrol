import express from "express";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { PtyManager } from "./pty-manager.js";
import { LayoutStore } from "./layout-store.js";
import { TaskStore } from "./task-store.js";
import { ensureHooks } from "./setup-hooks.js";
import { listDirs, makeDir } from "./fs-browse.js";
import { preflight } from "../scripts/preflight.js";

// Check for tmux / curl / claude FIRST, so any missing-dependency warning is the
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

// Make sure Claude Code knows how to phone home before any terminal starts.
ensureHooks(PORT);

const ptys = new PtyManager(PORT, join(ROOT, "sessions.json"));
const layouts = new LayoutStore(join(ROOT, "layouts.json"));
const tasks = new TaskStore(join(ROOT, "tasks.json"));
// The loud "tmux missing" warning is handled by preflight() above; here we just
// confirm the durable path when it IS available.
if (ptys.tmux) console.log("[fleetview] tmux-backed terminals — they survive server restarts.");

// Grid-level events are scoped to a session (= one browser window). Each control
// socket carries its window's session id; events only reach that window.
const controlClients = new Set();
function broadcast(session, msg) {
  const s = JSON.stringify(msg);
  for (const ws of controlClients) {
    if (ws.fleetSession !== session) continue;
    try {
      ws.send(s);
    } catch {}
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
ptys.on("attention", (pane, kind) => broadcast(ptys.sessionOf(pane), { t: "attention", pane, kind }));
ptys.on("exit", (pane, session) => broadcast(session, { t: "closed", pane }));
// A pane's tmux session vanished unexpectedly — it's now dormant (recoverable),
// not gone. Tell the window so it can offer a respawn instead of dropping the box.
ptys.on("died", (pane, session, info) => broadcast(session, { t: "died", pane: info }));

// Dropped images are written here so Claude can read them by absolute path —
// the same contract as dragging a file into a native terminal.
const UPLOAD_DIR = join(tmpdir(), "fleetview-images");
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
app.get("/api/panes", (req, res) => res.json(ptys.list(req.query.session)));

// Dormant panes: ones whose terminal died or was set aside, kept so the user can
// bring them back. `sessionAlive` says whether respawn will restore the live
// Claude session (true) or start a fresh shell in the same folder (false).
app.get("/api/dormant", (req, res) => res.json(ptys.dormantList(req.query.session)));

app.post("/api/panes/:id/respawn", (req, res) => {
  const info = ptys.respawn(req.params.id);
  if (!info) return res.status(404).json({ error: "no such dormant pane" });
  layouts.addRecent(info.cwd);
  broadcast(info.session, { t: "created", pane: info });
  res.json(info);
});

app.delete("/api/dormant/:id", (req, res) => {
  const session = ptys.sessionOf(req.params.id);
  ptys.discardDormant(req.params.id);
  broadcast(session, { t: "discarded", pane: req.params.id });
  res.status(204).end();
});

app.post("/api/panes", (req, res) => {
  const { cwd, cmd, session } = req.body || {};
  const pane = ptys.create({ cwd, cmd, session });
  const info = ptys.info(pane.id);
  layouts.addRecent(info.cwd);
  broadcast(info.session, { t: "created", pane: info });
  res.json(info);
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

app.get("/api/prefs", (_req, res) => res.json(layouts.prefs()));
app.put("/api/prefs", (req, res) => res.json(layouts.setPrefs(req.body || {})));

app.delete("/api/panes/:id", (req, res) => {
  const session = ptys.sessionOf(req.params.id);
  ptys.kill(req.params.id);
  broadcast(session, { t: "closed", pane: req.params.id });
  res.status(204).end();
});

// Persist this window's grid order (so a drag survives refresh).
app.post("/api/order", (req, res) => {
  const { session, ids } = req.body || {};
  if (Array.isArray(ids)) ptys.reorder(session, ids);
  res.status(204).end();
});

// A dropped image: save it to a temp file and hand back the absolute path. The
// client then types that path into the pane's prompt (see terminal.ts), exactly
// like dragging an image into a real terminal. We don't touch the PTY here.
app.post("/api/panes/:id/image", (req, res) => {
  if (!ptys.info(req.params.id)) return res.status(404).json({ error: "no such pane" });
  const { name, dataUrl } = req.body || {};
  const m = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl || "");
  if (!m) return res.status(400).json({ error: "expected a base64 image data URL" });
  const [, mime, b64] = m;
  if (!mime.startsWith("image/")) return res.status(400).json({ error: "not an image" });

  // Keep the original name (sanitized) for a readable path, but give each drop a
  // unique sub-dir so identical filenames never clobber each other.
  const ext = extname(name || "") || "." + mime.split("/")[1].replace("+xml", "");
  const base = (name || "image").replace(/[^a-zA-Z0-9._-]/g, "_").replace(/\.[^.]*$/, "");
  const dir = mkdtempSync(join(UPLOAD_DIR, "drop-"));
  const file = join(dir, (base || "image") + ext);
  try {
    writeFileSync(file, Buffer.from(b64, "base64"));
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
  res.json({ path: file });
});

app.post("/api/panes/:id/clear", (req, res) => {
  const session = ptys.sessionOf(req.params.id);
  ptys.clearAttention(req.params.id);
  broadcast(session, { t: "cleared", pane: req.params.id });
  res.status(204).end();
});

// The pane's current on-screen text (clean, wrapped lines rejoined) for the
// per-box copy button. Plain text so the client can drop it on the clipboard.
app.get("/api/panes/:id/text", (req, res) => {
  const text = ptys.captureText(req.params.id);
  if (text == null) return res.status(404).json({ error: "cannot capture pane text" });
  res.type("text/plain; charset=utf-8").send(text);
});

app.post("/api/panes/:id/followup", (req, res) => {
  const id = req.params.id;
  if (!ptys.info(id)) return res.status(404).json({ error: "no such pane" });
  const on = !!(req.body && req.body.on);
  ptys.setFollowUp(id, on);
  broadcast(ptys.sessionOf(id), { t: "followup", pane: id, on });
  res.status(204).end();
});

app.post("/api/panes/:id/color", (req, res) => {
  const id = req.params.id;
  if (!ptys.info(id)) return res.status(404).json({ error: "no such pane" });
  const color = (req.body && typeof req.body.color === "string" ? req.body.color : "").trim();
  ptys.setColor(id, color);
  broadcast(ptys.sessionOf(id), { t: "color", pane: id, color });
  res.status(204).end();
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

app.post("/api/layouts/:name/open", (req, res) => {
  const layout = layouts.get(req.params.name);
  if (!layout) return res.status(404).json({ error: "no such layout" });
  const { session, mode } = req.body || {};

  // "overwrite" sets this window's existing terminals aside (non-destructively —
  // their tmux sessions keep running and land in the dormant/recovery list, so a
  // mis-click on Replace can be undone); "add" keeps them on screen.
  if (mode === "overwrite") {
    for (const id of ptys.idsOf(session)) {
      const info = ptys.setAside(id);
      if (info) broadcast(session, { t: "died", pane: info });
    }
  }

  const created = [];
  for (const slot of layout.slots || []) {
    const cmd = slot.cmd ?? layout.cmd ?? "claude";
    const pane = ptys.create({ cwd: slot.cwd, cmd, session });
    const info = ptys.info(pane.id);
    layouts.addRecent(info.cwd);
    created.push(info);
    broadcast(session, { t: "created", pane: info });
  }
  res.json(created);
});

// --- Tasks (one global tree, shared across all windows) ------------------
app.get("/api/tasks", (_req, res) => res.json(tasks.tree()));
app.put("/api/tasks", (req, res) => {
  const tree = tasks.replace((req.body && req.body.tasks) || []);
  broadcastAll({ t: "tasks", tasks: tree });
  res.json(tree);
});

// --- Hook endpoint (Claude Code phones home here) ------------------------
app.post("/hook", (req, res) => {
  const { pane, kind } = req.body || {};
  if (pane) ptys.setAttention(pane, kind || "question");
  res.status(204).end();
});

// UserPromptSubmit hook forwards Claude's raw hook JSON here (the prompt is in
// `.prompt`); we pin it as this window's "last input".
app.post("/hook/prompt", (req, res) => {
  const id = req.query.pane;
  const prompt = req.body && typeof req.body.prompt === "string" ? req.body.prompt : "";
  if (id && prompt) {
    ptys.setLastInput(id, prompt);
    broadcast(ptys.sessionOf(id), { t: "input", pane: id, text: ptys.lastInputOf(id) });
  }
  res.status(204).end();
});

// --- Static client -------------------------------------------------------
app.use(express.static(DIST));
app.get("*", (_req, res) => res.sendFile(join(DIST, "index.html")));

// --- HTTP + WebSocket wiring ---------------------------------------------
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
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
      ws.on("close", () => controlClients.delete(ws));
      ws.on("message", (raw) => {
        try {
          const m = JSON.parse(raw);
          if (m.t === "clear") {
            ptys.clearAttention(m.pane);
            broadcast(session, { t: "cleared", pane: m.pane });
          }
        } catch {}
      });
      // Hand the new browser only its own window's terminals, plus any dormant
      // (recoverable) panes so a refresh after a crash/sleep offers to bring them back.
      ws.send(JSON.stringify({ t: "panes", panes: ptys.list(session) }));
      ws.send(JSON.stringify({ t: "dormant", dormant: ptys.dormantList(session) }));
      ws.send(JSON.stringify({ t: "tasks", tasks: tasks.tree() }));
    });
  } else if (url.pathname === "/term") {
    const id = url.searchParams.get("pane");
    wss.handleUpgrade(req, socket, head, (ws) => ptys.attach(id, ws));
  } else {
    socket.destroy();
  }
});

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
server.listen(PORT, HOST, () => {
  console.log(`\n  ▦ FleetView → http://localhost:${PORT}\n`);
  if (!isLoopback) {
    console.warn(
      `  ⚠ Listening on ${HOST} — reachable from the network. This server runs\n` +
        `    shells with no authentication; anyone who can reach it gets a shell.\n`
    );
  }
});
