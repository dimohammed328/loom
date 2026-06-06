/**
 * TableView — fixed-layout epic▸story▸task tree table.
 *
 * Columns: Name 40% / Progress 22% / Status 20% / Updated 18%
 *
 * Per-row collapse state lives here. The component registers a
 * CollapseControl into the app store so TopBar can surface the
 * Expand/Collapse-all button while this view is mounted.
 *
 * Rows are derived from the store's itemsById so that SSE-delivered
 * updates appear without a manual refresh.
 */

import React, { useEffect, useState, useCallback, useMemo } from "react";
import type { ProjectSummary } from "../api/client";
import { tableModel, TABLE_COLUMNS } from "../tableModel";
import type { TableRow as TableRowData } from "../tableModel";
import { useAppStore } from "../state/store";
import TableRowComponent from "./TableRow";
import { buildCollapseAll, toggleCollapse } from "./tableViewHelpers";

// ---------------------------------------------------------------------------
// TableView
// ---------------------------------------------------------------------------

export interface TableViewProps {
  project: ProjectSummary;
  onOpen: (qid: string) => void;
}

export default function TableView({
  project,
  onOpen,
}: TableViewProps): React.JSX.Element {
  const { setCollapseControl, itemsById } = useAppStore();

  const [collapseState, setCollapseState] = useState<Record<string, boolean>>(
    {},
  );

  // Derive all rows from the store's itemsById — re-renders automatically
  // on every SSE-delivered update.
  const allRows = useMemo<TableRowData[]>(() => {
    if (!itemsById) return [];
    const items = Object.values(itemsById);
    return tableModel({ root: project.qid, items }, {});
  }, [itemsById, project.qid]);

  // Clear control on unmount.
  useEffect(() => {
    return () => setCollapseControl(null);
  }, [setCollapseControl]);

  const handleToggle = useCallback((qid: string) => {
    setCollapseState((prev) => toggleCollapse(prev, qid));
  }, []);

  const handleExpandCollapseAll = useCallback(() => {
    setCollapseState((prev) => {
      const hasAnyCollapsed = allRows.some(
        (r) => r.hasChildren && !!prev[r.qid],
      );
      // Anything collapsed → expand all; nothing collapsed → collapse all.
      return buildCollapseAll(allRows, !hasAnyCollapsed);
    });
  }, [allRows]);

  // Register the collapse control into the store so TopBar can show the button.
  useEffect(() => {
    const collapsibleRows = allRows.filter((r) => r.hasChildren);
    const isAllCollapsed =
      collapsibleRows.length > 0 &&
      collapsibleRows.every((r) => !!collapseState[r.qid]);
    setCollapseControl({ isAllCollapsed, toggle: handleExpandCollapseAll });
  }, [allRows, collapseState, setCollapseControl, handleExpandCollapseAll]);

  if (!itemsById) {
    return (
      <div
        className="view-scroll"
        style={{ display: "grid", placeItems: "center", minHeight: 200 }}
      >
        <span style={{ color: "var(--text-3)", fontSize: 13 }}>Loading…</span>
      </div>
    );
  }

  // Re-derive visible rows from allRows + current collapseState each render.
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
// Walks allRows and omits descendants of collapsed nodes, updating each
// row's isCollapsed field to reflect the current collapseState.
// ---------------------------------------------------------------------------

function filterByCollapse(
  rows: TableRowData[],
  collapseState: Record<string, boolean>,
): TableRowData[] {
  const result: TableRowData[] = [];
  let skipUntilDepth: number | null = null;

  for (const row of rows) {
    if (skipUntilDepth !== null) {
      if (row.depth > skipUntilDepth) continue;
      else skipUntilDepth = null;
    }

    const isCollapsed = row.hasChildren ? !!collapseState[row.qid] : false;
    result.push({ ...row, isCollapsed });

    if (isCollapsed) {
      skipUntilDepth = row.depth;
    }
  }

  return result;
}
