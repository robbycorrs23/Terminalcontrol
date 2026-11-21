import { basename } from "node:path";

/**
 * Turns a pane's "attention" event into a push notification on every subscribed
 * device.
 *
 * Wired into `broadcast()` in index.js rather than into `ptys.on("attention")`,
 * and that choice is load-bearing: PTY panes reach the client via the emitter,
 * but agent/chat panes call `broadcast()` DIRECTLY from agent-manager.js. Hook
 * the emitter and every chat pane — the default kind for agent boxes — silently
 * never notifies.
 *
 * What is deliberately NOT here: any check for whether a browser window is
 * currently open. A closed control socket does not mean the window is gone
 * (bfcache, sleep, a throttled hidden tab — see the SESSION_GRACE_MS notes in
 * index.js), and the device that most needs the push is precisely the one with
 * no socket. Foreground de-duplication happens in the service worker, which is
 * the only place that actually knows whether a window is visible.
 */

// Collapse repeats of the same pane+kind. A hook storm (an agent that asks
// three questions in a second) should buzz your pocket once, not three times.
const COOLDOWN_MS = 5000;

/** What to call this pane on your lock screen.
 *
 *  Mirrors `displayName()` in client/src/terminal.ts so the notification says
 *  the same thing as the chip you'll tap: the custom name, else the folder's
 *  basename. Note the basename is a single path SEGMENT, never a full path —
 *  for a stricter "no filesystem information at all" posture, drop the
 *  `basename(...)` term and unnamed panes become "Terminal". */
function label(info) {
  return info?.name || basename(info?.cwd || "") || "Terminal";
}

/** Title/body text. Kept identical to the in-page notification copy in
 *  main.ts's notifyAttention() so the two notifiers are indistinguishable. */
function textFor(name, kind) {
  if (kind === "done") return { title: `${name} finished`, body: "The agent ended its turn." };
  if (kind === "aborted") {
    return {
      title: `${name} was cut off`,
      body: "The turn was interrupted before finishing — the response may be incomplete.",
    };
  }
  return { title: `${name} needs you`, body: "Waiting on an approval or an answer." };
}

/**
 * @param {object} deps
 * @param {{info: (id: string) => any, list: (session?: string) => any[]}} deps.registry
 * @param {() => object} deps.prefs      reads current prefs (pushQuestion / pushDone)
 * @param {import("./push-store.js").PushStore} deps.store
 * @param {(row: object, body: string, opts?: object) => Promise<any>} deps.send
 */
export function createPushNotifier({ registry, prefs, store, send }) {
  const lastSent = new Map(); // `${paneId}:${kind}` -> timestamp

  function allowed(kind) {
    const p = prefs() || {};
    // "aborted" is a flavour of finishing, so it rides with the done toggle.
    return kind === "question" ? p.pushQuestion !== false : !!p.pushDone;
  }

  function waitingCount() {
    try {
      return registry.list().filter((p) => p?.attention?.waiting).length;
    } catch {
      return 0;
    }
  }

  /** Fire-and-forget. MUST NOT be awaited by broadcast(), which is hot for
   *  `work` events on streaming panes. */
  function onAttention(paneId, kind, session) {
    if (!paneId) return;
    if (!allowed(kind)) return;
    if (!store.count()) return; // nobody subscribed — costs nothing

    const key = `${paneId}:${kind}`;
    const now = Date.now();
    const prev = lastSent.get(key) || 0;
    if (now - prev < COOLDOWN_MS) return;
    lastSent.set(key, now);
    if (lastSent.size > 200) {
      // Bounded without a timer: drop anything older than the cooldown.
      for (const [k, t] of lastSent) if (now - t > COOLDOWN_MS) lastSent.delete(k);
    }

    // info() returns null for a dormant pane, and an attention event can arrive
    // for a pane that just died — hence the guard, so we never push
    // "undefined needs you".
    const info = registry.info(paneId);
    const name = label(info);
    const { title, body } = textFor(name, kind);
    const count = waitingCount();

    void fanOut({ paneId, kind, name, title, body, count, session });
  }

  async function fanOut(msg) {
    const rows = [...store.list()];

    await Promise.allSettled(
      rows.map(async (row) => {
        // Per-device payload: the deep link has to be built from the origin
        // THIS device reaches FleetView on (the tailnet hostname, not the
        // loopback address the server binds).
        const origin = row.origin || "";
        // No `?session=` needed: every client of this server sees the same
        // fleet, so the pane id alone is enough to land on the right box.
        const url = origin ? `${origin}/#pane=${encodeURIComponent(msg.paneId)}` : "/";

        const payload = JSON.stringify({
          v: 1,
          t: "attention",
          pane: msg.paneId,
          kind: msg.kind,
          name: msg.name,
          title: msg.title,
          body: msg.body,
          count: msg.count,
          url,
          at: Date.now(),
        });

        const res = await send(row, payload, {
          urgency: msg.kind === "question" ? "high" : "normal",
          // Collapse undelivered notifications for the same pane while a device
          // is offline, so unlocking your phone after a nap doesn't unroll ten
          // identical banners. Truncated to the 32-char header limit.
          topic: topicFor(msg.paneId),
        });

        if (res.ok) {
          store.markOk(row.endpoint);
          return;
        }

        const dropped = store.markFailed(row.endpoint, res.status);
        if (res.gone) return; // expected end-of-life, not worth logging

        // 401/403 is a VAPID misconfiguration (bad contact subject, wrong key)
        // — it will fail identically for every device forever, so say so
        // clearly instead of burying it in a per-device warning.
        if (res.status === 401 || res.status === 403) {
          console.warn(
            `[fleetview] push rejected (${res.status}) — check FLEET_PUSH_CONTACT and ~/.fleetview/vapid.json: ${res.error}`
          );
        } else {
          console.warn(
            `[fleetview] push to ${short(row.endpoint)} failed (${res.status || "network"})${dropped ? " — subscription dropped" : ""}`
          );
        }
      })
    );
  }

  return { onAttention };
}

/** A stable, header-safe Topic for a pane id (base64url, <=32 chars). */
function topicFor(paneId) {
  return Buffer.from(String(paneId)).toString("base64url").slice(0, 32);
}

function short(endpoint) {
  try {
    return new URL(endpoint).host;
  } catch {
    return "push service";
  }
}
