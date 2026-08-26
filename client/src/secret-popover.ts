import type { PaneView, TermHost } from "./terminal";

/**
 * The 🔒 control's popover — shared by Term (terminal panes) and AgentChat
 * (chat panes), since server/secret-vault.js already presents an identical
 * REST shape for both (it dispatches internally on tmux-env injection vs.
 * temp-file-plus-chat-message — see that file). Paste a value, give it a
 * name, pick a TTL, and it's gone; see server/index.js's
 * /api/panes/:id/secret-status for what `mechanism`/`ready` mean.
 *
 * Appends the popover into `container` and wires it to open on `anchorBtn`.
 */
export function attachSecretPopover(anchorBtn: HTMLElement, container: HTMLElement, host: TermHost, view: PaneView) {
  const pop = el("div", "spop");
  pop.hidden = true;
  pop.addEventListener("click", (e) => e.stopPropagation());
  pop.addEventListener("pointerdown", (e) => e.stopPropagation());

  const warn = el("div", "spop-warn");
  warn.hidden = true;

  const value = el("input", "spop-value") as HTMLInputElement;
  value.type = "password";
  value.autocomplete = "off";
  value.placeholder = "secret value";

  const name = el("input", "spop-name") as HTMLInputElement;
  name.type = "text";
  name.maxLength = 64;
  name.placeholder = "FLEET_SECRET";

  const ttl = el("select", "spop-ttl") as HTMLSelectElement;
  for (const [label, ms] of [
    ["1 min", 60_000],
    ["5 min", 300_000],
    ["15 min", 900_000],
    ["60 min", 3_600_000],
  ] as [string, number][]) {
    const o = document.createElement("option");
    o.value = String(ms);
    o.textContent = label;
    if (ms === 300_000) o.selected = true;
    ttl.append(o);
  }

  const go = el("button", "spop-go") as HTMLButtonElement;
  go.textContent = "Inject";

  const status = el("div", "spop-status");
  const active = el("div", "spop-active");

  const refreshActive = async () => {
    const s = await host.secretStatus(view).catch(() => null);
    warn.hidden = !s || !!s.ready;
    if (s && !s.ready) warn.textContent = "⚠ no tmux on this server — it can't inject secrets into terminal panes at all.";
    else if (s && s.mechanism === "tmp-file") {
      warn.textContent = s.gateConfigured
        ? "ℹ delivered as a temp file + one chat message (the path, not the value, becomes part of this chat)."
        : "ℹ delivered as a temp file + one chat message (path only, not the value). ⚠ no passkey gate set up either.";
    } else if (s && !s.gateConfigured) {
      warn.textContent = "⚠ no passkey gate set up — this only stops it reaching Claude's memory, not local/tailnet access.";
    }
    active.replaceChildren();
    for (const a of s?.active || []) {
      const row = el("div", "spop-row");
      const secsLeft = Math.max(0, Math.round((a.expiresAt - Date.now()) / 1000));
      const label = el("span", "spop-label");
      label.textContent = `${a.name} — ${secsLeft}s left`;
      const revoke = el("button", "spop-revoke") as HTMLButtonElement;
      revoke.textContent = "✕";
      revoke.title = "Revoke now";
      revoke.addEventListener("click", () => {
        host.onRevokeSecret(view, a.name);
        row.remove();
      });
      row.append(label, revoke);
      active.append(row);
    }
  };

  go.addEventListener("click", async () => {
    const v = value.value;
    if (!v) {
      status.textContent = "enter a value first";
      return;
    }
    go.disabled = true;
    status.textContent = "confirming…";
    try {
      const r = await host.onInjectSecret(view, {
        name: name.value.trim(),
        value: v,
        ttlMs: Number(ttl.value),
      });
      value.value = "";
      status.textContent = `✓ "${r.name}" ready for ${Math.round((r.expiresAt - Date.now()) / 1000)}s${r.stepUpVerified ? " (step-up confirmed)" : ""}`;
      refreshActive();
    } catch (e) {
      status.textContent = `✗ ${(e as Error).message}`;
    } finally {
      go.disabled = false;
    }
  });

  pop.append(warn, value, name, ttl, go, status, active);
  container.append(pop);

  const onDoc = (ev: PointerEvent) => {
    const t = ev.target as HTMLElement;
    if (pop.contains(t) || t === anchorBtn) return;
    pop.hidden = true;
    document.removeEventListener("pointerdown", onDoc);
  };
  anchorBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    pop.hidden = !pop.hidden;
    if (!pop.hidden) {
      status.textContent = "";
      refreshActive();
      document.addEventListener("pointerdown", onDoc);
    } else {
      document.removeEventListener("pointerdown", onDoc);
    }
  });
}

function el(tag: string, cls: string): HTMLElement {
  const n = document.createElement(tag);
  n.className = cls;
  return n;
}
