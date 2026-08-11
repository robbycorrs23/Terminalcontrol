# FleetView over Tailscale — how it's actually wired up

FleetView has **no login/auth of its own** — reaching its port at all is
equivalent to running arbitrary commands on that machine. So "remote access"
can't mean opening the port to the internet; it means putting something in
front of it that (a) only lets *your* devices in, and (b) doesn't require
FleetView to trust the network it's listening on. That's what this setup
does, using Tailscale as the access-control layer instead of adding auth to
the app itself.

**What this setup does and doesn't cover.** Tailscale's tailnet ACL gates
*remote* access — a device has to be signed into the tailnet to resolve or
reach the hostname at all. It does **not** gate *local* access: the server
still listens on `127.0.0.1:4280` with zero credential check, so any process
already running on this machine — not just a browser tab, anything: another
user's session, malware, a compromised npm postinstall script — can hit that
port directly and get a shell, bypassing Tailscale entirely. This setup
accepts that tradeoff (trusts everything already running on the machine, and
every device permanently on the tailnet). Closing that gap means putting a
credential in front of FleetView itself, not just the tailnet boundary — see
"Going further" below for the shape that takes and why it's more involved
than it sounds.

## The three pieces

**1. The FleetView server stays on loopback.** It does **not** bind to the
Tailscale interface, and `FLEET_HOST` is left unset (defaults to
`127.0.0.1`). This is the part that's easy to get wrong by trying to "open
it up" — you don't widen the bind for Tailscale access. The server never
listens anywhere reachable off the machine.

**2. `tailscale serve` reverse-proxies it.** Instead of FleetView listening
on the tailnet, Tailscale's own daemon does:

```
tailscale serve status
  https://did2200.tail5df669.ts.net (tailnet only)
  |-- / proxy http://127.0.0.1:4280
```

That command (run once; it persists) tells `tailscaled` to terminate HTTPS
at `did2200.tail5df669.ts.net:443` — a MagicDNS name that only resolves for
devices signed into the same tailnet — and forward everything to FleetView's
loopback port. Tailscale issues and rotates the TLS cert automatically.

**Confirm it's tailnet-only, not public:** `tailscale serve status --json`
should have **no `AllowFunnel`** key. If Funnel is ever turned on
(`tailscale funnel`, not `serve`), that same hostname becomes reachable from
the open internet — given FleetView has no auth, that would expose real
shell access publicly. Don't enable Funnel for this.

**3. FleetView is told to trust that hostname.** The server has its own
CSRF / DNS-rebinding guard (`server/index.js`, `sameOrigin()`) that — by
design, since there's no other auth — rejects any request whose `Host` or
`Origin` isn't loopback. A request arriving through the Tailscale proxy has
`Host: did2200.tail5df669.ts.net`, not `localhost`, so without telling the
server to trust that name, **the guard itself blocks the tailnet traffic**.
That's what this env var is for:

```
FLEET_ALLOWED_HOSTS=did2200.tail5df669.ts.net
```

It's comma-separated if you ever need more than one trusted hostname.

## Where that env var actually has to live

If you only ever run FleetView with `npm start` in a terminal, exporting
`FLEET_ALLOWED_HOSTS` in your shell before starting it is enough. But the
whole point of this setup is that FleetView survives reboots via the login
auto-start service (`npm run service:install`) — and a launchd/systemd
service does **not** inherit your shell's environment. It has to be baked
into the service definition itself:

```xml
<!-- ~/Library/LaunchAgents/com.fleetview.server.plist -->
<key>EnvironmentVariables</key>
<dict>
    <key>PATH</key><string>...</string>
    <key>FLEET_ALLOWED_HOSTS</key><string>did2200.tail5df669.ts.net</string>
</dict>
```

This is the single most likely reason someone's Tailscale setup "isn't
connecting": FleetView works fine from `localhost` on the machine itself,
`tailscale serve` looks correctly configured, but every request from another
device still 403s — because the *service* running FleetView never had
`FLEET_ALLOWED_HOSTS` set, only your interactive shell did.

`scripts/install-service.js` does pass `FLEET_ALLOWED_HOSTS` through if it's
set in your environment **at install time** — so the fix, if it's missing,
is: `export FLEET_ALLOWED_HOSTS=<your-tailnet-hostname>` then re-run
`npm run service:install` (uninstall first if one's already installed), not
hand-editing the plist. Re-run it any time the tailnet hostname changes too
(e.g., after renaming the machine in the Tailscale admin console).

## Getting your own hostname

`https://did2200.tail5df669.ts.net` is this machine's Tailscale name —
`<machine-name>.<tailnet-name>.ts.net`. Find yours with `tailscale status`
(your own device is the first line) or in the Tailscale admin console. Every
machine's is different; don't copy the one above.

## End-to-end checklist

1. `tailscale status` — is this machine actually signed into a tailnet, and
   is the *other* device (phone, laptop) you're connecting from also on it?
   Tailscale access is per-tailnet — a device outside it can't resolve the
   `.ts.net` hostname at all, let alone reach the port.
2. `tailscale serve status` — is something proxying to your intended target?
   **If you've put an additional auth layer in front of FleetView (a gated
   listener on a different port, not raw 4280), re-point serve at *that*
   port** — `tailscale serve --bg 4280` blindly re-points it at the ungated
   port instead, which will look like a fix (serve status goes from empty to
   proxying) while quietly removing that auth layer. This particular setup
   doesn't have one, so `4280` is genuinely correct here — but check before
   copying the command if yours does.
