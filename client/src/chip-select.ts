import { el } from "./chat-steps";

/**
 * Wrap a <select> so what you SEE is a small styled label, while the real
 * select sits invisibly on top of it at 16px. Why: iOS zooms the whole page
 * when you focus a form control whose text is under 16px — tapping the 11px
 * mode picker blew the app up and left it zoomed. The invisible select still
 * gets the tap and opens the native picker.
 */
export function chipSelect(sel: HTMLSelectElement, cls: string): HTMLElement {
  const chip = el("span", `sel-chip ${cls}`);
  const label = el("span", "sel-label");
  chip.append(label, sel);
  const sync = () => {
    label.textContent = sel.selectedOptions[0]?.textContent || "";
    chip.title = sel.title;
  };
  sel.addEventListener("change", sync);
  (sel as HTMLSelectElement & { syncChip?: () => void }).syncChip = sync;
  sync();
  return chip;
}
export function syncChip(sel: HTMLSelectElement) {
  (sel as HTMLSelectElement & { syncChip?: () => void }).syncChip?.();
}
