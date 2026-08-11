import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * JSON-backed passkey credential storage for the gate (server/gate.js).
 *
 * File shape: an array of registered credentials, each:
 *   { id, publicKey (base64), counter, transports, label, createdAt }
 *
 * `publicKey` is stored base64-encoded (JSON can't hold a Uint8Array
 * directly); `forVerification()` decodes it back for @simplewebauthn/server,
 * which wants the raw bytes.
 */
export class WebAuthnStore {
  constructor(file) {
    this.file = file;
    this.data = { credentials: [] };
    if (existsSync(file)) {
      try {
        const raw = JSON.parse(readFileSync(file, "utf8"));
        this.data.credentials = Array.isArray(raw.credentials) ? raw.credentials : [];
      } catch (e) {
        console.warn(`[fleetview-gate] could not read ${file} (${e.message}); starting with no passkeys.`);
      }
    }
  }

  _persist() {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    } catch (e) {
      console.warn(`[fleetview-gate] could not write ${this.file}: ${e.message}`);
    }
  }

  list() {
    return this.data.credentials;
  }

  isEmpty() {
    return this.data.credentials.length === 0;
  }

  get(id) {
    return this.data.credentials.find((c) => c.id === id);
  }

  /** `credential` is a WebAuthnCredential from a verified registration (raw publicKey bytes). */
  add(credential, label) {
    this.data.credentials.push({
      id: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString("base64"),
      counter: credential.counter,
      transports: credential.transports || [],
      label: label || `passkey ${this.data.credentials.length + 1}`,
      createdAt: Date.now(),
    });
    this._persist();
  }

  /** The shape @simplewebauthn/server's verifyAuthenticationResponse expects: raw publicKey bytes. */
  forVerification(id) {
    const c = this.get(id);
    if (!c) return undefined;
    return { id: c.id, publicKey: new Uint8Array(Buffer.from(c.publicKey, "base64")), counter: c.counter, transports: c.transports };
  }

  updateCounter(id, counter) {
    const c = this.get(id);
    if (!c) return;
    c.counter = counter;
    this._persist();
  }

  remove(id) {
    this.data.credentials = this.data.credentials.filter((c) => c.id !== id);
    this._persist();
  }
}
