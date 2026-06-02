/**
 * TableView — fixed-layout epic▸story▸task tree table.
 *
 * Columns: Name 40% / Progress 22% / Status 20% / Updated 18%
 *
 * Each row is rendered by TableRow. Per-row collapse state and the global
 * Expand/Collapse-all action are managed here; the collapse state map is
 * passed down to tableModel() so it controls visibility.
 *
 * The Expand/Collapse-all button is surfaced via onCollapseAllChange so
 * the parent (TopBar context or App) can wire it into the top bar.
 */

import React, { useEffect, useState, useCallback } from "react";
import { getProjectTree } from "../api/client";
import type { ProjectSummary } from "../api/client";
import { tableModel, TABLE_COLUMNS } from "../tableModel";
import type { TableRow as TableRowData } from "../tableModel";
import TableRowComponent from "./TableRow";
import { buildCollapseAll, toggleCollapse } from "./tableViewHelpers";

// ---------------------------------------------------------------------------
// TableView
// ---------------------------------------------------------------------------

export interface TableViewProps {
  project: ProjectSummary;
  onOpen: (qid: string) => void;
  /**
   * Receives the current "all collapsed?" state so TopBar can render the
   * Expand/Collapse-all button. Also receives the toggle handler.
   */
  onCollapseControl?: (
    isAllCollapsed: boolean,
    toggle: () => void,
  ) => void;
}

export default function TableView({
  project,
  onOpen,
  onCollapseControl,
}: TableViewProps): React.JSX.Element {
  const [allRows, setAllRows] = useState<TableRowData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [collapseState, setCollapseState] = useState<Record<string, boolean>>(
    {},
  );

  // Fetch tree when project changes.
  useEffect(() => {
    setLoading(true);
    setError(null);
    setCollapseState({});
    getProjectTree(project.qid)
      .then((tree) => {
        const rows = tableModel(tree, {});
        setAllRows(rows);
        setLoading(false);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
  }, [project.qid]);

  const handleToggle = useCallback((qid: string) => {
    setCollapseState((prev) => toggleCollapse(prev, qid));
  }, []);

  const handleExpandCollapseAll = useCallback(() => {
    setCollapseState((prev) => {
      const hasAnyCollapsed = allRows.some(
        (r) => r.hasChildren && !!prev[r.qid],
      );
      // If anything is collapsed → expand all; otherwise → collapse all.
      return buildCollapseAll(allRows, !hasAnyCollapsed);
    });
  }, [allRows]);

  // Notify parent about collapse control state.
  useEffect(() => {
    if (!onCollapseControl) return;
    const isAllCollapsed =
      allRows.filter((r) => r.hasChildren).length > 0 &&
      allRows
        .filter((r) => r.hasChildren)
        .every((r) => !!collapseState[r.qid]);
    onCollapseControl(isAllCollapsed, handleExpandCollapseAll);
  }, [allRows, collapseState, onCollapseControl, handleExpandCollapseAll]);

  if (loading) {
    return (
      <div
        className="view-scroll"
        style={{ display: "grid", placeItems: "center", minHeight: 200 }}
      >
        <span style={{ color: "var(--text-3)", fontSize: 13 }}>Loading…</span>
      </div>
    );
  }

  if (error) {
    return (
      <div
        className="view-scroll"
        style={{ display: "grid", placeItems: "center", minHeight: 200 }}
      >
        <span style={{ color: "var(--st-blocked-fg)", fontSize: 13 }}>
          {error}
        </span>
      </div>
    );
  }

  // Recompute visible rows from allRows + current collapseState each render.
  const visibleRows = filterByCollapse(allRows, collapseState);

  return (
    <div className="view-scroll">
      <div className="tablewrap">
        <table className="ttable" role="treegrid" aria-label="Project tree">
          <colgroup>
            {TABLE_COLUMNS.map((col) => (
              <col key={col.key} style={{ width: `${col.widthPct}%` }} />
            ))}
          </colgroup>
          <thead>
            <tr className="trow-head">
              {TABLE_COLUMNS.map((col) => (
                <th key={col.key} className={`thead-${col.key}`}>
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row) => (
              <TableRowComponent
                key={row.qid}
                row={row}
                onToggle={handleToggle}
                onOpen={onOpen}
              />
            ))}
            {visibleRows.length === 0 && (
              <tr>
                <td
                  colSpan={TABLE_COLUMNS.length}
                  style={{
                    textAlign: "center",
                    color: "var(--text-3)",
                    padding: "40px 0",
                    fontSize: 13,
                  }}
                >
                  No items found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// filterByCollapse — re-apply collapse state to the full row list.
//
// tableModel() already embeds hasChildren/isCollapsed, but the visible set
// needs to be re-derived from the full list each render when collapseState
// changes. We walk the list and skip rows whose ancestor is collapsed.
// ---------------------------------------------------------------------------

function filterByCollapse(
  rows: TableRowData[],
  collapseState: Record<string, boolean>,
): TableRowData[] {
  const result: TableRowData[] = [];
  // Track which ancestor qids are currently collapsed.
  // We use a stack approach: when we encounter a collapsed node, we skip its
  // descendants until we return to the same or shallower depth.
  let skipUntilDepth: number | null = null;

  for (const row of rows) {
    // If we're skipping descendants of a collapsed ancestor:
    if (skipUntilDepth !== null) {
      if (row.depth > skipUntilDepth) {
        // Update isCollapsed to reflect current state before skipping
        continue;
      } else {
        skipUntilDepth = null;
      }
    }

    // Push the row with its current isCollapsed state from collapseState.
    const isCollapsed = row.hasChildren ? !!collapseState[row.qid] : false;
    result.push({ ...row, isCollapsed });

    if (isCollapsed) {
      skipUntilDepth = row.depth;
    }
  }

  return result;
}
