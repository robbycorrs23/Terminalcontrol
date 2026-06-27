import express from "express";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { PtyManager } from "./pty-manager.js";
import { LayoutStore } from "./layout-store.js";
import { ensureHooks } from "./setup-hooks.js";
import { listDirs, makeDir } from "./fs-browse.js";

const PORT = Number(process.env.FLEET_PORT) || 4280;
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DIST = join(ROOT, "dist");

// Make sure Claude Code knows how to phone home before any terminal starts.
ensureHooks(PORT);

const ptys = new PtyManager(PORT, join(ROOT, "sessions.json"));
const layouts = new LayoutStore(join(ROOT, "layouts.json"));
console.log(
  ptys.tmux
    ? "[fleetview] tmux-backed terminals — they survive server restarts."
    : "[fleetview] tmux not found — terminals are tied to this server process."
);

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

// Dropped images are written here so Claude can read them by absolute path —
// the same contract as dragging a file into a native terminal.
const UPLOAD_DIR = join(tmpdir(), "fleetview-images");
try {
  mkdirSync(UPLOAD_DIR, { recursive: true });
} catch {}

const app = express();
// Dropped images arrive as base64 data URLs, so allow a generous JSON body.
app.use(express.json({ limit: "30mb" }));

// --- Panes ---------------------------------------------------------------
app.get("/api/panes", (req, res) => res.json(ptys.list(req.query.session)));

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

app.post("/api/panes/:id/followup", (req, res) => {
  const id = req.params.id;
  if (!ptys.info(id)) return res.status(404).json({ error: "no such pane" });
  const on = !!(req.body && req.body.on);
  ptys.setFollowUp(id, on);
  broadcast(ptys.sessionOf(id), { t: "followup", pane: id, on });
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

  // "overwrite" clears this window's existing terminals first; "add" keeps them.
  if (mode === "overwrite") {
    for (const id of ptys.idsOf(session)) {
      ptys.kill(id);
      broadcast(session, { t: "closed", pane: id });
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

// --- Hook endpoint (Claude Code phones home here) ------------------------
app.post("/hook", (req, res) => {
  const { pane, kind } = req.body || {};
  if (pane) ptys.setAttention(pane, kind || "question");
  res.status(204).end();
});

// --- Static client -------------------------------------------------------
app.use(express.static(DIST));
app.get("*", (_req, res) => res.sendFile(join(DIST, "index.html")));

// --- HTTP + WebSocket wiring ---------------------------------------------
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
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
      // Hand the new browser only its own window's terminals.
      ws.send(JSON.stringify({ t: "panes", panes: ptys.list(session) }));
    });
  } else if (url.pathname === "/term") {
    const id = url.searchParams.get("pane");
    wss.handleUpgrade(req, socket, head, (ws) => ptys.attach(id, ws));
  } else {
    socket.destroy();
  }
});

server.listen(PORT, () => {
  console.log(`\n  ▦ FleetView → http://localhost:${PORT}\n`);
});
