import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const COOKIE_NAME = "fleet_gate_session";
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/** Read (or create, once) the HMAC secret this gate signs session cookies with. */
function loadSecret(file) {
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  const secret = randomBytes(32).toString("hex");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

/**
 * Minimal signed-cookie sessions — no server-side session store needed since
 * the only thing worth remembering is "this passkey login is still valid
 * until <exp>". Cookie value is `<base64url payload>.<base64url HMAC>`;
 * `payload` is just `{ exp }`. Forging one without the secret (stored 0600,
 * see loadSecret) is infeasible; tampering with `exp` invalidates the HMAC.
 */
export class GateSessions {
  constructor(secretFile) {
    this.secret = loadSecret(secretFile);
  }

  sign(payload) {
    const body = b64url(JSON.stringify(payload));
    const mac = b64url(createHmac("sha256", this.secret).update(body).digest());
    return `${body}.${mac}`;
  }

  /** Returns the payload if the cookie is well-formed, signed by us, and unexpired — else null. */
  verify(token) {
    if (!token) return null;
    const [body, mac] = token.split(".");
    if (!body || !mac) return null;
    const expected = b64url(createHmac("sha256", this.secret).update(body).digest());
    const a = Buffer.from(mac);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    let payload;
    try {
      payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    } catch {
      return null;
    }
    if (typeof payload.exp !== "number" || Date.now() > payload.exp) return null;
    return payload;
  }

  /** A fresh 30-day session token. */
  issue() {
    return this.sign({ exp: Date.now() + THIRTY_DAYS_MS });
  }

  cookieName() {
    return COOKIE_NAME;
  }

  maxAgeSeconds() {
    return THIRTY_DAYS_MS / 1000;
  }
}

/** Tiny Cookie-header parser — just enough to pull one named cookie out, no dependency needed. */
export function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}
