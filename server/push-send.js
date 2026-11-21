import webpush from "web-push";

/**
 * The one place that actually talks to a push service.
 *
 * Deliberately a single narrow function so the `web-push` dependency has
 * exactly one caller. Everything it does is standard and hand-rollable with
 * node:crypto — an ES256 JWT for VAPID (RFC 8292) plus ECDH/HKDF/AES-128-GCM
 * payload encryption (RFC 8291) — but the encryption step fails *silently* when
 * you get it subtly wrong: the push service accepts the body happily and no
 * browser can decrypt it, so you debug "the notification never arrives" with no
 * error anywhere. Not worth hand-rolling for a personal tool; worth keeping
 * swappable, which is what this seam is for.
 *
 * The payload is encrypted end-to-end with keys the BROWSER generated (`p256dh`
 * + `auth`, from the subscription). The push service — Apple's included — is an
 * untrusted relay that only ever sees ciphertext. That is why it's safe to put
 * a pane name in the body: Apple cannot read it.
 */

/** Returned instead of throwing, so a fan-out over many devices can decide per
 *  device whether to retry, prune, or shout.
 *  @typedef {{ok: true} | {ok: false, status: number, gone: boolean, error: string}} SendResult */

export function createSender(vapid) {
  const vapidDetails = {
    subject: vapid.contactUrl(),
    publicKey: vapid.publicKeyB64(),
    privateKey: vapid.privateKeyB64(),
  };

  /**
   * @param {{endpoint: string, p256dh: string, auth: string}} row
   * @param {string} body  JSON string; the service worker parses it
   * @returns {Promise<SendResult>}
   */
  return async function send(row, body, { ttl = 900, urgency = "high", topic } = {}) {
    try {
      await webpush.sendNotification(
        { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
        body,
        {
          vapidDetails, // passed per-call rather than webpush.setVapidDetails() global state
          // 15 minutes. A "needs you" that surfaces an hour late is worse than
          // useless — you've either already dealt with it or the agent has
          // timed out, and either way the banner is now a lie.
          TTL: ttl,
          urgency,
          ...(topic ? { topic } : {}),
          contentEncoding: "aes128gcm",
        }
      );
      return { ok: true };
    } catch (e) {
      const status = Number(e?.statusCode) || 0;
      return {
        ok: false,
        status,
        // 404/410 mean this subscription is permanently dead (the browser
        // dropped it, or the app was uninstalled) — the caller should delete the
        // row rather than retry it forever.
        gone: status === 404 || status === 410,
        error: e?.body || e?.message || String(e),
      };
    }
  };
}
