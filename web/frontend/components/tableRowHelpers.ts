/**
 * tableRowHelpers — pure helper functions for the TableRow component.
 * Extracted into a plain .ts file so they can be unit-tested without
 * needing React's JSX dev runtime.
 */

/** Format done/total task counts as "X/Y". */
export function taskMeterLabel(done: number, total: number): string {
  return `${done}/${total}`;
}

export interface ProgressBarData {
  done: number;
  remaining: number;
}

/** Compute done and remaining segment counts for a progress bar. */
export function progressBarSegments(done: number, total: number): ProgressBarData {
  return { done, remaining: total - done };
}

/** Human-readable label for a status string. Title-cases each word for canonical statuses. */
export function statusPillLabel(status: string | null): string {
  if (status === null) return "—";
  // Title-case every space-separated word.
  return status
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