3. `tailscale serve status --json` — confirm there's no `AllowFunnel: true`
   anywhere, i.e. you're not accidentally public.
4. Is FleetView actually running? (`curl -s -o /dev/null -w '%{http_code}\n'
   http://127.0.0.1:4280` from the machine itself should print `200`.)
5. Is `FLEET_ALLOWED_HOSTS` set **for the process that's actually running
   FleetView** — not just your shell? If FleetView is running via the
   auto-start service, check the service's own plist/unit file, not your
   shell's `env`.
6. From the *other* device, open `https://<machine>.<tailnet>.ts.net` in a
   browser. A 403 with body `forbidden: cross-origin` means step 5 is the
   problem specifically (everything else is working — Tailscale routed the
   request, TLS terminated, FleetView received it, and rejected it on the
   Host check). Any other failure (timeout, connection refused) points back
   to steps 1-4 instead.

## Going further: the passkey gate (`server/gate.js`)

This setup as described above trusts the tailnet's ACL for remote access and
trusts everything already running on the machine for local access. Built as
a follow-up: `server/gate.js`, a passkey (WebAuthn) session gate that sits in
front of FleetView instead of `tailscale serve` pointing at FleetView
directly — closing the gap that a lost/stolen (but still tailnet-enrolled)
device leaves open. Reaching a shell then requires both tailnet membership
*and* a passkey-backed session.

**Why not just trust Tailscale's identity headers instead of building this?**
`tailscale serve` does attach `Tailscale-User-Login` (etc.) to proxied
requests, and does strip any client-supplied copy of that header — but only
for traffic that actually flows through `tailscaled`'s own proxy. A process
already running on the Mac can open a connection to the same backend port
directly, bypassing that proxy entirely, and set that header to anything it
wants — Tailscale's own docs confirm this ("only have the service listen on
localhost; otherwise, any user that can call your service directly could
trivially provide their own values for these headers"). A signed session
cookie, verified by an HMAC the gate alone holds, can't be forged that way.

### Running it

```
npm run gate                 # starts server/gate.js on 127.0.0.1:4290
```

Env vars (all optional, shown with defaults):

| Var | Default | Notes |
|---|---|---|
| `FLEET_GATE_PORT` | `4290` | what `tailscale serve` should point at instead of 4280 |
| `FLEET_GATE_TARGET` | `http://127.0.0.1:4280` | where FleetView's real app is |
| `FLEET_GATE_RP_ID` | `localhost` | **must be your real tailnet hostname for actual use** — a WebAuthn passkey is cryptographically bound to this domain and won't work through a mismatch. `localhost` only works for local testing. |
| `FLEET_GATE_ORIGIN` | `http://localhost:<port>` | likewise — set to `https://<hostname>` for real use |
| `FLEET_GATE_INSECURE_COOKIE` | unset | only set this for local `http://` testing; never set it for real tailnet use (the session cookie needs `Secure` there) |

First-time setup: with no passkeys registered yet, visiting `/gate/login`
lets you register one with no auth required (nothing's protected yet at that
point). Once one exists, registering *another* (e.g. adding your phone after
your laptop) requires already being signed in — the endpoint enforces this
server-side, not just in the UI.

Then re-point `tailscale serve` at the gate instead of FleetView directly:

```
tailscale serve --bg 4290
```

— and see the checklist item above about not blindly running that command
against `4280` once this exists; `4280` is now the *ungated* port.

### What this doesn't close yet

The gate's session check is real, but it still proxies to FleetView over
plain loopback TCP (`127.0.0.1:4280`) — a process already running on the Mac
can still reach FleetView *directly* on that port, skipping the gate
entirely, same as before. Closing that requires FleetView to stop accepting
connections that didn't come through the gate at all, which plain TCP on
loopback can't enforce (any local process can dial any loopback port,
regardless of what door you'd like them to have used). The planned next
step: run FleetView and the gate as a dedicated, unprivileged system account
and switch the connection between them to a Unix domain socket with
restrictive file permissions — a process running as your normal login user
genuinely cannot open a socket file it doesn't have permission to, which is
an OS-enforced boundary a TCP port number can't provide on its own.
