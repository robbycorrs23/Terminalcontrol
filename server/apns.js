import { connect } from "node:http2";
import { createPrivateKey, sign } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

/**
 * Native push for the FleetView iOS app (ios/), alongside Web Push.
 *
 * Web Push can't reach an app: inside a WKWebView there is no service worker
 * push. So the app registers its APNs device token with every machine it has
 * added (POST /api/push/apns, made from INSIDE the machine's own page so it
 * rides the gate cookie and passes the same-origin guard), and the notifier
 * fans "needs you" out here as well.
 *
 * Config — nothing here works until it's set, and that's fine (Web Push is
 * unaffected): env FLEET_APNS_KEY_PATH / _KEY_ID / _TEAM_ID / _TOPIC / _ENV,
 * else ~/.fleetview/apns.json { keyPath, keyId, teamId, topic, env }.
 *   keyPath  an APNs auth key (.p8) — team-wide, works for every app on the team
 *   topic    the app's bundle id (com.robertcorrado.fleetview)
 *   env      "production" (TestFlight / App Store — the default) or "sandbox"
 *            (a debug build run from Xcode)
 * The key is read here and nowhere else, and never leaves this process.
 *
 * No dependency: HTTP/2 + an ES256 JWT (signed with node:crypto, ieee-p1363 so
 * the signature is the raw r||s JWS wants), cached ~50 min — Apple rejects a
 * token older than an hour and throttles minting new ones too often.
 */

const FLEET_DIR = join(homedir(), ".fleetview");

export function loadApnsConfig() {
  let file = {};
  const p = join(FLEET_DIR, "apns.json");
  if (existsSync(p)) {
    try {
      file = JSON.parse(readFileSync(p, "utf8"));
    } catch (e) {
      console.warn(`[fleetview] ~/.fleetview/apns.json is not valid JSON: ${e.message}`);
    }
  }
  const cfg = {
    keyPath: process.env.FLEET_APNS_KEY_PATH || file.keyPath,
    keyId: process.env.FLEET_APNS_KEY_ID || file.keyId,
    teamId: process.env.FLEET_APNS_TEAM_ID || file.teamId,
    topic: process.env.FLEET_APNS_TOPIC || file.topic || "com.robertcorrado.fleetview",
    env: (process.env.FLEET_APNS_ENV || file.env || "production") === "sandbox" ? "sandbox" : "production",
  };
  if (cfg.keyPath) cfg.keyPath = cfg.keyPath.replace(/^~(?=\/)/, homedir());
  return cfg;
}

/** @typedef {{ok: true} | {ok: false, status: number, gone: boolean, reason: string}} ApnsResult */

export function createApns(cfg = loadApnsConfig()) {
  let key = null;
  if (cfg.keyPath && cfg.keyId && cfg.teamId) {
    try {
      key = createPrivateKey(readFileSync(cfg.keyPath, "utf8"));
    } catch (e) {
      console.warn(`[fleetview] APNs key unreadable (${cfg.keyPath}): ${e.message} — app push disabled`);
    }
  }
  // cfg.host only exists for tests (a local h2c stand-in for Apple).
  const host = cfg.host || (cfg.env === "sandbox" ? "https://api.sandbox.push.apple.com" : "https://api.push.apple.com");
  let jwt = { token: "", at: 0 };
  let session = null;

  function bearer() {
    const now = Math.floor(Date.now() / 1000);
    if (jwt.token && now - jwt.at < 50 * 60) return jwt.token;
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const head = b64({ alg: "ES256", kid: cfg.keyId });
    const claims = b64({ iss: cfg.teamId, iat: now });
    const sig = sign("sha256", Buffer.from(`${head}.${claims}`), { key, dsaEncoding: "ieee-p1363" }).toString("base64url");
    jwt = { token: `${head}.${claims}.${sig}`, at: now };
    return jwt.token;
  }

  function client() {
    if (session && !session.closed && !session.destroyed) return session;
    session = connect(host);
    session.on("error", () => {}); // surfaced per request; a dead session is simply re-made
    session.setTimeout(10 * 60 * 1000, () => session?.close()); // don't hold an idle connection forever
    return session;
  }

  /**
   * @param {string} token  device token (hex)
   * @param {object} payload  the full APNs JSON ({aps: {...}, ...custom})
   * @returns {Promise<ApnsResult>}
   */
  function send(token, payload, { collapseId, priority = 10, expirySec = 900 } = {}) {
    if (!key) return Promise.resolve({ ok: false, status: 0, gone: false, reason: "not configured" });
    return new Promise((resolve) => {
      let req;
      try {
        req = client().request({
          ":method": "POST",
          ":path": `/3/device/${token}`,
          authorization: `bearer ${bearer()}`,
          "apns-topic": cfg.topic,
          "apns-push-type": "alert",
          "apns-priority": String(priority),
          "apns-expiration": String(Math.floor(Date.now() / 1000) + expirySec),
          ...(collapseId ? { "apns-collapse-id": collapseId.slice(0, 64) } : {}),
        });
      } catch (e) {
        return resolve({ ok: false, status: 0, gone: false, reason: e.message });
      }
      let status = 0;
      let body = "";
      req.setTimeout(15000, () => req.close());
      req.on("response", (h) => (status = Number(h[":status"]) || 0));
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (status === 200) return resolve({ ok: true });
        let reason = "";
        try {
          reason = JSON.parse(body).reason || "";
        } catch {}
        // 410 Unregistered = the app was deleted; BadDeviceToken = a token from
        // the other environment (or garbage). Neither will ever succeed.
        const gone = status === 410 || reason === "BadDeviceToken" || reason === "DeviceTokenNotForTopic";
        resolve({ ok: false, status, gone, reason: reason || `HTTP ${status}` });
      });
      req.on("error", (e) => resolve({ ok: false, status: 0, gone: false, reason: e.message }));
      req.end(JSON.stringify(payload));
    });
  }

  return { enabled: !!key, env: cfg.env, topic: cfg.topic, send };
}

/** Registered app devices for THIS machine: ~/.fleetview/apns-devices.json (0600). */
export class ApnsDevices {
  constructor(file = join(FLEET_DIR, "apns-devices.json")) {
    this.file = file;
    this.rows = [];
    try {
      const d = JSON.parse(readFileSync(file, "utf8"));
      if (Array.isArray(d)) this.rows = d.filter((r) => r && /^[0-9a-f]{32,200}$/i.test(r.token));
    } catch {}
  }
  save() {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.rows, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
  count() {
    return this.rows.length;
  }
  list() {
    return this.rows.slice();
  }
  /** Add/refresh a device. `origin` = the URL the app reaches this machine at (for the tap deep link). */
  upsert({ token, origin, name }) {
    if (typeof token !== "string" || !/^[0-9a-f]{32,200}$/i.test(token)) return null;
    const o = typeof origin === "string" && /^https?:\/\/[^\s/]+$/.test(origin) ? origin : "";
    const row = { token: token.toLowerCase(), origin: o, name: String(name || "").slice(0, 60), at: Date.now() };
    this.rows = [row, ...this.rows.filter((r) => r.token !== row.token)].slice(0, 20);
    this.save();
    return row;
  }
  remove(token) {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => r.token !== String(token || "").toLowerCase());
    if (this.rows.length !== before) this.save();
  }
}
