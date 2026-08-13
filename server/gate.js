import express from "express";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import httpProxy from "http-proxy";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import { WebAuthnStore } from "./webauthn-store.js";
import { GateSessions, readCookie } from "./gate-session.js";

// Phase 1 of the passkey gate (see TAILSCALE.md "Going further"): sits in
// front of FleetView's real app and requires a passkey-backed session before
// proxying anything through. Point `tailscale serve` at THIS process's port,
// not FleetView's directly. Phase 2 (a dedicated system account + Unix
// socket instead of TARGET below) is what closes the "any local process on
// this Mac can skip the gate" gap — this phase closes the "lost/stolen but
// still-tailnet-enrolled device" gap on its own.

const PORT = Number(process.env.FLEET_GATE_PORT) || 4290;
// FLEET_GATE_TARGET_SOCKET (a Unix socket path — see FLEET_GATE_SOCKET in
// server/index.js) takes priority when set: that's the hardened path, only
// reachable by whichever OS account owns that socket file. Falls back to
// plain loopback TCP otherwise, which is also what FleetView listens on by
// default with no extra setup — anything already running on this machine
// can reach that port directly, gate or no gate. See TAILSCALE.md "What
// this doesn't close yet" for the tradeoff.
const TARGET = process.env.FLEET_GATE_TARGET_SOCKET
  ? { socketPath: process.env.FLEET_GATE_TARGET_SOCKET }
  : process.env.FLEET_GATE_TARGET || "http://127.0.0.1:4280";
const RP_NAME = process.env.FLEET_GATE_RP_NAME || "FleetView";
// Must be a real domain WebAuthn will bind credentials to, not an IP — set
// FLEET_GATE_RP_ID to your tailnet hostname (e.g. did2200.tail5df669.ts.net)
// for real use; "localhost" only works for local testing.
const RP_ID = process.env.FLEET_GATE_RP_ID || "localhost";
const ORIGIN = process.env.FLEET_GATE_ORIGIN || `http://localhost:${PORT}`;
// Browsers refuse to set a `Secure` cookie over plain HTTP — set this for
// local testing against http://localhost; never set it for real tailnet use
// (tailscale serve terminates real HTTPS, so Secure should stay on there).
const INSECURE_COOKIE = process.env.FLEET_GATE_INSECURE_COOKIE === "1";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(homedir(), ".fleetview");
const store = new WebAuthnStore(join(STATE_DIR, "passkeys.json"));
const sessions = new GateSessions(join(STATE_DIR, "gate-secret"));

const loginHtml = readFileSync(join(__dirname, "gate-login.html"), "utf8");
const webauthnBrowserJs = readFileSync(
  join(__dirname, "../node_modules/@simplewebauthn/browser/dist/bundle/index.umd.min.js"),
  "utf8"
);

const app = express();

