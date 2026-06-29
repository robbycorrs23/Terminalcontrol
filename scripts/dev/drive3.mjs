import { WebSocket } from "ws";
import { writeFileSync } from "node:fs";

const targets = await fetch("http://localhost:9222/json").then((r) => r.json());
const page = targets.find((t) => t.type === "page" && t.url.includes("4280"));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.on("open", r));
let nid = 1;
const pend = new Map();
const errors = [];
ws.on("message", (raw) => {
  const m = JSON.parse(raw);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); }
  else if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error")
    errors.push(m.params.args.map((a) => a.value ?? a.description).join(" "));
  else if (m.method === "Runtime.exceptionThrown")
    errors.push("EXC: " + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
});
const cmd = (method, params = {}) => new Promise((res) => { const id = nid++; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
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

await cmd("Page.enable");
await cmd("Runtime.enable");
await cmd("Page.reload");
await sleep(2000);
await ev(`window.prompt = () => "fleet-ui-test"`); // headless has no dialog

// open picker
await ev(`document.getElementById('addBtn').click()`);
await sleep(500);
const tool = await ev(`(() => ({
  search: !!document.getElementById('psearch'),
  sort: !!document.getElementById('psort'),
  mkdir: !!document.getElementById('pmkdir'),
  star: document.getElementById('pstar').textContent.trim(),
  rows: document.querySelectorAll('#plist .prow:not(.up)').length
}))()`);
console.log("TOOLBAR:", JSON.stringify(tool));

// search filter
await ev(`(() => { const s=document.getElementById('psearch'); s.value='app'; s.dispatchEvent(new Event('input')); })()`);
await sleep(200);
const searched = await ev(`(() => {
  const names=[...document.querySelectorAll('#plist .prow .nm')].map(e=>e.textContent.toLowerCase());
  return { count: names.length, allMatch: names.every(n=>n.includes('app')), names };
})()`);
console.log("SEARCH 'app':", JSON.stringify(searched));
await ev(`(() => { const s=document.getElementById('psearch'); s.value=''; s.dispatchEvent(new Event('input')); })()`);
await sleep(150);

// sort by last edited -> meta dates appear, order by mtime desc
await ev(`(() => { const s=document.getElementById('psort'); s.value='edited'; s.dispatchEvent(new Event('change')); })()`);
await sleep(300);
const sorted = await ev(`(() => {
  const rows=[...document.querySelectorAll('#plist .prow:not(.up)')];
  return { hasMeta: rows.length>0 && !!rows[0].querySelector('.meta'),
           firstThree: rows.slice(0,3).map(r=>r.querySelector('.nm')?.textContent+' ('+r.querySelector('.meta')?.textContent+')') };
})()`);
console.log("SORT edited:", JSON.stringify(sorted));
const prefsAfterSort = await fetch("http://localhost:4280/api/prefs").then((r) => r.json());
console.log("prefs.sort persisted:", prefsAfterSort.sort);
await shot("q1-picker-sorted");

// create folder (prompt overridden)
await ev(`document.getElementById('pmkdir').click()`);
await sleep(600);
const made = await ev(`[...document.querySelectorAll('#plist .prow .nm')].some(e=>e.textContent==='fleet-ui-test')`);
console.log("MKDIR shows new folder in list:", made);

// star: set current as default, verify persisted
const starPath = await ev(`(async()=>{ document.getElementById('pstar').click(); await new Promise(r=>setTimeout(r,200)); return document.getElementById('pstar').textContent.trim(); })()`);
const prefsAfterStar = await fetch("http://localhost:4280/api/prefs").then((r) => r.json());
console.log("STAR label now:", JSON.stringify(starPath), "| prefs.defaultDir set:", !!prefsAfterStar.defaultDir, "->", prefsAfterStar.defaultDir);

// reload and reopen -> picker should open AT the starred default
await cmd("Page.reload");
await sleep(2000);
await ev(`document.getElementById('addBtn').click()`);
await sleep(500);
const openedAt = await ev(`document.getElementById('crumbs').textContent`);
console.log("DEFAULT on reopen, crumbs:", JSON.stringify(openedAt));

// cleanup: unset default + sort, remove test folder
await fetch("http://localhost:4280/api/prefs", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ defaultDir: null, sort: "name" }) });
console.log("CONSOLE ERRORS:", errors.length ? errors : "none");
ws.close();
process.exit(0);
