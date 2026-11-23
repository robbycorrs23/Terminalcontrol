/**
 * Live preview (server/previews.js): the app a session is building — its dev
 * server — opened on your phone over your tailnet.
 *
 * Lists dev servers running inside a session's folder (or every session's, from
 * Settings → Workspace → Live previews). "Open on phone" shares one with
 * `tailscale serve` and opens it: in the iOS app as an in-app browser sheet,
 * elsewhere in a new tab. Sharing is tailnet-only and does NOT go through the
 * passkey gate — said on the sheet. Reuses the inbox's drawer/card styles; all
 * text via textContent.
 */
import { el } from "./chat-steps";
import { openUrl, appBrowser } from "./app-bridge";

type Server = {
  port: number;
  command: string;
  cwd: string;
  shared: string | null;
  pane: { id: string; name: string } | null;
};

let panel: HTMLElement | null = null;
let body: HTMLElement;
let titleEl: HTMLElement;
let scope: { pane: string | null; name: string } = { pane: null, name: "" };

/** Open the sheet for one session (paneId) or for all of them (no argument). */
export function openPreviews(paneId?: string, name = "") {
  if (!panel) build();
  scope = { pane: paneId || null, name };
  panel!.hidden = false;
  void render();
}

function close() {
  if (panel) panel.hidden = true;
}

function build() {
  panel = el("div", "inbox previews");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Live preview");
  panel.hidden = true;
  const head = el("div", "inbox-head");
  titleEl = el("span", "inbox-title");
  const done = el("button", "inbox-done") as HTMLButtonElement;
  done.textContent = "Done";
  done.addEventListener("click", close);
  head.append(titleEl, done);
  body = el("div", "inbox-list");
  panel.append(head, body);
  panel.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  });
  document.body.append(panel);
}

function btn(label: string, cls: string, on: (b: HTMLButtonElement) => void) {
  const b = el("button", `ib ${cls}`) as HTMLButtonElement;
  b.textContent = label;
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    on(b);
  });
  return b;
}

async function api(method: string, path: string) {
  const res = await fetch(path, { method });
  if (res.status === 404 && path.startsWith("/api/previews?")) throw new Error("Live preview needs a server restart to work.");
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((j as { error?: string }).error || `Request failed (${res.status})`);
  return j;
}

async function render() {
  titleEl.textContent = "Live preview";
  body.textContent = "";
  const loading = el("div", "inbox-empty");
  loading.textContent = "Looking for dev servers…";
  body.append(loading);
  let servers: Server[] = [];
  try {
    const q = scope.pane ? `?pane=${encodeURIComponent(scope.pane)}` : "";
    const r = (await api("GET", `/api/previews${q || "?"}`)) as { servers: Server[]; remote?: boolean };
    if (r.remote) throw new Error("This session runs on another machine — open FleetView on that machine to preview it.");
    servers = r.servers;
  } catch (e) {
    loading.textContent = (e as Error).message;
    return;
  }
  body.textContent = "";
  const intro = el("div", "sched-intro");
  intro.textContent =
    "See the app a session is building on your phone. Opening one shares it on your tailnet (only your own devices can reach it) — it doesn't go through FleetView's sign-in, so stop sharing when you're done.";
  body.append(intro);
  if (!servers.length) {
    const n = el("div", "inbox-empty");
    n.textContent = scope.pane
      ? `Nothing is running in ${scope.name || "this session"}'s folder. Ask it to start the dev server (e.g. "run npm run dev"), then check again.`
      : "No dev servers are running in your sessions' folders.";
    body.append(n, btn("Check again", "", () => void render()));
    return;
  }
  const sec = el("div", "inbox-sec");
  const h = el("div", "inbox-sec-h");
  h.textContent = `Running · ${servers.length}`;
  sec.append(h);
  for (const s of servers) sec.append(card(s));
  body.append(sec, btn("Check again", "", () => void render()));
}

function card(s: Server) {
  const c = el("div", "inbox-card preview-card");
  const head = el("div", "ic-head");
  const who = el("span", "ic-who");
  const name = el("span", "ic-name");
  name.textContent = `Port ${s.port}`;
  const where = el("span", "ic-where");
  const folder = s.cwd.split("/").filter(Boolean).slice(-2).join("/");
  where.textContent = [s.command, !scope.pane && s.pane ? s.pane.name : folder].filter(Boolean).join(" · ");
  where.title = s.cwd;
  who.append(name, where);
  head.append(who);
  c.append(head);
  if (s.shared) {
    const u = el("div", "ic-snippet preview-url");
    u.textContent = s.shared;
    c.append(u);
  }
  const acts = el("div", "ic-actions");
  acts.append(
    btn(s.shared ? "Open" : "Open on phone", "primary", async (b) => {
      if (s.shared) return openUrl(s.shared);
      b.disabled = true;
      b.textContent = "Sharing…";
      // Safari blocks a tab opened after an await — so open it NOW, inside the
      // tap, and point it at the page once it's shared. (The app's in-app
      // browser sheet has no such rule.)
      const tab = appBrowser() ? null : window.open("about:blank", "_blank");
      try {
        const r = (await api("POST", `/api/previews/${s.port}/share`)) as { url: string };
        if (tab) {
          tab.opener = null;
          tab.location.href = r.url;
        } else openUrl(r.url);
        void render();
      } catch (e) {
        tab?.close();
        b.disabled = false;
        b.textContent = "Open on phone";
        alert((e as Error).message);
      }
    })
  );
  if (s.shared) {
    acts.append(
      btn("Copy link", "", (b) => {
        void navigator.clipboard?.writeText(s.shared!).then(() => {
          b.textContent = "Copied";
          setTimeout(() => (b.textContent = "Copy link"), 1500);
        });
      }),
      btn("Stop sharing", "", async () => {
        await api("DELETE", `/api/previews/${s.port}`).catch(() => {});
        void render();
      })
    );
  }
  c.append(acts);
  return c;
}
