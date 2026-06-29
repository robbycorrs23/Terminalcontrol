// Collapsible task-list sidebar: one global, unlimited-depth task tree, persisted
// server-side (tasks.json) and synced across windows via the control socket.
// Owns its own DOM, model, drag-to-reorder, and debounced save.

interface TaskNode {
  id: string;
  text: string;
  done: boolean;
  collapsed: boolean;
  children: TaskNode[];
}

let model: TaskNode[] = [];
let editing = false; // an inline edit is in progress — don't clobber it with remote updates
let justDragged = false; // suppress the click-to-edit that follows a drag

let aside: HTMLElement;
let listEl: HTMLElement;

const OPEN_KEY = "fleet-tasks-open";

export function initTasks() {
  aside = document.getElementById("tasks")!;
  listEl = document.getElementById("taskList")!;
  const btn = document.getElementById("tasksBtn")!;
  const closeBtn = document.getElementById("tasksClose")!;
  const input = document.getElementById("taskInput") as HTMLInputElement;

  btn.addEventListener("click", () => setOpen(!aside.classList.contains("open")));
  closeBtn.addEventListener("click", () => setOpen(false));

  // Click anywhere outside the sidebar (but not on its toggle button) closes it.
  document.addEventListener("pointerdown", (e) => {
    if (!aside.classList.contains("open")) return;
    const t = e.target as HTMLElement;
    if (t.closest("#tasks") || t.closest("#tasksBtn")) return;
    setOpen(false);
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && input.value.trim()) {
      model.push(newNode(input.value));
      input.value = "";
      render();
      save();
    }
  });

  wireDrag();
  setOpen(localStorage.getItem(OPEN_KEY) === "1"); // closed by default; remembers your choice
  render();
}

/** Apply a tree pushed from the server (initial load or another window's edit). */
export function applyRemoteTasks(tree: TaskNode[]) {
  if (editing) return; // don't yank the rug while the user is typing
  if (JSON.stringify(tree) === JSON.stringify(model)) return; // our own echo — no-op
  model = tree || [];
  render();
}

/** Close the sidebar if open; returns whether it did (for the Esc-key chain). */
export function closeTasksIfOpen(): boolean {
  if (aside && aside.classList.contains("open")) {
    setOpen(false);
    return true;
  }
  return false;
}

function setOpen(open: boolean) {
  aside.classList.toggle("open", open);
  localStorage.setItem(OPEN_KEY, open ? "1" : "0");
}

// ---- model helpers ----------------------------------------------------
function newNode(text: string): TaskNode {
  const id = (crypto.randomUUID?.() || String(Math.random()).slice(2)) as string;
  return { id, text: text.trim(), done: false, collapsed: false, children: [] };
}
function findNode(list: TaskNode[], id: string): TaskNode | null {
  for (const n of list) {
    if (n.id === id) return n;
    const f = findNode(n.children, id);
    if (f) return f;
  }
  return null;
}
function removeById(list: TaskNode[], id: string): TaskNode | null {
  for (let i = 0; i < list.length; i++) {
    if (list[i].id === id) return list.splice(i, 1)[0];
    const r = removeById(list[i].children, id);
    if (r) return r;
  }
  return null;
}
function locate(list: TaskNode[], id: string): { list: TaskNode[]; index: number } | null {
  for (let i = 0; i < list.length; i++) {
    if (list[i].id === id) return { list, index: i };
    const l = locate(list[i].children, id);
    if (l) return l;
  }
  return null;
}
function contains(node: TaskNode, id: string): boolean {
  return node.id === id || node.children.some((c) => contains(c, id));
}

// ---- persistence ------------------------------------------------------
let saveTimer: number | undefined;
function save() {
  if (saveTimer != null) clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTimer = undefined;
    fetch("/api/tasks", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tasks: model }),
    }).catch(() => {});
  }, 400);
}

// ---- render -----------------------------------------------------------
function render() {
  listEl.innerHTML = "";
  if (model.length === 0) {
    const empty = el("div", "tasks-empty");
    empty.textContent = "No tasks yet — add one above.";
    listEl.append(empty);
    return;
  }
  for (const node of model) renderNode(node, 0);
}

