/**
 * Full-screen image viewer for chat panes. Tapping an inline image (your own
 * attachment, a screenshot Claude read, an image in a reply) opens it here
 * instead of navigating away — in an installed PWA, a plain link would bounce
 * you out to a Safari sheet. Tap anywhere or press Esc to close.
 *
 * One overlay per page, created lazily. `src` is always a URL that was already
 * vetted by whoever rendered the thumbnail (an /api/file path or a
 * scheme-checked URL from markdown.ts), and it only ever lands in img.src.
 */
let overlay: HTMLElement | null = null;

function ensure(): HTMLElement {
  if (overlay) return overlay;
  const o = document.createElement("div");
  o.className = "lightbox";
  o.hidden = true;
  const img = document.createElement("img");
  img.alt = "";
  const open = document.createElement("a");
  open.className = "lightbox-open";
  open.target = "_blank";
  open.rel = "noopener noreferrer";
  open.textContent = "Open original";
  open.addEventListener("click", (e) => e.stopPropagation());
  const copy = document.createElement("button");
  copy.className = "lightbox-copy";
  copy.textContent = "Copy image";
  copy.hidden = typeof ClipboardItem === "undefined" || !navigator.clipboard?.write;
  copy.addEventListener("click", async (e) => {
    e.stopPropagation();
    copy.textContent = (await copyImage(img.currentSrc || img.src)) ? "Copied" : "Couldn't copy";
    setTimeout(() => (copy.textContent = "Copy image"), 1500);
  });
  const actions = document.createElement("div");
  actions.className = "lightbox-actions";
  actions.append(copy, open);
  o.append(img, actions);
  o.addEventListener("click", close);
  addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !o.hidden) {
      e.stopPropagation();
      close();
    }
  }, true);
  document.body.append(o);
  overlay = o;
  return o;
}

/**
 * Put an image on the system clipboard so it can be pasted into another
 * chat, a doc, Messages… Clipboards only reliably take PNG, so anything else
 * is redrawn through a canvas first. The ClipboardItem gets a PROMISE of the
 * blob, created synchronously inside the click — Safari rejects a write
 * that starts after an await has dropped the user gesture.
 */
export async function copyImage(src: string): Promise<boolean> {
  try {
    const png = fetch(src)
      .then((r) => r.blob())
      .then((b) => (b.type === "image/png" ? b : toPng(b)));
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
    return true;
  } catch {
    return false;
  }
}

async function toPng(blob: Blob): Promise<Blob> {
  const bmp = await createImageBitmap(blob);
  const c = document.createElement("canvas");
  c.width = bmp.width;
  c.height = bmp.height;
  c.getContext("2d")!.drawImage(bmp, 0, 0);
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error("encode failed"))), "image/png"));
}

function close() {
  if (overlay) overlay.hidden = true;
}

export function openLightbox(src: string, alt = "") {
  const o = ensure();
  const img = o.querySelector("img") as HTMLImageElement;
  img.src = src;
  img.alt = alt;
  (o.querySelector(".lightbox-open") as HTMLAnchorElement).href = src;
  o.hidden = false;
}

/**
 * Route clicks on any image inside `root` to the lightbox (event delegation,
 * so images added later — streamed replies, step results — are covered).
 */
export function wireLightbox(root: HTMLElement) {
  root.addEventListener("click", (e) => {
    const img = (e.target as HTMLElement).closest("img") as HTMLImageElement | null;
    if (!img || !root.contains(img) || img.closest(".lightbox")) return;
    if (!img.matches(".md-img, .msg-img, .step-img, .attach-thumb img")) return;
    e.preventDefault();
    e.stopPropagation();
    openLightbox(img.currentSrc || img.src, img.alt);
  });
}
