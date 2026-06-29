import { WebSocket } from "ws";
import { writeFileSync } from "node:fs";

const DBG = "http://localhost:9222";
const APP = "http://localhost:4280";

const targets = await fetch(`${DBG}/json`).then((r) => r.json());
const page = targets.find((t) => t.type === "page" && t.url.includes("4280"));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.on("open", r));

let nextId = 1;
const pending = new Map();
const errors = [];
ws.on("message", (raw) => {
  const m = JSON.parse(raw);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
  else if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error")
    errors.push(m.params.args.map((a) => a.value ?? a.description).join(" "));
  else if (m.method === "Runtime.exceptionThrown")
    errors.push("EXC: " + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
});
const cmd = (method, params = {}) => new Promise((res) => { const id = nextId++; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function ev(expr) {
  const r = await cmd("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return { __error: r.exceptionDetails.exception?.description };
  return r.result.value;
}
async function shot(name) {
  const r = await cmd("Page.captureScreenshot", { format: "png" });
  writeFileSync(`/tmp/fleet-${name}.png`, Buffer.from(r.data, "base64"));
  console.log("  screenshot /tmp/fleet-" + name + ".png");
}
async function click(x, y) {
  await cmd("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1, buttons: 1 });
  await cmd("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1, buttons: 0 });
}
async function drag(x1, y1, x2, y2) {
  await cmd("Input.dispatchMouseEvent", { type: "mouseMoved", x: x1, y: y1, buttons: 0 });
  await cmd("Input.dispatchMouseEvent", { type: "mousePressed", x: x1, y: y1, button: "left", clickCount: 1, buttons: 1 });
  const steps = 12;
  for (let i = 1; i <= steps; i++) {
    await cmd("Input.dispatchMouseEvent", { type: "mouseMoved", x: x1 + ((x2 - x1) * i) / steps, y: y1 + ((y2 - y1) * i) / steps, button: "left", buttons: 1 });
    await sleep(20);
  }
  await cmd("Input.dispatchMouseEvent", { type: "mouseReleased", x: x2, y: y2, button: "left", clickCount: 1, buttons: 0 });
}

await cmd("Page.enable");
await cmd("Runtime.enable");
await cmd("Page.reload");
await sleep(2000);

// ---- 1) Folder picker: open it, drill in, then Open here ----
await ev(`document.getElementById('addBtn').click()`);
await sleep(500);
const pick0 = await ev(`(() => {
  const p = document.getElementById('picker');
  return { open: !p.hidden, crumbs: document.getElementById('crumbs').textContent,
           rows: document.querySelectorAll('#plist .prow').length,
           firstFolder: document.querySelector('#plist .prow .nm')?.textContent || null };
})()`);
console.log("PICKER opened:", JSON.stringify(pick0));
await shot("p1-picker");

// drill into the first folder, check crumbs grew
await ev(`document.querySelector('#plist .prow:not(.up) .nm')?.parentElement.click()`);
await sleep(400);
const pick1 = await ev(`({ crumbs: document.getElementById('crumbs').textContent, rows: document.querySelectorAll('#plist .prow').length })`);
console.log("PICKER after drill:", JSON.stringify(pick1));

// uncheck "run claude" so the box opens a plain shell (deterministic), then Open here
await ev(`document.getElementById('runClaude').checked = false`);
await ev(`document.getElementById('popen').click()`);
await sleep(1200);
const afterOpen = await ev(`({ pickerHidden: document.getElementById('picker').hidden, terms: document.querySelectorAll('#grid .term').length })`);
console.log("AFTER open-here:", JSON.stringify(afterOpen));

// ---- seed two more terminals via API for minimize/drag/close tests ----
await fetch(`${APP}/api/panes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: "/tmp", cmd: "clear; printf 'BOX-B\\n'" }) });
await fetch(`${APP}/api/panes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: "/usr", cmd: "clear; printf 'BOX-C\\n'" }) });
await sleep(1200);
const order0 = await ev(`[...document.querySelectorAll('#grid .cell .path')].map(e=>e.textContent)`);
console.log("GRID order (3 terms):", JSON.stringify(order0));
await shot("p2-three");

// ---- 2) Minimize the FIRST terminal -> tray ----
await ev(`document.querySelector('#grid .term .min')?.click()`);
await sleep(500);
const minState = await ev(`({ inGrid: document.querySelectorAll('#grid .term').length, trayHidden: document.getElementById('tray').hidden, trayChips: document.querySelectorAll('#tray .tchip').length, trayName: document.querySelector('#tray .tname')?.textContent || null })`);
console.log("MINIMIZE:", JSON.stringify(minState));
await shot("p3-minimized");

// ---- restore from tray ----
await ev(`document.querySelector('#tray .tchip')?.click()`);
await sleep(400);
const restored = await ev(`({ inGrid: document.querySelectorAll('#grid .term').length, trayHidden: document.getElementById('tray').hidden })`);
console.log("RESTORE:", JSON.stringify(restored));

// ---- 3) Drag-to-reorder: drag term[0] onto term[2]'s cell ----
const rects = await ev(`(() => {
  const cells=[...document.querySelectorAll('#grid .cell')];
  const t0=cells[0].querySelector('.title').getBoundingClientRect();
  const c2=cells[cells.length-1].getBoundingClientRect();
  return { t0x:t0.left+t0.width/2, t0y:t0.top+t0.height/2, c2x:c2.left+c2.width/2, c2y:c2.top+c2.height/2 };
})()`);
const before = await ev(`[...document.querySelectorAll('#grid .cell .path')].map(e=>e.textContent)`);
await drag(rects.t0x, rects.t0y, rects.c2x, rects.c2y);
await sleep(500);
const after = await ev(`[...document.querySelectorAll('#grid .cell .path')].map(e=>e.textContent)`);
console.log("DRAG before:", JSON.stringify(before), "after:", JSON.stringify(after), "changed:", JSON.stringify(before) !== JSON.stringify(after));
await shot("p4-after-drag");

// ---- 4) Close a terminal via × ----
const closedCount = await ev(`(() => {
  const before = document.querySelectorAll('#grid .term').length;
  document.querySelector('#grid .term .close')?.click();
  return before;
})()`);
await sleep(600);
const afterClose = await ev(`document.querySelectorAll('#grid .term').length`);
console.log("CLOSE: before", closedCount, "after", afterClose, "removed:", closedCount - afterClose === 1);

console.log("CONSOLE ERRORS:", errors.length ? errors : "none");
ws.close();
process.exit(0);