function renderNode(node: TaskNode, depth: number) {
  const row = el("div", "task" + (node.done ? " done" : ""));
  row.dataset.id = node.id;
  row.style.paddingLeft = 6 + depth * 16 + "px";

  const hasKids = node.children.length > 0;
  const caret = el("span", "tcaret" + (hasKids ? "" : " leaf"));
  caret.textContent = hasKids ? (node.collapsed ? "▸" : "▾") : "•";
  if (hasKids) {
    caret.addEventListener("click", (e) => {
      e.stopPropagation();
      node.collapsed = !node.collapsed;
      render();
      save();
    });
  }

  const check = el("input", "tcheck") as HTMLInputElement;
  check.type = "checkbox";
  check.checked = node.done;
  check.addEventListener("change", () => {
    node.done = check.checked;
    render();
    save();
  });

  const text = el("span", "ttext");
  text.textContent = node.text || "(untitled)";
  text.addEventListener("click", () => {
    if (justDragged) return;
    startEdit(node, text);
  });

  const add = el("button", "tbtn tadd") as HTMLButtonElement;
  add.textContent = "＋";
  add.title = "Add subtask";
  add.addEventListener("click", (e) => {
    e.stopPropagation();
    const child = newNode("");
    node.children.push(child);
    node.collapsed = false;
    render();
    const newRow = listEl.querySelector(`.task[data-id="${child.id}"] .ttext`) as HTMLElement;
    if (newRow) startEdit(child, newRow);
  });

  const del = el("button", "tbtn tdel") as HTMLButtonElement;
  del.textContent = "✕";
  del.title = "Delete";
  del.addEventListener("click", (e) => {
    e.stopPropagation();
    if (node.children.length && !confirm("Delete this task and its subtasks?")) return;
    removeById(model, node.id);
    render();
    save();
  });

  row.append(caret, check, text, add, del);
  listEl.append(row);

  if (hasKids && !node.collapsed) {
    for (const c of node.children) renderNode(c, depth + 1);
  }
}

function startEdit(node: TaskNode, span: HTMLElement) {
  editing = true;
  const input = el("input", "tedit") as HTMLInputElement;
  input.value = node.text;
  span.replaceWith(input);
  input.focus();
  input.select();
  const commit = () => {
    if (!editing) return;
    editing = false;
    node.text = input.value.trim();
    if (!node.text) removeById(model, node.id); // empty = drop it (e.g. a blank new subtask)
    render();
    save();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      editing = false;
      render(); // discard edit
    }
  });
  input.addEventListener("blur", commit);
}

// ---- drag to reorder / re-nest ---------------------------------------
function wireDrag() {
  let dragId: string | null = null;
  let startY = 0;
  let dragging = false;
  let target: HTMLElement | null = null;
  let mode: "before" | "after" | "child" = "before";

  const clearIndicator = () => {
    if (target) target.classList.remove("drop-before", "drop-after", "drop-child");
    target = null;
  };

  const onMove = (ev: PointerEvent) => {
    if (dragId == null) return;
    if (!dragging) {
      if (Math.abs(ev.clientY - startY) < 5) return;
      dragging = true;
      const src = listEl.querySelector(`.task[data-id="${dragId}"]`);
      src?.classList.add("dragging");
    }
    const under = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
    const row = under?.closest(".task") as HTMLElement | null;
    clearIndicator();
    if (!row || row.dataset.id === dragId) return;
    const tid = row.dataset.id!;
    const node = findNode(model, dragId);
    if (node && contains(node, tid)) return; // can't drop into its own subtree
    const r = row.getBoundingClientRect();
    const frac = (ev.clientY - r.top) / r.height;
    mode = frac < 0.3 ? "before" : frac > 0.7 ? "after" : "child";
    target = row;
    row.classList.add(mode === "before" ? "drop-before" : mode === "after" ? "drop-after" : "drop-child");
  };

  const onUp = () => {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    const tid = target?.dataset.id;
    const wasDragging = dragging;
    listEl.querySelector(".task.dragging")?.classList.remove("dragging");
    clearIndicator();
    if (wasDragging && dragId && tid) moveNode(dragId, tid, mode);
    dragId = null;
    dragging = false;
    if (wasDragging) {
      justDragged = true; // swallow the trailing click so it doesn't open an editor
      setTimeout(() => (justDragged = false), 0);
    }
  };

  listEl.addEventListener("pointerdown", (e) => {
    const t = e.target as HTMLElement;
    if (t.closest(".tcheck, .tbtn, .tcaret, .tedit")) return; // those have their own behavior
    const row = t.closest(".task") as HTMLElement | null;
    if (!row || e.button !== 0) return;
    dragId = row.dataset.id!;
    startY = e.clientY;
    dragging = false;
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  });
}

function moveNode(dragId: string, targetId: string, mode: "before" | "after" | "child") {
  if (dragId === targetId) return;
  const node = findNode(model, dragId);
  if (!node || contains(node, targetId)) return;
  removeById(model, dragId);
  if (mode === "child") {
    const t = findNode(model, targetId);
    if (!t) return;
    t.children.push(node);
    t.collapsed = false;
  } else {
    const loc = locate(model, targetId);
    if (!loc) return;
    loc.list.splice(loc.index + (mode === "after" ? 1 : 0), 0, node);
  }
  render();
  save();
}

function el(tag: string, cls: string): HTMLElement {
  const n = document.createElement(tag);
  n.className = cls;
  return n;
}
