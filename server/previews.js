import { execFile } from "node:child_process";
import { readFileSync, writeFileSync, renameSync, existsSync, readlinkSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import httpProxy from "http-proxy";

/**
 * Live preview: open the app a session is building — its dev server — on your
 * phone, over your tailnet.
 *
 *  1. FIND: TCP listeners whose process runs INSIDE a session's folder (so
 *     Adobe/MySQL/… on the same machine never show up). macOS: lsof for
 *     listeners + each pid's cwd. Linux: ss + /proc/<pid>/cwd.
 *  2. SHARE: a tiny per-preview relay on 127.0.0.1 (http-proxy, changeOrigin +
 *     ws) in front of the dev server, and `tailscale serve --https=<port>` in
 *     front of the relay → https://<this-machine>.<tailnet>.ts.net:<port>/.
 *     The relay exists because dev servers (Vite and friends) reject requests
 *     whose Host isn't localhost ("Blocked request. This host is not
 *     allowed") — it rewrites Host, and passes WebSockets so live reload works.
 *  3. Tailnet-only (`serve`, never `funnel`). It does NOT go through the
 *     passkey gate — the UI says so. Nothing is shared until you ask.
 *
 * Shares persist in ~/.fleetview/previews.json and their relays are re-made on
 * startup (tailscale keeps its own serve config across restarts); a share whose
 * dev server has gone away is dropped.
 */

const FILE = join(homedir(), ".fleetview", "previews.json");
const RESERVED_EXTERNAL = new Set([443, 8443]); // ports FleetView itself is usually served on
// Never a page: agents' own MCP/IDE sockets and databases.
const NOT_WEB = /^(claude|codex|mysqld|mariadbd|postgres|redis-server|mongod|memcached|ssh|sshd|tailscaled?)$/i;

/** Does it answer HTTP? (Filters databases and other raw-TCP listeners.) */
async function speaksHttp(host, port) {
  const h = host === "::1" || host === "[::1]" ? "[::1]" : "127.0.0.1";
  try {
    await fetch(`http://${h}:${port}/`, { redirect: "manual", signal: AbortSignal.timeout(1500) });
    return true;
  } catch {
    return false;
  }
}

function run(cmd, args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err ? "" : String(stdout)));
  });
}

async function tailscaleBin() {
  for (const c of ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/usr/bin/tailscale"]) {
    const out = await run(c, ["version"], 4000);
    if (out) return c;
  }
  return null;
}

/** TCP listeners: [{ pid, command, port, host }] */
async function listeners() {
  const out = [];
  if (process.platform === "darwin") {
    const raw = await run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"]);
    let pid = 0;
    let command = "";
    for (const line of raw.split("\n")) {
      if (line[0] === "p") pid = Number(line.slice(1));
      else if (line[0] === "c") command = line.slice(1);
      else if (line[0] === "n") {
        const m = /^(.*):(\d+)$/.exec(line.slice(1));
        if (m) out.push({ pid, command, host: m[1], port: Number(m[2]) });
      }
    }
  } else {
    const raw = await run("ss", ["-ltnpH"]);
    for (const line of raw.split("\n")) {
      const m = /\s(\S+):(\d+)\s+\S+\s+users:\(\("([^"]+)",pid=(\d+)/.exec(line);
      if (m) out.push({ host: m[1], port: Number(m[2]), command: m[3], pid: Number(m[4]) });
    }
  }
  return out;
}

async function cwdsOf(pids) {
  const map = new Map();
  if (!pids.length) return map;
  if (process.platform === "darwin") {
    const raw = await run("lsof", ["-a", "-d", "cwd", "-p", pids.join(","), "-Fpn"]);
    let pid = 0;
    for (const line of raw.split("\n")) {
      if (line[0] === "p") pid = Number(line.slice(1));
      else if (line[0] === "n" && pid) map.set(pid, line.slice(1));
    }
  } else {
    for (const pid of pids) {
      try {
        map.set(pid, readlinkSync(`/proc/${pid}/cwd`));
      } catch {}
    }
  }
  return map;
}

