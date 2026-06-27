import { readdir, stat, mkdir } from "node:fs/promises";
import os from "node:os";
import { join, dirname } from "node:path";

/**
 * List the sub-directories of `p` for the in-browser folder picker. Returns the
 * resolved path, its parent (null at filesystem root), the home dir, and the
 * child directories — each with `mtime` (last edited) and `btime` (created) so
 * the client can sort by them. Dotfiles hidden, symlinks-to-dirs followed.
 * Throws if the path can't be read — the route turns that into a 400.
 */
export async function listDirs(p) {
  const home = os.homedir();
  const dir = p && String(p).trim() ? String(p).replace(/^~/, home) : home;

  const names = await readdir(dir);
  const dirs = [];
  for (const name of names) {
    if (name.startsWith(".")) continue; // hide dotfiles by default
    const full = join(dir, name);
    let st;
    try {
      st = await stat(full); // follows symlinks
    } catch {
      continue; // unreadable / broken symlink
    }
    if (!st.isDirectory()) continue;
    dirs.push({ name, path: full, mtime: st.mtimeMs, btime: st.birthtimeMs });
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name));

  return {
    path: dir,
    parent: dir === "/" ? null : dirname(dir),
    home,
    entries: dirs,
  };
}

/** Create a new folder `name` inside `parent`. Rejects names with path separators. */
export async function makeDir(parent, name) {
  if (!parent || !name || /[/\\]/.test(name) || name === "." || name === "..") {
    throw new Error("invalid folder name");
  }
  const full = join(parent, name);
  await mkdir(full); // throws if it already exists
  return full;
}
