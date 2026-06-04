/**
 * Return `baseClass` with " loom-status-chip" appended.
 *
 * Apply to status pills, status dots, and node status labels so the CSS
 * color transition fires whenever the underlying status color changes via
 * a WS store update.
 */
export function statusChip(baseClass: string): string {
  return `${baseClass} loom-status-chip`;
}
