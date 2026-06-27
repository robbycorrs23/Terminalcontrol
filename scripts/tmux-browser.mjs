import { WebSocket } from "ws";
import { writeFileSync } from "node:fs";

const t = await fetch("http://localhost:9222/json").then((r) => r.json());
const page = t.filter((x) => x.type === "page" && x.url.includes("4280"))[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.on("open", r));
let id = 1;
const p = new Map();
ws.on("message", (raw) => {
  const m = JSON.parse(raw);
  if (m.id && p.has(m.id)) { p.get(m.id)(m.result); p.delete(m.id); }
});
const cmd = (m, params = {}) => new Promise((res) => { const i = id++; p.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params })); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (e) => { const r = await cmd("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }); return r.result ? r.result.value : null; };

await cmd("Page.enable"); await cmd("Runtime.enable"); await cmd("Page.bringToFront");
await cmd("Page.reload"); await sleep(1500);
const sess = await ev(`sessionStorage.getItem("fleet-session")`);
await fetch("http://localhost:4280/api/panes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: "/tmp", cmd: "", session: sess }) });
await sleep(1200);

await ev(`document.querySelector(".term").click()`);
await sleep(300);
for (const ch of "echo HELLO_FROM_TMUX") await cmd("Input.dispatchKeyEvent", { type: "char", text: ch });
await cmd("Input.dispatchKeyEvent", { type: "rawKeyDown", windowsVirtualKeyCode: 13, key: "Enter" });
await cmd("Input.dispatchKeyEvent", { type: "char", text: "\r" });
await cmd("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 13, key: "Enter" });
await sleep(1000);

const txt = await ev(`document.querySelector(".xterm-rows")?.innerText || ""`);
const echoedAndRan = txt.split("HELLO_FROM_TMUX").length > 2; // command line + output line
const statusBar = txt.includes("[fleet_"); // tmux status bar would show this
console.log("interactive (typed command ran):", echoedAndRan);
console.log("tmux status bar leaked into view:", statusBar);

const r = await cmd("Page.captureScreenshot", { format: "png" });
writeFileSync("/tmp/fleet-tmux.png", Buffer.from(r.data, "base64"));
console.log("shot /tmp/fleet-tmux.png");
process.exit(0);
