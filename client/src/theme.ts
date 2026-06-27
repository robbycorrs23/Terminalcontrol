// Appearance prefs (theme + text size). Stored in localStorage so they apply
// across all windows of this browser and persist. The UI chrome reacts via the
// body.light / body.big classes (CSS); xterm needs its colors/fontSize set in JS,
// so we expose helpers the terminal reads at construction and on toggle.

const KEY_THEME = "fleet-theme"; // "light" | "dark"
const KEY_TEXT = "fleet-text"; // "big" | "normal"

export interface Appearance {
  light: boolean;
  big: boolean;
}

export function getAppearance(): Appearance {
  return {
    light: localStorage.getItem(KEY_THEME) === "light",
    big: localStorage.getItem(KEY_TEXT) === "big",
  };
}

export function setAppearance(a: Appearance) {
  localStorage.setItem(KEY_THEME, a.light ? "light" : "dark");
  localStorage.setItem(KEY_TEXT, a.big ? "big" : "normal");
}

export function xtermTheme(light = getAppearance().light) {
  return light
    ? {
        background: "#ffffff",
        foreground: "#1f2328",
        cursor: "#1f2328",
        cursorAccent: "#ffffff",
        selectionBackground: "#b6dcff",
      }
    : {
        background: "#000000",
        foreground: "#c9d1d9",
        cursor: "#c9d1d9",
        selectionBackground: "#3b5070",
      };
}

export function xtermFontSize(big = getAppearance().big) {
  return big ? 17 : 12;
}
