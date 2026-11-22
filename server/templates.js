import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

/**
 * Prompt templates: saved first messages for the jobs you start over and over
 * ("review this PR", "fix the failing tests") — a name + prompt, optionally a
 * folder, agent, view (chat/terminal) and "own branch". Used by the
 * new-session sheet (fills the form) and the chat composer's + → Templates
 * (inserts the prompt); managed in Settings → Prompt templates.
 *
 * Per machine (folders are this machine's): ~/.fleetview/templates.json, 0600.
 * Every field but name + prompt is optional, so a template can be just a
 * prompt you reuse anywhere.
 */

const FILE = join(homedir(), ".fleetview", "templates.json");

export function cleanTemplate(input, existing = null) {
  const name = String(input.name || "").trim().slice(0, 60);
  const prompt = String(input.prompt || "").trim().slice(0, 20000);
  if (!name) throw new Error("Give it a name.");
  if (!prompt) throw new Error("Write the prompt.");
  const cwd = String(input.cwd || "").trim().replace(/^~(?=\/|$)/, homedir()).slice(0, 1000);
  const cmd = String(input.cmd || "").trim();
  if (cmd && !/^(claude|codex)(-[a-z]+)?$/.test(cmd) && cmd !== "shell") throw new Error("Unknown agent.");
  const kind = input.kind === "pty" ? "pty" : input.kind === "agent" ? "agent" : "";
  return {
    id: existing?.id || randomBytes(6).toString("hex"),
    name,
    prompt,
    cwd, // "" = whatever folder you pick
    cmd, // "" = whatever agent you pick
    kind, // "" = whatever view you pick
    worktree: !!input.worktree,
    updatedAt: Date.now(),
  };
}

export function createTemplates(file = FILE) {
  let items = [];
  try {
    if (existsSync(file)) items = JSON.parse(readFileSync(file, "utf8")).templates || [];
  } catch (e) {
    console.warn(`[fleetview] could not read ${file}: ${e.message}`);
  }
  const save = () => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file + ".tmp", JSON.stringify({ templates: items }, null, 2), { mode: 0o600 });
    renameSync(file + ".tmp", file);
  };
  return {
    list: () => items.slice(),
    upsert(input) {
      const existing = input.id ? items.find((t) => t.id === input.id) : null;
      if (input.id && !existing) throw new Error("That template no longer exists.");
      const t = cleanTemplate(input, existing);
      items = existing ? items.map((x) => (x.id === t.id ? t : x)) : [...items, t];
      save();
      return t;
    },
    remove(id) {
      const n = items.length;
      items = items.filter((t) => t.id !== id);
      if (items.length !== n) save();
      return items.length !== n;
    },
  };
}
