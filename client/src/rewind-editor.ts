/**
 * The in-place editor for "edit an earlier message and resend from there".
 * Shown instead of the message bubble; agent-chat.ts does the talking to the
 * server (rewindPreview → apply(), rewind → onSubmit) and replaces the whole
 * log when the rewind lands.
 *
 * It states the consequences before you commit: how many later turns leave
 * this chat (the original conversation stays saved and can be restored with
 * Undo), and — only if you turn it on — which files would be put back. File
 * restore is OFF by default: changing files on disk should be a deliberate
 * choice, and it only covers edits made with Claude's file tools.
 *
 * All text via textContent.
 */
import { el } from "./chat-steps";

export type RewindPreview = {
  ok: boolean;
  reason?: string;
  laterTurns?: number;
  files?: { available: boolean; list: string[]; insertions?: number; deletions?: number; note?: string };
};

export type RewindEditor = {
  el: HTMLElement;
  apply(p: RewindPreview): void;
  fail(reason: string): void;
  focus(): void;
};

export function createRewindEditor(
  text: string,
  onSubmit: (text: string, restoreFiles: boolean) => void,
  onCancel: () => void
): RewindEditor {
  const card = el("div", "rw-card");
  card.addEventListener("click", (e) => e.stopPropagation());

  const title = el("div", "rw-title");
  title.textContent = "Edit message";
  const box = document.createElement("textarea");
  box.className = "rw-text";
  box.value = text;
  box.rows = Math.min(8, Math.max(2, text.split("\n").length + 1));

  const info = el("div", "rw-info");
  info.textContent = "Checking what this would change…";

  const fileRow = el("label", "rw-switch");
  const fileToggle = document.createElement("input");
  fileToggle.type = "checkbox";
  fileToggle.disabled = true;
  const fileLabel = el("span", "rw-switch-label");
  fileLabel.textContent = "Also restore files";
  fileRow.append(fileLabel, fileToggle);
  const fileDetail = el("div", "rw-files");
  fileDetail.hidden = true;

  const err = el("div", "rw-error");
  err.hidden = true;

  const btns = el("div", "rw-btns");
  const cancel = el("button", "rw-cancel") as HTMLButtonElement;
  cancel.textContent = "Cancel";
  const send = el("button", "rw-send") as HTMLButtonElement;
  send.textContent = "Resend";
  send.disabled = true;
  btns.append(cancel, send);
  card.append(title, box, info, fileRow, fileDetail, err, btns);

  let preview: RewindPreview | null = null;
  const renderFiles = () => {
    const f = preview?.files;
    fileDetail.textContent = "";
    fileDetail.hidden = !f || (!fileToggle.checked && f.available);
    if (!f) return;
    if (!f.available) {
      fileDetail.hidden = false;
      fileDetail.textContent = f.note || "Files can't be restored for this session.";
      return;
    }
    if (!fileToggle.checked) return;
    const lines: string[] = [];
    if (!f.list.length) lines.push("No files changed since this message — nothing to restore.");
    else {
      lines.push(`${f.list.length} file${f.list.length === 1 ? "" : "s"} will be put back as they were:`);
      for (const p of f.list.slice(0, 8)) lines.push("· " + (p.split("/").pop() || p));
      if (f.list.length > 8) lines.push(`· …and ${f.list.length - 8} more`);
    }
    lines.push("Changes made by shell commands aren't restored. Undo puts the current versions back.");
    for (const l of lines) {
      const d = el("div", "");
      d.textContent = l;
      fileDetail.append(d);
    }
  };
  fileToggle.addEventListener("change", renderFiles);

  const sync = () => {
    send.disabled = !preview?.ok || !box.value.trim();
  };
  box.addEventListener("input", sync);
  box.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") onCancel();
    else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send.click();
  });
  cancel.addEventListener("click", () => onCancel());
  send.addEventListener("click", () => {
    if (send.disabled) return;
    send.disabled = true;
    cancel.disabled = true;
    send.textContent = "Rewinding…";
    onSubmit(box.value.trim(), fileToggle.checked && !!preview?.files?.available);
  });

  return {
    el: card,
    apply(p) {
      preview = p;
      if (!p.ok) {
        info.textContent = p.reason || "This message can't be edited.";
        info.classList.add("bad");
        fileRow.hidden = true;
        sync();
        return;
      }
      const n = p.laterTurns || 0;
      info.textContent =
        n === 0
          ? "Claude's reply to this message will be replaced. The original conversation stays saved — you can undo."
          : `This and ${n} later turn${n === 1 ? "" : "s"} will be removed from this chat. The original conversation stays saved — you can undo.`;
      fileToggle.disabled = !p.files?.available;
      renderFiles();
      sync();
    },
    fail(reason) {
      err.hidden = false;
      err.textContent = reason;
      send.textContent = "Resend";
      cancel.disabled = false;
      sync();
    },
    focus() {
      box.focus();
      box.setSelectionRange(box.value.length, box.value.length);
    },
  };
}
