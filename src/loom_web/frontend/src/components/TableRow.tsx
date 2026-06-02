/**
 * TableRow — presentational row for the Table view.
 *
 * Renders one row of the epic▸story▸task tree table with:
 *  - Indented name cell with collapse chevron
 *  - Progress cell (mini task meter for stories, story bar for epics)
 *  - Status pill
 *  - Updated placeholder (dash — live timestamps are out of scope)
 *
 * Pure helper functions are exported for unit tests.
 */

import React from "react";
import type { TableRow as TableRowData } from "../tableModel";
import { statusColor } from "../status";
import {
  taskMeterLabel,
  progressBarSegments,
  statusPillLabel,
} from "./tableRowHelpers";
import { rowClickHandler, rowKeyDownHandler } from "./tableRowClickHelpers";
import { enterClass } from "./enterClass";
import { statusChip } from "./statusChip";

// Re-export so callers can import from a single place.
export { taskMeterLabel, progressBarSegments } from "./tableRowHelpers";
export type { ProgressBarData } from "./tableRowHelpers";
export { statusPillLabel } from "./tableRowHelpers";

// ---------------------------------------------------------------------------
// Inline SVG icons
// ---------------------------------------------------------------------------

function IconChevronRight(): React.JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path
        d="M5 3l4 4-4 4"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconChevronDown(): React.JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path
        d="M3 5l4 4 4-4"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** Task progress ticks for story rows. */
function TaskMeter({
  done,
  total,
}: {
  done: number;
  total: number;
}): React.JSX.Element {
  if (total === 0) {
    return <span className="tcell-none">—</span>;
  }
  return (
    <span className="task-meter" title={`${done}/${total} tasks done`}>
      <span className="tm-ticks">
        {Array.from({ length: total }, (_, i) => (
          <span
            key={i}
            className="tm-tick"
            style={{
              background: i < done ? "var(--text-2)" : "var(--border-strong)",
            }}
          />
        ))}
      </span>
      <span className="tm-count mono">{taskMeterLabel(done, total)}</span>
    </span>
  );
}

/** Mini distribution bar for epic story progress. */
function StoryProgressBar({
  done,
  total,
}: {
  done: number;
  total: number;
}): React.JSX.Element {
  if (total === 0) {
    return <span className="tcell-none">—</span>;
  }
  const { remaining } = progressBarSegments(done, total);
  return (
    <span
      className="task-meter"
      title={`${done}/${total} stories done`}
    >
      <span className="tm-ticks">
        {Array.from({ length: done }, (_, i) => (
          <span
            key={`d${i}`}
            className="tm-tick"
            style={{ background: "var(--st-done-dot)" }}
          />
        ))}
        {Array.from({ length: remaining }, (_, i) => (
          <span
            key={`r${i}`}
            className="tm-tick"
            style={{ background: "var(--border-strong)" }}
          />
        ))}
      </span>
      <span className="tm-count mono">{taskMeterLabel(done, total)}</span>
    </span>
  );
}

/** Colored status pill. */
function StatusPill({ status }: { status: string | null }): React.JSX.Element {
  if (status === null) {
    return <span className="tcell-none">—</span>;
  }
  const colors = statusColor(status);
  return (
    <span
      className={statusChip("status-pill")}
      style={{ background: colors.bg, color: colors.fg }}
    >
      <span
        className={statusChip("dot")}
        style={{ background: colors.dot }}
      />
      {statusPillLabel(status)}
    </span>
  );
}

// ---------------------------------------------------------------------------
// TableRow component
// ---------------------------------------------------------------------------

export interface TableRowProps {
  row: TableRowData;
  onToggle: (qid: string) => void;
  onOpen: (qid: string) => void;
  /** When true, adds the .loom-enter animation class (newly added via WS). */
  isNew?: boolean;
}

export default function TableRow({
  row,
  onToggle,
  onOpen,
  isNew,
}: TableRowProps): React.JSX.Element {
  const indent = row.depth * 20; // 20px per level

  const handleChevronClick = (e: React.MouseEvent): void => {
    e.stopPropagation();
    if (row.hasChildren) onToggle(row.qid);
  };

  const handleKeyDown = rowKeyDownHandler(row.qid, onOpen) as (e: React.KeyboardEvent) => void;

  // Progress cell content.
  let progressCell: React.ReactNode;
  if (row.type === "story" && row.taskTotal !== null && row.taskDone !== null) {
    progressCell = <TaskMeter done={row.taskDone} total={row.taskTotal} />;
  } else if (
    row.type === "epic" &&
    row.storyTotal !== null &&
    row.storyDone !== null
  ) {
    progressCell = (
      <StoryProgressBar done={row.storyDone} total={row.storyTotal} />
    );
  } else {
    progressCell = <span className="tcell-none">—</span>;
  }

  return (
    <tr
      className={enterClass(`trow trow-${row.type}`, isNew)}
      onClick={rowClickHandler(row.qid, onOpen)}
      onKeyDown={handleKeyDown}
      tabIndex={0}
      role="row"
      aria-expanded={row.hasChildren ? !row.isCollapsed : undefined}
    >
      {/* Name cell */}
      <td className="tcell-name" style={{ paddingLeft: indent + 8 }}>
        <div className="tcell-name-inner">
          <button
            className={`tw-chev bare${!row.hasChildren ? " leaf" : ""}`}
            onClick={handleChevronClick}
            tabIndex={-1}
            aria-hidden={!row.hasChildren}
          >
            {row.hasChildren ? (
              row.isCollapsed ? (
                <IconChevronRight />
              ) : (
                <IconChevronDown />
              )
            ) : null}
          </button>
          <span className="tw-ttext">{row.title}</span>
          <span className="tw-id mono">{row.qid}</span>
        </div>
      </td>

      {/* Progress cell */}
      <td className="tcell-progress">{progressCell}</td>

      {/* Status cell */}
      <td className="tcell-status">
        <StatusPill status={row.status} />
      </td>

      {/* Updated cell */}
      <td className="tcell-upd">
        <span className="tcell-upd-text">—</span>
      </td>
    </tr>
  );
}
