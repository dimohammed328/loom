/**
 * epicSort — shared helper: sort top-level epic ItemNodes newest-first.
 *
 * Used by boardModel, tableModel, and dagLayout to present epics in a
 * consistent created_at-descending order across all dashboard views.
 *
 * Sort key: `created_at` string (ISO-8601), compared lexicographically.
 * Epics missing created_at sort after those that have it.
 */

import type { ItemNode } from "./api/client";

/**
 * Return a new array of epic qids sorted newest-first by created_at.
 *
 * @param epicQids - Ordered list of epic qids (from root.children).
 * @param byQid    - Map from qid → ItemNode for all tree items.
 * @returns New array of epic qids sorted by created_at descending.
 */
export function sortEpicsNewestFirst(
  epicQids: string[],
  byQid: Map<string, ItemNode>,
): string[] {
  return epicQids.slice().sort((a, b) => {
    const nodeA = byQid.get(a);
    const nodeB = byQid.get(b);
    const ca = nodeA?.created_at ?? "";
    const cb = nodeB?.created_at ?? "";
    // Descending: newer (larger ISO string) first
    if (cb > ca) return 1;
    if (cb < ca) return -1;
    return 0;
  });
}
