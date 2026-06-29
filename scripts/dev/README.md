# dev scripts (ad-hoc)

Throwaway scripts used while building FleetView — **not** part of the app or its
install. They drive a Chrome instance over the DevTools protocol (port 9222) or
exercise persistence by hand. Kept for reference; safe to ignore or delete.

- `drive.mjs`, `drive2.mjs`, `drive3.mjs`, `drive5.mjs` — CDP UI smoke-drivers
  (click around, screenshot to `/tmp/fleet-*.png`). Need Chrome started with
  `--remote-debugging-port=9222` and the app open.
- `tmux-browser.mjs` — CDP check that typed input runs and tmux stays transparent.
- `persist-test.mjs` — drives `/api/panes` to verify scrollback survives a restart.

The real, supported scripts live one level up in `scripts/`
(`preflight.js`, `install-service.js`, `uninstall-service.js`, `fix-pty-helper.js`).
