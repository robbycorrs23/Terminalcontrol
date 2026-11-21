/** Images in a paste event, as named Files (a pasted screenshot has no useful name). */
export function clipboardImages(data: DataTransfer): File[] {
  const out: File[] = [...data.files].filter((f) => f.type.startsWith("image/"));
  if (!out.length) {
    for (const item of data.items) {
      if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
      const f = item.getAsFile();
      if (f) out.push(f);
    }
  }
  return out.map((f, i) => renamePasted(f, i));
}

/** Read images via the async Clipboard API (needs a user gesture; the browser may ask). */
export async function readClipboardImages(): Promise<File[]> {
  try {
    const items = await navigator.clipboard.read();
    const out: File[] = [];
    for (const item of items) {
      const type = item.types.find((t) => t.startsWith("image/"));
      if (!type) continue;
      const blob = await item.getType(type);
      out.push(renamePasted(new File([blob], "image", { type }), out.length));
    }
    return out;
  } catch {
    return []; // denied, or nothing readable
  }
}

function renamePasted(f: File, i: number): File {
  if (f.name && f.name !== "image.png" && f.name !== "image") return f;
  const ext = (f.type.split("/")[1] || "png").replace("jpeg", "jpg").replace(/[^a-z0-9]/g, "");
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
  return new File([f], `pasted-${stamp}${i ? "-" + i : ""}.${ext}`, { type: f.type });
}
