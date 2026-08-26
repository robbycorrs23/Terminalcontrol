import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Short-lived, single-use, scope-bound tokens proving "a fresh WebAuthn
 * assertion just happened" — used by the secret-inject feature (see
 * secret-vault.js) as an optional step-up confirmation on top of the passkey
 * gate (server/gate.js).
 *
 * Deliberately NOT a session: it's minted by gate.js's /gate/stepup/finish
 * after a fresh authenticator ceremony (not just an existing session cookie)
 * and is meant to be spent once, immediately, for one specific action.
 *
 * Signed with the SAME HMAC secret gate.js already uses for session cookies
 * (~/.fleetview/gate-secret, see gate-session.js) so this file's mint() runs
 * in the gate process and verify() runs in the main FleetView process
 * (server/index.js) — two separate processes that never share memory —
 * without needing an RPC between them. Anyone who can read that 0600 file is
 * already able to forge gate sessions entirely, so this adds no new secret
 * to protect.
 *
 * If the gate has never been set up on this machine (no secret file), both
 * mint() and verify() are no-ops that make that obvious rather than silently
 * inventing a key — gateConfigured() is what callers should check first to
 * decide whether step-up is even possible here.
 */

const SECRET_FILE = join(homedir(), ".fleetview", "gate-secret");
// How long a minted token is redeemable. Short: this is a "confirm right
// now" gate, not a session — a long window would let a leaked token (e.g.
// from a browser history/proxy log) be replayed well after the fact.
const TOKEN_TTL_MS = 2 * 60 * 1000;

function secret() {
  if (!existsSync(SECRET_FILE)) return null;
  try {
    return readFileSync(SECRET_FILE, "utf8").trim() || null;
  } catch {
    return null;
  }
}

function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

/** Has a passkey gate ever been run on this machine? (file existing, not "is running now".) */
export function gateConfigured() {
  return !!secret();
}

/**
 * Mint a token good for one redemption of `scope` (e.g. `secret:<paneId>`)
 * within TOKEN_TTL_MS. Throws if no gate secret exists — callers must check
 * gateConfigured() first; minting silently with no key would be worse than
 * refusing.
 */
export function mintStepUpToken(scope) {
  const s = secret();
  if (!s) throw new Error("no gate secret on this machine — passkey gate was never set up");
  const payload = { scope: String(scope), nonce: randomBytes(9).toString("base64url"), exp: Date.now() + TOKEN_TTL_MS };
  const body = b64url(JSON.stringify(payload));
  const mac = b64url(createHmac("sha256", s).update(body).digest());
  return `${body}.${mac}`;
}

// Spent tokens, by body, so a captured token (proxy log, browser history,
// XHR devtools) can't be replayed even within its TTL. Process-local and
// unpersisted on purpose — a restart losing this set just means any
// in-flight token becomes reusable again for the rest of its (short) TTL,
// which is an acceptable, bounded gap, not a silent hole.
const spent = new Set();

/** Verify + consume a token for exactly `scope`. One redemption, ever. */
export function verifyStepUpToken(token, scope) {
  const s = secret();
  if (!s || !token || typeof token !== "string") return false;
  const [body, mac] = token.split(".");
  if (!body || !mac) return false;
  const expectedMac = b64url(createHmac("sha256", s).update(body).digest());
  const a = Buffer.from(mac);
  const b = Buffer.from(expectedMac);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return false;
  }
  if (payload.scope !== scope) return false;
  if (typeof payload.exp !== "number" || Date.now() > payload.exp) return false;
  if (spent.has(body)) return false;
  spent.add(body);
  const t = setTimeout(() => spent.delete(body), TOKEN_TTL_MS + 1000);
  t.unref?.();
  return true;
}
