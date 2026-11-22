/**
 * The native iOS app (ios/) hosts these same pages in a WKWebView. This module
 * is the whole web-side contract with it, and does nothing in a browser:
 *
 *  - The app exposes `window.webkit.messageHandlers.fleetApp`. Its presence is
 *    the only "am I in the app?" test (the UA also says FleetViewApp, but a
 *    capability check can't be spoofed by a stray UA string).
 *  - Tapping the machine name in the top bar asks the app for its machine
 *    switcher ({t:"machines"}) — one app holds every machine you've added.
 *  - `window.fleetOpenPane(id)` lets a notification tap open a pane in a page
 *    that's already loaded (a fresh load uses the existing #pane= deep link).
 *  - Settings: the app delivers notifications natively (server/apns.js), so the
 *    browser-only rows — Web Push for this device, background-tab
 *    notifications — are hidden via body.in-app; the categories still apply.
 */
type Handler = { postMessage: (m: unknown) => void };
type AppWindow = Window & { webkit?: { messageHandlers?: { fleetApp?: Handler } }; fleetOpenPane?: (id: string) => boolean };

const w = window as AppWindow;

export function inApp(): boolean {
  return !!w.webkit?.messageHandlers?.fleetApp;
}

export function initAppBridge(deps: { brand: HTMLElement; openPane: (id: string) => boolean }) {
  if (!inApp()) return;
  const post = (m: unknown) => w.webkit!.messageHandlers!.fleetApp!.postMessage(m);
  document.body.classList.add("in-app");
  deps.brand.classList.add("app-switch");
  deps.brand.setAttribute("role", "button");
  deps.brand.setAttribute("aria-label", "Switch machine");
  deps.brand.addEventListener("click", (e) => {
    e.preventDefault();
    post({ t: "machines" });
  });
  w.fleetOpenPane = (id: string) => deps.openPane(id);
  post({ t: "ready" });
}
