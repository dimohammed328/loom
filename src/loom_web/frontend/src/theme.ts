/**
 * Theme management — full implementation in task 7.
 * Stub exists so TopBar can import without build errors.
 */
export type Theme = "light" | "dark";

export function getTheme(): Theme {
  return (localStorage.getItem("loom-theme") as Theme | null) ?? "light";
}

export function setTheme(_theme: Theme): void {
  // Full implementation added in task 7.
}
