/**
 * Theme management.
 *
 * The active theme is applied as `[data-theme]` on `<html>`.
 * The choice is persisted in localStorage under `loom-theme`.
 *
 * Supported values: "light" (Notion warm) | "dark" (Linear dark).
 * The CSS in tokens.css uses `[data-theme="linear"]` for dark mode,
 * so we map our logical "dark" to the "linear" data-theme attribute.
 */

export type Theme = "light" | "dark";

const STORAGE_KEY = "loom-theme";
const ATTR = "data-theme";

/** CSS data-theme values used by tokens.css */
const CSS_THEME: Record<Theme, string> = {
  light: "notion",
  dark: "linear",
};

/**
 * Read the persisted theme preference.
 * Falls back to "light" if nothing is stored or the stored value is invalid.
 */
export function getTheme(): Theme {
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored === "dark" ? "dark" : "light";
}

/**
 * Apply a theme: writes `[data-theme]` to `<html>` and persists to localStorage.
 */
export function setTheme(theme: Theme): void {
  document.documentElement.setAttribute(ATTR, CSS_THEME[theme]);
  localStorage.setItem(STORAGE_KEY, theme);
}

/**
 * Initialise the theme on page load.
 * Call this once at app startup (before first render or in main.tsx).
 */
export function initTheme(): void {
  setTheme(getTheme());
}
