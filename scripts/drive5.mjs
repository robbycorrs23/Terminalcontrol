import { WebSocket } from "ws";

const DBG = "http://localhost:9222";
const APP = "http://localhost:4280";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Minimal per-page CDP wrapper.
class Page {
  constructor(wsUrl, label) { this.wsUrl = wsUrl; this.label = label; this.id = 1; this.pend = new Map(); this.errors = []; }
  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((r) => this.ws.on("open", r));
    this.ws.on("message", (raw) => {
      const m = JSON.parse(raw);
      if (m.id && this.pend.has(m.id)) { this.pend.get(m.id)(m.result); this.pend.delete(m.id); }
      else if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") this.errors.push(m.params.args.map((a) => a.value ?? a.description).join(" "));
      else if (m.method === "Runtime.exceptionThrown") this.errors.push("EXC: " + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    });
    await this.cmd("Page.enable"); await this.cmd("Runtime.enable");
  }
  cmd(method, params = {}) { return new Promise((res) => { const id = this.id++; this.pend.set(id, res); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async ev(expr) { const r = await this.cmd("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }); return r.exceptionDetails ? { __e: r.exceptionDetails.exception?.description } : r.result.value; }
  async reload() { await this.cmd("Page.reload"); await sleep(1800); }
  async front() { await this.cmd("Page.bringToFront"); }
  paths() { return this.ev(`[...document.querySelectorAll('#grid .term .path')].map(e=>e.textContent)`); }
  async drag(x1, y1, x2, y2) {
    await this.cmd("Input.dispatchMouseEvent", { type: "mouseMoved", x: x1, y: y1, buttons: 0 });
    await this.cmd("Input.dispatchMouseEvent", { type: "mousePressed", x: x1, y: y1, button: "left", clickCount: 1, buttons: 1 });
    for (let i = 1; i <= 12; i++) { await this.cmd("Input.dispatchMouseEvent", { type: "mouseMoved", x: Math.round(x1 + (x2 - x1) * i / 12), y: Math.round(y1 + (y2 - y1) * i / 12), buttons: 1 }); await sleep(18); }
    await this.cmd("Input.dispatchMouseEvent", { type: "mouseReleased", x: x2, y: y2, button: "left", clickCount: 1, buttons: 0 });
  }
}

// open a second tab
await fetch(`${DBG}/json/new?${encodeURIComponent(APP)}`, { method: "PUT" });
await sleep(800);
const targets = (await fetch(`${DBG}/json`).then((r) => r.json())).filter((t) => t.type === "page" && t.url.includes("4280"));
console.log("page targets:", targets.length);
const A = new Page(targets[0].webSocketDebuggerUrl, "A");
const B = new Page(targets[1].webSocketDebuggerUrl, "B");
await A.connect(); await B.connect();
await A.reload(); await B.reload();

const sa = await A.ev(`sessionStorage.getItem('fleet-session')`);
const sb = await B.ev(`sessionStorage.getItem('fleet-session')`);
console.log("sessions differ:", sa !== sb, "| A", sa?.slice(0, 8), "B", sb?.slice(0, 8));

// ---- 1) Isolation: create a term in A's session and B's session ----
await fetch(`${APP}/api/panes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: "/tmp", cmd: "clear; printf A1\\\\n", session: sa }) });
await fetch(`${APP}/api/panes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: "/usr", cmd: "clear; printf B1\\\\n", session: sb }) });
await sleep(1200);
console.log("ISOLATION  A sees:", JSON.stringify(await A.paths()), "| B sees:", JSON.stringify(await B.paths()));

// ---- 2) Make a 2nd term in A, save as layout, then drag-reorder -> autosave ----
await fetch(`${APP}/api/panes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: "/var", cmd: "clear; printf A2\\\\n", session: sa }) });
await sleep(1000);
await A.front();
await A.ev(`window.prompt = () => "sess-test"`);
await A.ev(`document.getElementById('saveBtn').click()`);
await sleep(500);
const ind = await A.ev(`({ shown: !document.getElementById('current').hidden, text: document.getElementById('current').textContent })`);
console.log("A current-layout indicator:", JSON.stringify(ind));
const beforeSlots = await fetch(`${APP}/api/layouts`).then((r) => r.json()).then((ls) => ls.find((l) => l.name === "sess-test")?.slots.map((s) => s.cwd));
console.log("layout slots before move:", JSON.stringify(beforeSlots));

// Drive the real drag handler with in-page synthetic pointer events (focus-proof).
await A.ev(`(() => {
  const cells=[...document.querySelectorAll('#grid .cell')];
  const from=cells[0], to=cells[cells.length-1];
  const tb=from.querySelector('.title');
  const a=tb.getBoundingClientRect(), b=to.getBoundingClientRect();
  const x1=a.left+a.width/2, y1=a.top+a.height/2, x2=b.left+b.width*0.7, y2=b.top+b.height/2;
  const opt=(x,y)=>({clientX:x,clientY:y,bubbles:true,cancelable:true,button:0,pointerId:1});
  tb.dispatchEvent(new PointerEvent('pointerdown',opt(x1,y1)));
  for(let i=1;i<=8;i++){ document.dispatchEvent(new PointerEvent('pointermove',opt(x1+(x2-x1)*i/8,y1+(y2-y1)*i/8))); }
  document.dispatchEvent(new PointerEvent('pointerup',opt(x2,y2)));
})()`);
await sleep(700);
console.log("A grid order after drag:", JSON.stringify(await A.paths()));
const afterSlots = await fetch(`${APP}/api/layouts`).then((r) => r.json()).then((ls) => ls.find((l) => l.name === "sess-test")?.slots.map((s) => s.cwd));
console.log("layout slots after move: ", JSON.stringify(afterSlots), "| autosaved:", JSON.stringify(beforeSlots) !== JSON.stringify(afterSlots));

// ---- 3) Open chooser in B: Add, then Replace ----
// NO reload — B's dropdown should update live via the 'layouts' broadcast.
const bHasOption = await B.ev(`[...document.getElementById('layoutSel').options].some(o=>o.value==='sess-test')`);
console.log("B dropdown picked up sess-test live (no reload):", bHasOption);
await B.front();
await B.ev(`(()=>{const s=document.getElementById('layoutSel');s.value='sess-test';})()`);
await B.ev(`document.getElementById('openBtn').click()`);
await sleep(300);
const modal = await B.ev(`({ shown: !document.getElementById('openmode').hidden, msg: document.getElementById('omMsg').textContent })`);
console.log("B open-chooser:", JSON.stringify(modal));
await B.ev(`document.getElementById('omAdd').click()`);
await sleep(1300);
console.log("B after ADD:", JSON.stringify(await B.paths()), "(expect B1 + sess-test terms)");

await B.ev(`(()=>{document.getElementById('layoutSel').value='sess-test';document.getElementById('openBtn').click();})()`);
await sleep(300);
await B.ev(`document.getElementById('omReplace').click()`);
await sleep(1300);
console.log("B after REPLACE:", JSON.stringify(await B.paths()), "(expect only sess-test terms)");
const bCurrent = await B.ev(`document.getElementById('current').textContent`);
console.log("B current-layout indicator after replace:", JSON.stringify(bCurrent));

// confirm A is untouched by B's actions
console.log("A still sees:", JSON.stringify(await A.paths()));

console.log("CONSOLE ERRORS A:", A.errors.length ? A.errors : "none", "| B:", B.errors.length ? B.errors : "none");
process.exit(0);
