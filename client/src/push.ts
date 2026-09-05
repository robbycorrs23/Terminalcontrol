/**
 * Web Push: the only way FleetView can reach you when it isn't open.
 *
 * The existing in-page alerts (glow, ding, `new Notification()` in main.ts) all
 * need a live tab. A phone in your pocket has no live tab, so a pane that wants
 * approval just waits silently — which is the one thing this whole
 * attention-hook design exists to prevent. A push subscription plus the service
 * worker in client/public/sw.js closes that gap.
 *
 * Platform constraints worth knowing before changing anything here:
 *
 *  - **iOS gives the Push API only to home-screen web apps** (16.4+). In a
 *    normal Safari tab `window.PushManager` is simply absent, so `enablePush()`
 *    explains that rather than failing cryptically.
 *  - **Permission must be requested from a user gesture.** A checkbox `change`
 *    handler counts; module load does not. Hence the split between `initPush()`
 *    (safe at boot, never prompts) and `enablePush()` (gesture only).
 *  - **Secure context required.** https, or http://localhost. A LAN IP has no
 *    `serviceWorker` at all.
 *  - **`pushsubscriptionchange` never fires on iOS**, and `getSubscription()`
 *    can return null after an app restart and then hand back a *different*
 *    endpoint. So freshness is page-driven: `syncPushSubscription()` re-POSTs
 *    the current subscription at boot and when the app becomes visible
 *    (throttled), while a real gate cookie exists.
 */

const SYNC_MARK = "fleet-push-synced";
const SYNC_EVERY_MS = 6 * 60 * 60 * 1000; // 6h — cheap insurance, not a heartbeat

let registration: ServiceWorkerRegistration | null = null;
let subscribed = false;
let sessionId = "";

/** Whether this browser can do Web Push at all. On iOS this is false in a
 *  Safari tab and true only in the installed home-screen app. */
export function pushSupported(): boolean {
  return (
    "serviceWorker" in navigator && "PushManager" in window && window.isSecureContext === true
  );
}

/** Running as an installed app rather than a browser tab. */
export function isStandalone(): boolean {
  return (
    matchMedia("(display-mode: standalone)").matches || (navigator as any).standalone === true
  );
}

/** Synchronous "is this device receiving pushes?" — used by main.ts to decide
 *  whether the service worker owns notifications for this device, so exactly
 *  one notifier fires instead of both it and the in-page `new Notification()`. */
export function pushActive(): boolean {
  return subscribed;
}

/**
 * Set the home-screen icon badge to the number of panes waiting on you.
 * Wrapped because the Badging API is missing on most engines and throws on
 * some; a badge is a nicety and must never break the caller.
 */
export function setBadge(count: number): void {
  const nav = navigator as any;
  try {
    if (count > 0) void nav.setAppBadge?.(count);
    else void nav.clearAppBadge?.();
  } catch {
    /* unsupported — ignore */
  }
}

/**
 * Register the service worker and, if push permission was already granted on a
 * previous visit, quietly re-validate the subscription. Never prompts, so it is
 * safe to call at boot.
 */
export async function initPush(session: string): Promise<void> {
  sessionId = session;
  if (!pushSupported()) return;

  try {
    // Absolute path on purpose: this must resolve to the ROOT scope regardless
    // of the page's current URL. A relative "sw.js" would scope the worker to
    // whatever directory the page appears to live in.
    registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  } catch (e) {
    // A 401 here means the gate session expired mid-session; a MIME error means
    // dist/sw.js is missing (server/index.js 404s that path explicitly so it
    // doesn't masquerade as index.html). Either way: no push, app unaffected.
    console.warn("[push] service worker registration failed:", e);
    return;
  }

  if (Notification.permission !== "granted") return;
  await syncPushSubscription();

  // Re-validate when the app comes back to the foreground. This is the actual
  // mechanism that keeps subscriptions alive on iOS, where the SW's own
  // pushsubscriptionchange event never fires.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void syncPushSubscription();
  });
}

/**
 * Ensure the server knows about this device's current subscription. Throttled,
 * because it runs on every foreground and the common case is "nothing changed".
 */
