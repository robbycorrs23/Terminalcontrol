import { readFileSync, writeFileSync, existsSync } from "node:fs";

/**
 * Persists the global task tree to tasks.json. A node is:
 *   { id, text, done, collapsed, children: [ ...nodes ] }
 * The client owns the shape and sends the whole tree on each change; we validate
 * it lightly (known fields, bounded depth/size) and store it. One shared list for
 * the whole app, so changes broadcast to every window.
 */
export class TaskStore {
  constructor(file) {
    this.file = file;
    this.tasks = [];
    if (existsSync(file)) {
      try {
        const data = JSON.parse(readFileSync(file, "utf8"));
        if (Array.isArray(data?.tasks)) this.tasks = sanitize(data.tasks);
      } catch {}
    }
  }

  tree() {
    return this.tasks;
  }

  replace(tasks) {
    this.tasks = Array.isArray(tasks) ? sanitize(tasks) : [];
    try {
      writeFileSync(this.file, JSON.stringify({ tasks: this.tasks }, null, 2));
    } catch {}
    return this.tasks;
  }
}

// Defensive: keep only known fields and cap depth/size so a malformed or
// runaway tree can't blow up the store.
function sanitize(nodes, depth = 0) {
  if (!Array.isArray(nodes) || depth > 50) return [];
  return nodes
    .slice(0, 2000)
    .map((n) => ({
      id: String(n?.id ?? ""),
      text: String(n?.text ?? "").slice(0, 1000),
      done: !!n?.done,
      collapsed: !!n?.collapsed,
      children: sanitize(n?.children, depth + 1),
    }))
    .filter((n) => n.id);
}
