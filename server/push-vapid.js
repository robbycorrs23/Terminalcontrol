import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { generateKeyPairSync } from "node:crypto";

/**
 * The server's VAPID identity — the P-256 keypair that proves to a push service
 * (Apple's, Google's, Mozilla's) that a push for a given subscription really
 * came from this FleetView.
 *
 * Created once and then never touched. That "never" matters more than it looks:
 * a browser's push subscription is bound to the public key it was created with,
 * so REGENERATING this file silently invalidates every subscription on every
 * device, and each one only recovers when its owner opens the app and
 * re-subscribes. Hence load-or-create, never load-or-repair — a malformed file
 * is reported and fatal-ish rather than quietly replaced.
 *
 * Stored 0600 in ~/.fleetview/ alongside passkeys.json, not in the repo root
 * with layouts.json/tasks.json. The private key can mint push messages to your
 * devices, which puts it firmly in the same class as pane-secrets.json.
 */

/**
 * Who to contact if a push service needs to complain about this application
 * server. Must be a `mailto:` or `https:` URL — Apple rejects anything else
 * with `403 BadJwtToken`, and a plausible-looking `something@localhost` is the
 * single most common way to get a VAPID setup that works everywhere except iOS.
 */
const DEFAULT_CONTACT = "https://github.com/robbycorrs23/Terminalcontrol";

function readContact() {
  const raw = process.env.FLEET_PUSH_CONTACT || DEFAULT_CONTACT;
  if (/^(mailto:|https:\/\/)/.test(raw)) return raw;
  console.warn(
    `[fleetview] FLEET_PUSH_CONTACT="${raw}" is not a mailto: or https: URL — ` +
      `push services (Apple in particular) will reject it. Falling back to ${DEFAULT_CONTACT}.`
  );
  return DEFAULT_CONTACT;
}

/** Uncompressed P-256 point (0x04 || X || Y), base64url — the form
 *  `applicationServerKey` and the `k=` VAPID parameter both want. */
function publicKeyFromJwk(jwk) {
  return Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(jwk.x, "base64url"),
    Buffer.from(jwk.y, "base64url"),
  ]).toString("base64url");
}

/**
 * JSON-backed VAPID keypair.
 *
 * File shape: { publicKey, privateKey, contact, createdAt } where publicKey is
 * the base64url uncompressed point and privateKey is the base64url 32-byte `d`
 * scalar. Raw JWK components rather than PEM, so the `web-push` library and a
 * hand-rolled node:crypto sender are interchangeable (see server/push-send.js).
 */
export class VapidKeys {
  constructor(file) {
    this.file = file;
    this.contact = readContact();

    if (existsSync(file)) {
      const raw = JSON.parse(readFileSync(file, "utf8"));
      if (!raw.publicKey || !raw.privateKey) {
        // Deliberately loud and fatal rather than regenerating: see the note
        // above about silently orphaning every device's subscription.
        throw new Error(
          `${file} exists but has no keypair. Fix or delete it — deleting means ` +
            `every device must re-subscribe (open FleetView on each one).`
        );
      }
      this.publicKey = raw.publicKey;
      this.privateKey = raw.privateKey;
      return;
    }

    const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const pubJwk = publicKey.export({ format: "jwk" });
    const privJwk = privateKey.export({ format: "jwk" });
    this.publicKey = publicKeyFromJwk(pubJwk);
    this.privateKey = privJwk.d;

    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(
        file,
        JSON.stringify(
          { publicKey: this.publicKey, privateKey: this.privateKey, contact: this.contact, createdAt: Date.now() },
          null,
          2
        ),
        { mode: 0o600 }
      );
      console.log(`[fleetview] created push identity ${file} (keep it — deleting forces every device to re-subscribe)`);
    } catch (e) {
      // In-memory keys still work until restart, but subscriptions made against
      // them would break on the next boot, so say so plainly.
      console.warn(`[fleetview] could not write ${file}: ${e.message} — push subscriptions will not survive a restart.`);
    }
  }

  /** The public half, base64url — served to the client as applicationServerKey. */
  publicKeyB64() {
    return this.publicKey;
  }

  /** The private scalar `d`, base64url. */
  privateKeyB64() {
    return this.privateKey;
  }

  contactUrl() {
    return this.contact;
  }
}