export async function syncPushSubscription(force = false): Promise<void> {
  if (!registration || Notification.permission !== "granted") return;

  if (!force) {
    const last = Number(localStorage.getItem(SYNC_MARK) || 0);
    if (Date.now() - last < SYNC_EVERY_MS) return;
  }

  try {
    let sub = await registration.pushManager.getSubscription();
    if (!sub) {
      // Permission is already granted, so re-subscribing needs no gesture.
      // This is the iOS-after-restart case: the old subscription is gone and
      // the new one usually has a different endpoint.
      const key = await fetchServerKey();
      if (!key) return;
      sub = await registration.pushManager.subscribe({
        userVisibleOnly: true, // required by WebKit; a silent push is not allowed
        applicationServerKey: urlB64ToUint8Array(key) as BufferSource,
      });
    }
    await postSubscription(sub);
    subscribed = true;
    try {
      localStorage.setItem(SYNC_MARK, String(Date.now()));
    } catch {
      /* private mode — just re-sync more often */
    }
  } catch (e) {
    console.warn("[push] subscription sync failed:", e);
  }
}

/**
 * Turn push on for THIS device. Must be called from a user gesture.
 * Returns a reason on failure so the settings UI can say something specific
 * instead of a checkbox that silently springs back.
 */
export async function enablePush(): Promise<{ ok: boolean; reason?: string }> {
  if (!("serviceWorker" in navigator)) {
    return { ok: false, reason: "This browser has no service worker support." };
  }
  if (!window.isSecureContext) {
    return {
      ok: false,
      reason: "Needs an https:// address (or localhost). Reach FleetView over Tailscale.",
    };
  }
  if (!("PushManager" in window)) {
    // Overwhelmingly the iOS-in-a-tab case, which is fixable by the user.
    return {
      ok: false,
      reason: isStandalone()
        ? "This browser doesn't support Web Push."
        : "On iPhone/iPad, add FleetView to your Home Screen first — Safari tabs can't receive push.",
    };
  }

  if (!registration) {
    try {
      registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    } catch {
      return { ok: false, reason: "Could not start the service worker." };
    }
  }

  const perm = await Notification.requestPermission();
  if (perm !== "granted") {
    return { ok: false, reason: "Notification permission was denied." };
  }

  const key = await fetchServerKey();
  if (!key) return { ok: false, reason: "Server has no push key configured." };

  try {
    const sub =
      (await registration.pushManager.getSubscription()) ||
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlB64ToUint8Array(key) as BufferSource,
      }));
    await postSubscription(sub);
    subscribed = true;
    return { ok: true };
  } catch (e: any) {
    return { ok: false, reason: e?.message || "Subscribe failed." };
  }
}

/** Turn push off for this device: drop the row server-side, then unsubscribe
 *  locally. Server first — if the local unsubscribe succeeded but the POST
 *  didn't, the server would keep pushing to a dead endpoint until it 410s. */
export async function disablePush(): Promise<void> {
  subscribed = false;
  try {
    const sub = await registration?.pushManager.getSubscription();
    if (sub) {
      await fetch("/api/push/unsubscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ endpoint: sub.endpoint }),
      }).catch(() => {});
      await sub.unsubscribe().catch(() => {});
    }
  } catch {
    /* nothing to clean up */
  }
  try {
    localStorage.removeItem(SYNC_MARK);
  } catch {
    /* ignore */
  }
}

async function fetchServerKey(): Promise<string | null> {
  try {
    const r = await fetch("/api/push/key");
    if (!r.ok) return null;
    const j = await r.json();
    return typeof j?.key === "string" && j.key ? j.key : null;
  } catch {
    return null;
  }
}

async function postSubscription(sub: PushSubscription): Promise<void> {
  await fetch("/api/push/subscribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...sub.toJSON(),
      // The server builds the notification's deep link from these: it has no
      // other way to know which origin this device reaches FleetView on (the
      // tailnet hostname differs from the loopback one it binds).
      origin: location.origin,
      session: sessionId,
      label: navigator.userAgent.slice(0, 120),
    }),
  });
}

/** base64url (what the server sends) -> Uint8Array (what subscribe() wants). */
function urlB64ToUint8Array(base64: string): Uint8Array {
  const padded = base64.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