function isLoggedIn(req) {
  return !!sessions.verify(readCookie(req, sessions.cookieName()));
}
function setSessionCookie(res) {
  const attrs = [
    `${sessions.cookieName()}=${sessions.issue()}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${sessions.maxAgeSeconds()}`,
  ];
  if (!INSECURE_COOKIE) attrs.push("Secure");
  res.setHeader("Set-Cookie", attrs.join("; "));
}
function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${sessions.cookieName()}=; Path=/; Max-Age=0`);
}

// ---- Gate's own routes (auth ceremonies + static assets) -----------------
const gate = express.Router();
gate.use(express.json());

gate.get("/webauthn-browser.js", (_req, res) => {
  res.type("application/javascript").send(webauthnBrowserJs);
});
gate.get("/login", (_req, res) => res.type("html").send(loginHtml));
gate.get("/status", (req, res) => {
  res.json({ loggedIn: isLoggedIn(req), hasPasskeys: !store.isEmpty() });
});

// A registration ceremony's challenge has to be remembered between /start and
// /finish. Single pending slot, not session-keyed: this gate serves one
// operator, not concurrent unrelated users, so one in-flight ceremony at a
// time is the realistic case — simpler than a full challenge store.
let pendingRegistration = null;
let pendingAuthentication = null;

gate.post("/register/start", async (req, res) => {
  // Bootstrap: the very first passkey can be registered by anyone who can
  // reach the gate (there's nothing to protect yet). Once one exists, adding
  // more requires already being signed in — otherwise anyone who could reach
  // this endpoint could just add their own passkey and let themselves in.
  if (!store.isEmpty() && !isLoggedIn(req)) {
    return res.status(401).json({ error: "sign in before adding another passkey" });
  }
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: RP_ID,
    userName: "fleetview",
    userDisplayName: "FleetView",
    excludeCredentials: store.list().map((c) => ({ id: c.id, transports: c.transports })),
    authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
  });
  pendingRegistration = { challenge: options.challenge, label: (req.body && req.body.label) || undefined };
  res.json(options);
});

gate.post("/register/finish", async (req, res) => {
  if (!pendingRegistration) return res.status(400).json({ error: "no registration in progress" });
  const { challenge, label } = pendingRegistration;
  pendingRegistration = null;
  try {
    const result = await verifyRegistrationResponse({
      response: req.body.response,
      expectedChallenge: challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
    });
    if (!result.verified || !result.registrationInfo) {
      return res.status(400).json({ error: "registration could not be verified" });
    }
    store.add(result.registrationInfo.credential, req.body.label || label);
    setSessionCookie(res);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

gate.post("/login/start", async (_req, res) => {
  const options = await generateAuthenticationOptions({
    rpID: RP_ID,
    userVerification: "preferred",
    // No allowCredentials on purpose: passkeys created above are resident/
    // discoverable, so the browser's own picker shows whichever are
    // registered on this device — the server doesn't need to enumerate them.
  });
  pendingAuthentication = options.challenge;
  res.json(options);
});

gate.post("/login/finish", async (req, res) => {
  if (!pendingAuthentication) return res.status(400).json({ error: "no sign-in in progress" });
  const challenge = pendingAuthentication;
  pendingAuthentication = null;
  const response = req.body;
  const credential = store.forVerification(response.id);
  if (!credential) return res.status(400).json({ error: "unrecognized passkey" });
  try {
    const result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      credential,
    });
    if (!result.verified) return res.status(400).json({ error: "sign-in could not be verified" });
    store.updateCounter(response.id, result.authenticationInfo.newCounter);
    setSessionCookie(res);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

gate.post("/logout", (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.use("/gate", gate);

// ---- Everything else: session-gated reverse proxy to FleetView -----------
// No express.json() (or any other body-consuming middleware) ahead of this —
// http-proxy needs the raw, unconsumed request stream to forward bodies
// (including FleetView's own 30mb image-drop payloads) correctly.
const proxy = httpProxy.createProxyServer({ target: TARGET, ws: true, xfwd: true });
proxy.on("error", (err, _req, res) => {
  console.warn(`[fleetview-gate] proxy error: ${err.message}`);
  if (res && !res.headersSent) res.writeHead(502).end("FleetView is unreachable through the gate");
});

app.use((req, res) => {
  if (!isLoggedIn(req)) {
    if (req.method === "GET" && req.headers.accept?.includes("text/html")) {
      return res.redirect("/gate/login");
    }
    return res.status(401).json({ error: "sign in required" });
  }
  proxy.web(req, res);
});

const server = createServer(app);
server.on("upgrade", (req, socket, head) => {
  if (!isLoggedIn(req)) {
    socket.destroy();
    return;
  }
  proxy.ws(req, socket, head);
});

const targetDescription = typeof TARGET === "string" ? TARGET : TARGET.socketPath;
server.listen(PORT, "127.0.0.1", () => {
  console.log(`[fleetview-gate] listening on http://127.0.0.1:${PORT}, proxying to ${targetDescription}`);
  console.log(
    store.isEmpty()
      ? `[fleetview-gate] no passkeys registered yet — visit /gate/login to set one up`
      : `[fleetview-gate] ${store.list().length} passkey(s) registered`
  );
});
