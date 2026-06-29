import { WebSocket } from "ws";
import { writeFileSync, readFileSync } from "node:fs";

const APP = "http://localhost:4280";
const phase = process.argv[2];
const SESSION = process.argv[3];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Attach to a pane's terminal socket and collect ~1.2s of output (the repaint).
function bufferOf(id) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:4280/term?pane=${id}`);
    let buf = "";
    ws.on("message", (d) => {
      const m = JSON.parse(d);
      if (m.t === "d") buf += m.d;
    });
    setTimeout(() => {
      try { ws.close(); } catch {}
      resolve(buf);
    }, 1300);
  });
}

if (phase === "1") {
  const p1 = await fetch(`${APP}/api/panes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: "/tmp", cmd: "printf 'FLEET_PERSIST_MARKER_42\\n'", session: SESSION }) }).then((r) => r.json());
  await fetch(`${APP}/api/panes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: "/usr", cmd: "", session: SESSION }) }).then((r) => r.json());
  await sleep(1500);
  const list = await fetch(`${APP}/api/panes?session=${SESSION}`).then((r) => r.json());
  const buf = await bufferOf(p1.id);
  writeFileSync("/tmp/persist-ids.json", JSON.stringify(list.map((x) => x.id)));
  console.log(JSON.stringify({ phase: 1, count: list.length, order: list.map((x) => x.cwd.split("/").pop()), markerVisible: buf.includes("FLEET_PERSIST_MARKER_42") }));
} else {
  const prevIds = JSON.parse(readFileSync("/tmp/persist-ids.json", "utf8"));
  const list = await fetch(`${APP}/api/panes?session=${SESSION}`).then((r) => r.json());
  const buf = await bufferOf(prevIds[0]);
  console.log(JSON.stringify({
    phase: 2,
    count: list.length,
    order: list.map((x) => x.cwd.split("/").pop()),
    sameIds: JSON.stringify(list.map((x) => x.id).sort()) === JSON.stringify(prevIds.slice().sort()),
    markerStillVisible: buf.includes("FLEET_PERSIST_MARKER_42"),
  }));
}
process.exit(0);
