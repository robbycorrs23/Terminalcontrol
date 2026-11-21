/**
 * Inline SVG control icons.
 *
 * Why not Unicode: this UI deliberately carries no colour emoji (they render at
 * a different weight and a ~22px advance against ~12px for text glyphs, so they
 * can never be sized to match a monochrome control set). The first attempt
 * swapped them for text-presentation characters — ⊕ for attach, ⚿ for secret —
 * which passed the test they were chosen against (monochrome, not tofu) and
 * failed the one that mattered: nobody could tell what they were. Unicode has
 * no legible monochrome padlock or paperclip at 15px.
 *
 * So: real paths. They inherit `currentColor`, so hover/disabled/theme states
 * come for free, and they stay crisp at any size.
 *
 * Paths adapted from Feather Icons (https://feathericons.com), MIT licensed.
 */

export type IconName =
  | "attach"
  | "secret"
  | "terminal"
  | "chat"
  | "flag"
  | "stop"
  | "down"
  | "menu"
  | "folder";

/** Inner markup for a 24x24 viewBox. Stroked unless the icon opts into fill. */
const PATHS: Record<IconName, string> = {
  attach:
    '<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
  secret:
    '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>',
  chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
  down: '<line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/>',
  menu: '<line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/>',
  folder:
    '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
};

/** Icons drawn as a solid shape rather than an outline. */
const FILLED = new Set<IconName>(["stop"]);

/**
 * Markup for an icon, for the title bars that are assembled as innerHTML
 * strings. Safe there because this is our own static markup — the rule that
 * matters (see markdown.ts) is that MODEL output never reaches innerHTML
 * unescaped, and none of this is model output.
 */
export function iconSvg(name: IconName): string {
  const cls = FILLED.has(name) ? "ico-svg fill" : "ico-svg";
  return `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${PATHS[name]}</svg>`;
}

/** Same icon as a node, for the controls built with createElement. */
export function setIcon(el: HTMLElement, name: IconName): void {
  el.innerHTML = iconSvg(name);
}
