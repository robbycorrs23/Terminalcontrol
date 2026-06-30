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
let editing = false; // a task modal is open — don't clobber it with remote updates

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

  // Click anywhere outside the sidebar (but not on its toggle button or the task
  // modal) closes it.
  document.addEventListener("pointerdown", (e) => {
    if (!aside.classList.contains("open")) return;
    const t = e.target as HTMLElement;
    if (t.closest("#tasks") || t.closest("#tasksBtn") || t.closest(".taskmodal")) return;
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
  buildTaskModal();
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
  row.draggable = true; // native drag-and-drop to reorder / re-nest
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
  text.title = node.text; // hover peek
  text.addEventListener("click", () => openTaskModal(node)); // click → full-text modal

  const add = el("button", "tbtn tadd") as HTMLButtonElement;
  add.textContent = "＋";
  add.title = "Add subtask";
  add.addEventListener("click", (e) => {
    e.stopPropagation();
    const child = newNode("");
    node.children.push(child);
    node.collapsed = false;
    render();
    openTaskModal(child); // type the subtask in the modal (blank cancel removes it)
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

// ---- task modal (view / edit the full text) ---------------------------
let modalEl: HTMLElement;
let modalTa: HTMLTextAreaElement;
let modalNode: TaskNode | null = null;

function buildTaskModal() {
  modalEl = el("div", "taskmodal");
  modalEl.hidden = true;
  modalEl.innerHTML =
    `<div class="panel">` +
    `<div class="phead"><span class="ptitle">Task</span></div>` +
    `<textarea class="tm-text" placeholder="Task…"></textarea>` +
    `<div class="pfoot"><span class="spacer"></span>` +
    `<button class="tm-cancel">Cancel</button>` +
    `<button class="tm-save primary">Save</button></div>` +
    `</div>`;
  document.body.append(modalEl);
  modalTa = modalEl.querySelector(".tm-text") as HTMLTextAreaElement;
  modalEl.querySelector(".tm-save")!.addEventListener("click", saveModal);
  modalEl.querySelector(".tm-cancel")!.addEventListener("click", cancelModal);
  modalEl.addEventListener("click", (e) => {
    if (e.target === modalEl) cancelModal(); // click the backdrop
  });
  modalTa.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation(); // don't let the global Esc also close the sidebar/zoom
      cancelModal();
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      saveModal(); // ⌘/Ctrl+Enter to save; plain Enter makes a newline
    }
  });
}

function openTaskModal(node: TaskNode) {
  modalNode = node;
  editing = true; // pause remote updates while open
  modalTa.value = node.text;
  modalEl.hidden = false;
  setTimeout(() => {
    modalTa.focus();
    modalTa.select();
  }, 0);
}

function closeModal() {
  modalEl.hidden = true;
  modalNode = null;
  editing = false;
}

function saveModal() {
  if (!modalNode) return;
  modalNode.text = modalTa.value.trim();
  if (!modalNode.text) removeById(model, modalNode.id);
  closeModal();
  render();
  save();
}

function cancelModal() {
  if (!modalNode) return;
  // Discard a blank task (e.g. a just-added subtask the user cancelled).
  const removed = !modalNode.text && removeById(model, modalNode.id);
  closeModal();
  render();
  if (removed) save();
}

// ---- drag to reorder / re-nest ---------------------------------------
// Native HTML5 drag-and-drop: rows are `draggable`, so the browser provides a
// real drag image. Drop on the top/bottom third of a row to place before/after
// it, or the middle to make it a child. Delegated on the list so it survives
// re-renders.
function wireDrag() {
  let dragId: string | null = null;
  let target: HTMLElement | null = null;
  let mode: "before" | "after" | "child" = "before";

  const clearIndicator = () => {
    if (target) target.classList.remove("drop-before", "drop-after", "drop-child");
    target = null;
  };

  listEl.addEventListener("dragstart", (e) => {
    const row = (e.target as HTMLElement).closest(".task") as HTMLElement | null;
    if (!row) return;
    dragId = row.dataset.id!;
    row.classList.add("dragging");
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", dragId); // Firefox won't start a drag without data
    }
  });

  listEl.addEventListener("dragover", (e) => {
    if (dragId == null) return;
    const row = (e.target as HTMLElement).closest(".task") as HTMLElement | null;
    clearIndicator();
    if (!row || row.dataset.id === dragId) return;
    const node = findNode(model, dragId);
    if (node && contains(node, row.dataset.id!)) return; // can't drop into its own subtree
    e.preventDefault(); // calling preventDefault marks this a valid drop target
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    const r = row.getBoundingClientRect();
    const frac = (e.clientY - r.top) / r.height;
    mode = frac < 0.3 ? "before" : frac > 0.7 ? "after" : "child";
    target = row;
    row.classList.add(mode === "before" ? "drop-before" : mode === "after" ? "drop-after" : "drop-child");
  });

  listEl.addEventListener("drop", (e) => {
    e.preventDefault();
    const tid = target?.dataset.id;
    clearIndicator();
    if (dragId && tid) moveNode(dragId, tid, mode);
  });

  listEl.addEventListener("dragend", () => {
    listEl.querySelector(".task.dragging")?.classList.remove("dragging");
    clearIndicator();
    dragId = null;
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
