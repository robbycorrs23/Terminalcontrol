/**
 * File attach/drop plumbing shared by `Term` (types the resolved path into
 * the terminal prompt) and `AgentChat` (inserts it into the chat textarea) —
 * extracted out of terminal.ts so neither has to duplicate it.
 */

export function readAsDataURL(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

/**
 * Uploads each file via `POST /api/panes/:id/file` and returns the resolved
 * absolute paths (in input order, skipping any that failed or were too
 * large) — the same contract as dragging a file into a real terminal.
 */
export async function uploadFiles(paneId: string, files: File[]): Promise<string[]> {
  const paths: string[] = [];
  for (const f of files) {
    // Base64-over-JSON transport caps out ~20MB real bytes (30MB body limit);
    // bigger files would 413 anyway, so skip them up front.
    if (f.size > 20 * 1024 * 1024) {
      console.error(`file too large to attach (>20MB): ${f.name}`);
      continue;
    }
    try {
      const dataUrl = await readAsDataURL(f);
      const res = await fetch(`/api/panes/${paneId}/file`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: f.name, dataUrl }),
      });
      if (!res.ok) {
        console.error("file upload failed", await res.text());
        continue;
      }
      const { path } = await res.json();
      if (path) paths.push(path);
    } catch (err) {
      console.error("file upload failed", err);
    }
  }
  return paths;
}

/**
 * Wires drag-and-drop onto `target`: adds/removes a `.dropping` class for
 * CSS feedback, filters out directories (unsupported — they arrive as
 * zero-byte phantom files), and calls `onFiles` with whatever real files
 * were dropped. A non-file drop (e.g. dragging selected terminal text) is
 * left alone so the browser/xterm's own handling still applies.
 */
export function wireFileDrop(target: HTMLElement, onFiles: (files: File[]) => void): void {
  let depth = 0; // dragenter/leave fire per child; count to know when we truly left

  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types || []).includes("Files");

  target.addEventListener("dragenter", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    target.classList.add("dropping");
  });
  target.addEventListener("dragover", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  });
  target.addEventListener("dragleave", (e) => {
    if (!hasFiles(e)) return;
    if (--depth <= 0) {
      depth = 0;
      target.classList.remove("dropping");
    }
  });
  target.addEventListener("drop", (e) => {
    depth = 0;
    target.classList.remove("dropping");
    const items = Array.from(e.dataTransfer?.items || []).filter((it) => it.kind === "file");
    if (!items.length) return; // not a file drop → let the browser/xterm do its thing
    e.preventDefault(); // even a folders-only drop must not navigate the page
    e.stopPropagation();
    const files: File[] = [];
    for (const it of items) {
      if (it.webkitGetAsEntry?.()?.isDirectory) continue;
      const f = it.getAsFile();
      if (f) files.push(f);
    }
    if (files.length) onFiles(files);
  });
}

/** Wires a hidden `<input type=file>` (appended to `container`) triggered by clicking `button`. */
export function wireFilePicker(
  button: HTMLElement,
  container: HTMLElement,
  onFiles: (files: File[]) => void
): void {
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.multiple = true;
  fileInput.hidden = true;
  fileInput.className = "file-input";
  container.append(fileInput);
  button.addEventListener("click", (e) => {
    e.stopPropagation();
    fileInput.click();
  });
  fileInput.addEventListener("change", () => {
    const files = Array.from(fileInput.files || []);
    fileInput.value = ""; // let the same file be re-picked next time
    if (files.length) onFiles(files);
  });
}