export function createPreviews({ ownPorts = [] } = {}) {
  let shares = {}; // devPort -> { devPort, relayPort, external, url, host, at }
  const relays = new Map(); // devPort -> http.Server
  let dnsName = null;

  try {
    if (existsSync(FILE)) shares = JSON.parse(readFileSync(FILE, "utf8")).shares || {};
  } catch {}
  const save = () => {
    mkdirSync(dirname(FILE), { recursive: true });
    writeFileSync(FILE + ".tmp", JSON.stringify({ shares }, null, 2), { mode: 0o600 });
    renameSync(FILE + ".tmp", FILE);
  };

  async function hostName() {
    if (dnsName) return dnsName;
    const ts = await tailscaleBin();
    if (!ts) return null;
    try {
      dnsName = JSON.parse(await run(ts, ["status", "--json"])).Self.DNSName.replace(/\.$/, "");
    } catch {}
    return dnsName;
  }

  /** Dev servers running inside any of `folders` (session cwds). */
  async function find(folders) {
    const dirs = folders.filter(Boolean).map((f) => f.replace(/\/+$/, ""));
    const ls = (await listeners()).filter(
      // 49152+ is the OS's ephemeral range: tool sockets, not dev servers.
      (l) => !ownPorts.includes(l.port) && l.port >= 1024 && l.port < 49152 && !NOT_WEB.test(l.command)
    );
    const cwd = await cwdsOf([...new Set(ls.map((l) => l.pid))]);
    const byPort = new Map();
    for (const l of ls) {
      const c = cwd.get(l.pid) || "";
      const folder = dirs.find((d) => c === d || c.startsWith(d + "/"));
      if (!folder) continue;
      const prev = byPort.get(l.port);
      // Prefer the IPv4 loopback entry when a server listens on both.
      if (!prev || (prev.host !== "127.0.0.1" && l.host === "127.0.0.1")) {
        byPort.set(l.port, { port: l.port, pid: l.pid, command: l.command, cwd: c, folder, host: l.host });
      }
    }
    const found = [...byPort.values()];
    const web = await Promise.all(found.map((s) => speaksHttp(s.host, s.port)));
    return found
      .filter((_, i) => web[i])
      .sort((a, b) => a.port - b.port)
      .map((s) => ({ ...s, shared: shares[s.port] ? shares[s.port].url : null }));
  }

  /** Start (or re-start) the local relay for a dev server. Resolves to its port. */
  function startRelay(devPort, host, relayPort = 0) {
    const target = `http://${host === "::1" || host === "[::1]" ? "[::1]" : "127.0.0.1"}:${devPort}`;
    const proxy = httpProxy.createProxyServer({ target, changeOrigin: true, ws: true, xfwd: false });
    proxy.on("error", (err, _req, res) => {
      if (res && typeof res.writeHead === "function") {
        if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
        res.end(`The preview isn't responding — is the dev server on port ${devPort} still running?\n`);
      } else res?.destroy?.();
    });
    const server = createServer((req, res) => proxy.web(req, res));
    server.on("upgrade", (req, socket, head) => proxy.ws(req, socket, head));
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(relayPort, "127.0.0.1", () => {
        relays.set(devPort, server);
        resolve(server.address().port);
      });
    });
  }

  async function share(devPort, host = "127.0.0.1") {
    devPort = Number(devPort);
    if (!Number.isInteger(devPort) || devPort < 1024 || devPort > 65535) throw new Error("Bad port.");
    if (shares[devPort] && relays.has(devPort)) return shares[devPort];
    const ts = await tailscaleBin();
    if (!ts) throw new Error("Tailscale isn't available on this machine.");
    const dns = await hostName();
    if (!dns) throw new Error("Couldn't find this machine's tailnet name.");
    const relayPort = await startRelay(devPort, host, shares[devPort]?.relayPort || 0);
    // Same number outside as inside when we can (easy to recognise); never the
    // ports FleetView itself is served on.
    const external = RESERVED_EXTERNAL.has(devPort) ? devPort + 10000 : devPort;
    const out = await new Promise((resolve) =>
      execFile(ts, ["serve", "--bg", `--https=${external}`, `http://127.0.0.1:${relayPort}`], { timeout: 15000 }, (err, so, se) =>
        resolve(err ? String(se || err.message) : "")
      )
    );
    if (out) {
      relays.get(devPort)?.close();
      relays.delete(devPort);
      throw new Error(`Tailscale wouldn't share it: ${out.split("\n")[0]}`);
    }
    shares[devPort] = { devPort, relayPort, external, host, url: `https://${dns}:${external}/`, at: Date.now() };
    save();
    return shares[devPort];
  }

  async function unshare(devPort) {
    devPort = Number(devPort);
    const s = shares[devPort];
    if (!s) return false;
    const ts = await tailscaleBin();
    if (ts) await run(ts, ["serve", `--https=${s.external}`, "off"], 15000);
    relays.get(devPort)?.close();
    relays.delete(devPort);
    delete shares[devPort];
    save();
    return true;
  }

  /** On startup: bring back relays for shares whose dev server still runs; drop the rest. */
  async function restore() {
    const ports = Object.keys(shares).map(Number);
    if (!ports.length) return;
    const live = new Set((await listeners()).map((l) => l.port));
    for (const p of ports) {
      if (!live.has(p)) {
        await unshare(p).catch(() => {});
        continue;
      }
      await startRelay(p, shares[p].host, shares[p].relayPort).catch(async () => {
        // Relay port taken meanwhile: re-share on a fresh one.
        const host = shares[p].host;
        await unshare(p).catch(() => {});
        await share(p, host).catch(() => {});
      });
    }
  }

  return { find, share, unshare, restore, list: () => Object.values(shares) };
}
