import { defineConfig, type Plugin } from "vite";
import { execSync } from "node:child_process";

// Build stamp: baked into the client (__BUILD_INFO__) AND written next to it as
// dist/build-info.json. The server reports the file; the client compares it with
// its own copy, so a tab running an older bundle than the server now serves can
// offer "Reload to update" (see main.ts checkVersion), and Settings can show
// exactly what this machine is running.
function gitShort(): string | null {
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return null;
  }
}
const BUILD_INFO = { commit: gitShort(), builtAt: Date.now() };
const buildInfo = (): Plugin => ({
  name: "fleetview-build-info",
  generateBundle() {
    this.emitFile({ type: "asset", fileName: "build-info.json", source: JSON.stringify(BUILD_INFO) });
  },
});

// The client lives in /client and is built into /dist, which the Node server
// serves statically.
//
// base:"/" — root-absolute asset URLs. This used to be "./" for
// host/port independence, but relative paths were never what bought that:
// "/assets/x.js" is just as host- and port-agnostic. What "./" actually buys is
// SUBPATH independence, which nothing here uses (the server always mounts the
// app at /, and so does the gate proxy).
//
// Meanwhile "./" was actively harmful in one specific way: server/index.js ends
// with an SPA catch-all that answers ANY unmatched path with index.html, so at a
// deep URL a relative "./manifest.webmanifest" resolves to the wrong directory,
// gets index.html back with a 200, and fails as "manifest is invalid" rather
// than an honest 404. Vite also rewrites public-dir references, so an absolute
// href hand-written in index.html gets rebased to relative anyway — this is the
// only place the choice can actually be made.
export default defineConfig({
  root: "client",
  base: "/",
  define: { __BUILD_INFO__: JSON.stringify(BUILD_INFO) },
  plugins: [buildInfo()],
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
});
