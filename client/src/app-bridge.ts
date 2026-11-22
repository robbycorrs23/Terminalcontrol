/**
 * The native iOS app (ios/) hosts these same pages in a WKWebView. This module
 * is the whole web-side contract with it, and does nothing in a browser:
 *
 *  - The app exposes `window.webkit.messageHandlers.fleetApp`. Its presence is
 *    the only "am I in the app?" test (the UA also says FleetViewApp, but a
 *    capability check can't be spoofed by a stray UA string).
 *  - Tapping the machine name in the top bar asks the app for its machine
 *    switcher ({t:"machines"}) — one app holds every machine you've added.
 *  - Quick switch: the app hands the page its machine list
 *    (`window.fleetSetMachines([...])`) and the page draws one button per
 *    machine — that machine's own Home Screen icon — beside the name; a tap is
 *    {t:"switch", id}. Only with 2+ machines, and then the machine NAME is
 *    hidden (body.app-quick) — the icons say which machine you're on — and a
 *    trailing "more" button opens the full switcher (where you add machines)
 *    instead. With one machine the name stays: it's the way in.
 *  - `window.fleetOpenPane(id)` lets a notification tap open a pane in a page
 *    that's already loaded (a fresh load uses the existing #pane= deep link).
 *  - Settings: the app delivers notifications natively (server/apns.js), so the
 *    browser-only rows — Web Push for this device, background-tab
 *    notifications — are hidden via body.in-app; the categories still apply.
 */
type Handler = { postMessage: (m: unknown) => void };
export type AppMachine = { id: string; name: string; icon: string | null; iconData?: string | null; current: boolean };
type AppWindow = Window & {
  webkit?: { messageHandlers?: { fleetApp?: Handler } };
  fleetOpenPane?: (id: string) => boolean;
  fleetSetMachines?: (list: AppMachine[]) => void;
};

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

  const quick = document.createElement("span");
  quick.className = "app-machines";
  quick.setAttribute("role", "group");
  quick.setAttribute("aria-label", "Machines");
  quick.hidden = true;
  deps.brand.after(quick);
  w.fleetSetMachines = (list) => {
    quick.textContent = "";
    quick.hidden = !Array.isArray(list) || list.length < 2;
    document.body.classList.toggle("app-quick", !quick.hidden);
    if (quick.hidden) return;
    for (const m of list) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "app-machine" + (m.current ? " on" : "");
      b.title = m.name;
      b.setAttribute("aria-label", m.current ? `${m.name} (current)` : `Switch to ${m.name}`);
      b.setAttribute("aria-pressed", String(!!m.current));
      // Prefer the app's natively fetched copy (iconData, a data: URL) so this
      // page never has to load another machine's image; else the https URL.
      const src = m.iconData && /^data:image\/png;base64,/.test(m.iconData) ? m.iconData : m.icon && /^https?:\/\//.test(m.icon) ? m.icon : "";
      if (src) {
        const img = document.createElement("img");
        img.src = src;
        img.alt = "";
        img.addEventListener("error", () => img.replaceWith(initial(m.name)));
        b.append(img);
      } else b.append(initial(m.name));
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!m.current) post({ t: "switch", id: m.id });
      });
      quick.append(b);
    }
    const more = document.createElement("button");
    more.type = "button";
    more.className = "app-machine app-machines-more";
    more.title = "Machines";
    more.setAttribute("aria-label", "All machines");
    // Three dots, as inline SVG like the rest of the chrome (no emoji/Unicode icons).
    more.innerHTML =
      '<svg class="ico-svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>';
    more.addEventListener("click", (e) => {
      e.stopPropagation();
      post({ t: "machines" });
    });
    quick.append(more);
  };
  post({ t: "ready" });
}

/** Fallback when a machine's icon can't load: its first TWO letters — "did2200"
 *  and "DocHolliday" would both have been just "D". */
function initial(name: string) {
  const s = document.createElement("span");
  s.className = "app-machine-initial";
  s.textContent = (name.trim().slice(0, 2) || "?").toUpperCase();
  return s;
}

