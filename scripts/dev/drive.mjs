import { WebSocket } from "ws";
import { writeFileSync } from "node:fs";

const DBG = "http://localhost:9222";
const APP_PORT = "4280";

// Find the page target pointing at our app.
const targets = await fetch(`${DBG}/json`).then((r) => r.json());
const page = targets.find((t) => t.type === "page" && t.url.includes(APP_PORT));
if (!page) {
  console.error("no app page target found:", targets.map((t) => t.url));
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.on("open", r));

let nextId = 1;
const pending = new Map();
const consoleErrors = [];
ws.on("message", (raw) => {
  const m = JSON.parse(raw);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m.result);
    pending.delete(m.id);
  } else if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
    consoleErrors.push(m.params.args.map((a) => a.value ?? a.description).join(" "));
  } else if (m.method === "Runtime.exceptionThrown") {
    consoleErrors.push(
      "EXCEPTION: " +
        (m.params.exceptionDetails.exception?.description ||
          m.params.exceptionDetails.text)
    );
  }
});
function cmd(method, params = {}) {
  const id = nextId++;
  return new Promise((res) => {
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function evaluate(expr) {
  const r = await cmd("Runtime.evaluate", {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails)
    return { error: r.exceptionDetails.exception?.description };
  return r.result.value;
}
async function shot(name) {
  const r = await cmd("Page.captureScreenshot", { format: "png" });
  const path = `/tmp/fleet-${name}.png`;
  writeFileSync(path, Buffer.from(r.data, "base64"));
  console.log("  screenshot:", path);
}

await cmd("Page.enable");
await cmd("Runtime.enable");

// The page was opened before terminals connected; reload to get a clean run.
await cmd("Page.reload");
await sleep(2500);

// 1) Grid state
const grid = await evaluate(`(() => {
  const cells = document.querySelectorAll('#grid .cell');
  const terms = document.querySelectorAll('#grid .term');
  const rendered = [...document.querySelectorAll('.xterm-rows')].filter(e => e.textContent.trim().length).length;
  const cols = getComputedStyle(document.getElementById('grid')).gridTemplateColumns.split(' ').length;
  return { cells: cells.length, terms: terms.length, columns: cols, termsWithText: rendered };
})()`);
console.log("GRID:", JSON.stringify(grid));
await shot("1-grid");

// 2) Click the first terminal -> should zoom (get .zoomed, scrim visible)
await evaluate(`document.querySelector('#grid .term .title')?.parentElement?.click()`);
await sleep(600);
const zoom = await evaluate(`(() => {
  const z = document.querySelector('.term.zoomed');
  const scrim = document.getElementById('scrim');
  const r = z?.getBoundingClientRect();
  return { hasZoomed: !!z, scrimVisible: scrim && !scrim.hidden,
           zoomW: r?Math.round(r.width):0, zoomH: r?Math.round(r.height):0, vw: innerWidth, vh: innerHeight };
})()`);
console.log("ZOOM:", JSON.stringify(zoom));
await shot("2-zoomed");

// 3) Click scrim -> should return home
await evaluate(`document.getElementById('scrim').click()`);
await sleep(600);
const unz = await evaluate(`({ hasZoomed: !!document.querySelector('.term.zoomed'), scrimHidden: document.getElementById('scrim').hidden })`);
console.log("UNZOOM:", JSON.stringify(unz));

// 4) Fire an attention hook on the LAST pane via the app API, expect glow + queue chip
const ids = await evaluate(`[...document.querySelectorAll('#grid .term')].length`);
const lastPaneId = await fetch(`http://localhost:${APP_PORT}/api/panes`).then(r=>r.json()).then(p=>p[p.length-1].id);
await fetch(`http://localhost:${APP_PORT}/hook`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pane: lastPaneId, kind: "question" }) });
await sleep(700);
const attn = await evaluate(`(() => {
  const waiting = document.querySelectorAll('.term.waiting').length;
  const chips = document.querySelectorAll('#queue .qchip').length;
  const nextShown = !document.getElementById('nextBtn').hidden;
  const badge = document.querySelector('.term.waiting .badge')?.textContent || null;
  return { waitingBoxes: waiting, queueChips: chips, nextButtonShown: nextShown, badge };
})()`);
console.log("ATTENTION:", JSON.stringify(attn));
await shot("3-attention");

// 5) Fire a 'done' hook on the first pane too, for the green state
const firstPaneId = await fetch(`http://localhost:${APP_PORT}/api/panes`).then(r=>r.json()).then(p=>p[0].id);
await fetch(`http://localhost:${APP_PORT}/hook`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pane: firstPaneId, kind: "done" }) });
await sleep(700);
await shot("4-attention-both");

console.log("CONSOLE ERRORS:", consoleErrors.length ? consoleErrors : "none");
ws.close();
process.exit(0);
