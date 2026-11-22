/**
 * Version / update check (moved out of main.ts).
 *
 * "I pulled and restarted, but nothing changed" used to be invisible. The server
 * now rebuilds a stale bundle and fixes dependencies at startup
 * (server/self-check.js); this side catches the last gap — a tab or home-screen
 * app still running the bundle it loaded before the update — and shows what the
 * machine is running in Settings.
 */
type VersionInfo = {
  server: { commit: string | null; branch: string | null; dirty: boolean; startedAt: number };
  bundle: { commit: string | null; builtAt: number } | null;
  deps: { name: string; want: string; have: string | null }[];
  autoUpdate?: { enabled: boolean; lastCheck: number; status: string; detail: string; pending: number; lastApplied?: number } | null;
};

/** "3 min ago" */
function ago(t: number) {
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

/** One line for Settings → This machine: what server/auto-update.js is doing. */
function autoUpdateText(a: NonNullable<VersionInfo["autoUpdate"]>): string {
  if (!a.enabled) return `Auto-update off — ${a.detail}`;
  const checked = a.lastCheck ? ` · checked ${ago(a.lastCheck)}` : "";
  switch (a.status) {
    case "up-to-date":
      return `Auto-update: up to date${checked}`;
    case "available":
      return `Auto-update: ${a.detail} — installs when every session is idle${checked}`;
    case "skipped":
      return `Auto-update paused: ${a.detail}${checked}`;
    case "error":
      return `Auto-update problem: ${a.detail}${checked}`;
    default:
      return `Auto-update: ${a.status}${checked}`;
  }
}
export async function checkVersion(openSettings: () => void) {
  let v: VersionInfo;
  try {
    const res = await fetch("/api/version", { cache: "no-store" });
    if (!res.ok) return; // an older server without the route
    v = await res.json();
  } catch {
    return;
  }
  const el = document.getElementById("updateNote") as HTMLButtonElement;
  const mine = typeof __BUILD_INFO__ !== "undefined" ? __BUILD_INFO__ : null;
  const stale = !!(v.bundle && mine && v.bundle.builtAt !== mine.builtAt);
  if (v.deps?.length) {
    el.textContent = "This machine needs npm install";
    el.title = v.deps.map((d) => `${d.name}: ${d.have || "missing"} → ${d.want}`).join("\n");
    el.onclick = () => openSettings();
    el.hidden = false;
  } else if (stale) {
    el.textContent = "FleetView was updated — tap to reload";
    el.title = `Running ${mine?.commit || "?"}, server has ${v.bundle?.commit || "?"}`;
    el.onclick = () => location.reload();
    el.hidden = false;
  } else el.hidden = true;

  const ver = document.getElementById("mcVersion");
  if (ver) {
    const s = v.server;
    const when = (t?: number) => (t ? new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "?");
    ver.textContent = `${s.commit || "unknown"}${s.branch && s.branch !== "HEAD" ? " · " + s.branch : ""}${s.dirty ? " · modified" : ""}`;
    ver.title =
      `Server running ${s.commit} since ${when(s.startedAt)}\n` +
      `App built from ${v.bundle?.commit || "?"} at ${when(v.bundle?.builtAt)}\n` +
      `This tab: ${mine?.commit || "?"} (built ${when(mine?.builtAt)})`;
    const row = ver.closest(".set-row");
    let note = document.getElementById("mcAutoUpdate");
    if (!note && row) {
      note = document.createElement("div");
      note.id = "mcAutoUpdate";
      note.className = "set-note";
      row.after(note);
    }
    if (note) {
      note.hidden = !v.autoUpdate;
      if (v.autoUpdate) note.textContent = autoUpdateText(v.autoUpdate) + (v.autoUpdate.lastApplied ? ` · last installed ${when(v.autoUpdate.lastApplied)}` : "");
    }
  }
}
