import { defineConfig } from "vite";

// The client lives in /client and is built into /dist, which the Node server
// serves statically. base:"./" keeps asset paths relative so it works no matter
// what host/port the server runs on.
export default defineConfig({
  root: "client",
  base: "./",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
});
