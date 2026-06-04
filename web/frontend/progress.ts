/**
 * progress — lightweight helpers that compute done/total/blocked counts
 * from boardModel output. No React; no side effects.
 */

import type { EpicRow, StoryCell } from "./boardModel";

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export interface EpicProgress {
  /** Total number of stories in the epic. */
  total: number;
  /** Number of stories with status === "done". */
  done: number;
  /** Number of stories with status === "blocked". */
  blocked: number;
}

export interface StoryProgress {
  /** Total number of tasks in the story. */
  total: number;
  /** Number of tasks with status === "done". */
  done: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute done / total / blocked story counts for one epic row.
 */
export function epicProgress(row: EpicRow): EpicProgress {
  let total = 0;
  let done = 0;
  let blocked = 0;

  for (const cells of Object.values(row.statusColumns)) {
    for (const cell of cells) {
      total++;
      if (cell.status === "done") done++;
      if (cell.status === "blocked") blocked++;
    }
  }

  return { total, done, blocked };
}

/**
 * Compute done / total task counts for one story cell.
 */
export function storyProgress(story: StoryCell): StoryProgress {
  const total = story.taskNodes.length;
  const done = story.taskNodes.filter((t) => t.status === "done").length;
  return { total, done };
}
