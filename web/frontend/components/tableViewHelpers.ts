/**
 * tableViewHelpers — pure helpers for TableView state management.
 * Extracted into a plain .ts file so they can be unit-tested without
 * needing React's JSX dev runtime.
 */

import type { TableRow } from "../tableModel";

/**
 * Build a collapse state map where every collapsible row (hasChildren=true)
 * is set to the given value.
 */
export function buildCollapseAll(
  rows: TableRow[],
  collapsed: boolean,
): Record<string, boolean> {
  const state: Record<string, boolean> = {};
  for (const row of rows) {
    if (row.hasChildren) {
      state[row.qid] = collapsed;
    }
  }
  return state;
}

/**
 * Toggle a single row's collapse state.
 */
export function toggleCollapse(
  prev: Record<string, boolean>,
  qid: string,
): Record<string, boolean> {
  return { ...prev, [qid]: !prev[qid] };
}

/**
 * Return true if every collapsible row is collapsed.
 */
export function allCollapsed(rows: TableRow[]): boolean {
  const collapsible = rows.filter((r) => r.hasChildren);
  if (collapsible.length === 0) return false;
  return collapsible.every((r) => r.isCollapsed);
}
