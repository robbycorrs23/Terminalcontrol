/* FleetView service worker — notifications only.
 *
 * Lives in client/public/ so Vite copies it verbatim to dist/sw.js: it is NOT
 * bundled, NOT typechecked, and has no imports. Keep it plain ES2020 that a
 * browser can run as-is.
 *
 * ⚠ There is deliberately NO `fetch` handler here, and adding one is a trap.
 * server/index.js serves index.html with Cache-Control: no-store on purpose
 * (see the long comment above `noStoreIndexHtml`): its only job is to name the
 * current content-hashed bundle, so a stale copy silently runs old code
 * forever. A caching SW would reintroduce exactly that bug, and worse — a SW
 * cache survives a hard reload. Offline support is meaningless here anyway; the
 * app is a live view of PTYs on a machine you must be able to reach. Chrome
 * dropped the fetch-handler installability requirement (108 mobile / 112
 * desktop) and iOS never had one, so a no-fetch SW is fully installable.
 *
 * The one hard rule below: EVERY push event must end in a shown notification.
 * WebKit revokes the push subscription of a worker that receives a push and
 * displays nothing, and recovery requires the user to delete and re-add the
 * home-screen app. So every path through handlePush() calls showNotification,
 * including the parse-failure path.
 */

const DEFAULT_TITLE = "FleetView";
const DEFAULT_BODY = "A terminal needs you.";

/* Foreground suppression is opt-IN per engine, not a default.
 *
 * "Don't notify if a window is already visible" is the polite behaviour, but on
 * WebKit it IS the revocation trigger above — silence is indistinguishable from
 * a broken worker. So we only ever suppress on engines documented to tolerate
 * it, and on iOS we accept a redundant banner while the app is open in front of
 * you. A duplicate notification is a papercut; a dead subscription is a
 * feature that quietly stops working forever. */
const CAN_SUPPRESS = /\b(Chrome|Chromium|Edg|Firefox)\//.test(self.navigator.userAgent);

self.addEventListener("install", () => {
  // Take over immediately rather than waiting for every tab to close — this
  // worker has no cached state that a version skew could corrupt.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  // waitUntil is not optional: without it the worker can be killed before
  // showNotification() settles, which reads to the OS as "showed nothing".
  event.waitUntil(handlePush(event));
});

async function handlePush(event) {
  // Never let a malformed payload throw before a notification exists.
  let m = {};
  try {
    m = event.data ? event.data.json() : {};
  } catch {
    m = {};
  }

  const title = m.title || DEFAULT_TITLE;
  const body = m.body || DEFAULT_BODY;
  const pane = m.pane || "";

  const windows = await self.clients.matchAll({ includeUncontrolled: true, type: "window" });
  const visible = windows.some((c) => c.visibilityState === "visible");

  // Let any open window react in-app (flash the box, re-sort the list) even if
  // we also show a banner. The control socket normally drives this; the push is
  // racing it and either may arrive first, so the page treats this as a hint.
  for (const c of windows) {
    try {
      c.postMessage({ t: "push-attention", pane, kind: m.kind || "question" });
    } catch {
      /* a client can go away mid-loop; nothing to do */
    }
  }

  if (typeof m.count === "number") {
    try {
      if (m.count > 0) await self.navigator.setAppBadge(m.count);
      else await self.navigator.clearAppBadge();
    } catch {
      /* Badging API is absent on some engines — never fatal */
    }
  }

  if (visible && CAN_SUPPRESS) return;

  return self.registration.showNotification(title, {
    body,
    // One notification per pane: a pane that pings twice replaces its own
    // banner instead of stacking a second one. Mirrors the `tag: t.id` the
    // page-level Notification path already uses in main.ts.
    tag: pane ? `pane:${pane}` : "fleetview",
    renotify: true,
    icon: "/icon-192.png",
    badge: "/badge-96.png",
    data: { pane, session: m.session || "", url: m.url || "/" },
  });
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(focusOrOpen(event.notification.data || {}));
});

async function focusOrOpen(data) {
  const windows = await self.clients.matchAll({ includeUncontrolled: true, type: "window" });

  // Prefer an existing window: reusing it keeps the live control socket and the
  // already-hydrated panes, where openWindow would cold-start the whole app.
  for (const c of windows) {
    try {
      await c.focus();
      c.postMessage({ t: "focus-pane", pane: data.pane || "", session: data.session || "" });
      return;
    } catch {
      /* focus() can reject; fall through to the next client, then openWindow */
    }
  }

  // Nothing open. The pane id rides in the URL fragment because that is the
  // only part of `url` that survives to a cold-started page in a form the app
  // can read on boot (main.ts consumes `#pane=` once the first panes snapshot
  // arrives — panes don't exist before then).
  try {
    await self.clients.openWindow(data.url || "/");
  } catch {
    /* nothing more we can do from here */
  }
}

/* Best-effort only. iOS Safari does not fire this event at all, so the real
 * mechanism for keeping subscriptions fresh is page-driven re-validation in
 * client/src/push.ts (which runs with a live gate cookie). This handler helps
 * on Chrome/Firefox and is harmless where it never fires. It will also fail
 * with a 401 once the gate session has expired — swallowed on purpose. */
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(resubscribe(event));
});

async function resubscribe(event) {
  try {
    const key = event.oldSubscription?.options?.applicationServerKey;
    if (!key) return;
    const sub = await self.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: key,
    });
    await fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...sub.toJSON(), origin: self.location.origin }),
    });
  } catch {
    /* see comment above — the page path is the reliable one */
  }
}
