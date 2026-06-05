/**
 * BoardView — CSS-grid Kanban matrix.
 *
 * Layout:
 *   grid-template-columns: var(--epic-col) repeat(N, minmax(160px, 1fr))
 *   - Column 0: sticky-left epic row-headers
 *   - Columns 1…N: one story-card column per status
 *
 * Each row renders:
 *   - EpicRowHeader (sticky left)
 *   - One kcol per status column containing StoryCards
 *
 * The component owns the collapse map and fetches tree data from the API.
 */

import React, { useEffect, useState, useCallback } from "react";
import { getProjectTree } from "../api/client";
import type { ProjectSummary } from "../api/client";
import { boardModel, BOARD_STATUSES } from "../boardModel";
import type { EpicRow, StoryCell } from "../boardModel";
import { statusColor } from "../status";
import EpicRowHeader from "./EpicRowHeader";
import StoryCard from "./StoryCard";

// ---------------------------------------------------------------------------
// Layout constants (exported for tests)
// ---------------------------------------------------------------------------

/** Minimum width per status lane. Lowered from 244px so the board fits on
 *  screens >= ~900px wide without horizontal scroll. */
export const LANE_MIN_WIDTH = 160;

/** Maximum number of story cards shown per status lane before the expander is shown. */
export const LANE_STORY_CAP = 5;

/** Build the CSS grid-template-columns value for the board.
 *  Exported for tests so the floor-then-scroll contract is verifiable. */
export function buildGridTemplate(laneCount: number): string {
  return `var(--epic-col) repeat(${laneCount}, minmax(${LANE_MIN_WIDTH}px, 1fr))`;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

export interface ColumnHeader {
  status: string;
  count: number;
}

/**
 * Return the subset of cells to show in a lane.
 * When expanded, all cells are returned. When collapsed, only the first
 * LANE_STORY_CAP cells are returned (a no-op when the lane has <= cap cards).
 */
export function visibleCells(cells: StoryCell[], expanded: boolean): StoryCell[] {
  return expanded ? cells : cells.slice(0, LANE_STORY_CAP);
}

/**
 * Build the top-row column headers from a set of epic rows.
 * Only the canonical BOARD_STATUSES are included; custom statuses are
 * bucketed into the standard columns and ignored in headers.
 */
export function boardColumnHeaders(rows: EpicRow[]): ColumnHeader[] {
  const counts = new Map<string, number>();
  for (const s of BOARD_STATUSES) counts.set(s, 0);

  for (const row of rows) {
    for (const s of BOARD_STATUSES) {
      const cells = row.statusColumns[s] ?? [];
      counts.set(s, (counts.get(s) ?? 0) + cells.length);
    }
  }

  return BOARD_STATUSES.map((s) => ({ status: s, count: counts.get(s) ?? 0 }));
}

// ---------------------------------------------------------------------------
// Inline SVG
// ---------------------------------------------------------------------------

function StatusGlyph({ status }: { status: string }): React.JSX.Element {
  const color = statusColor(status).dot;
  const common = { width: 17, height: 17, viewBox: "0 0 24 24", fill: "none" as const };
  const box = (
    <rect x="3.5" y="3.5" width="17" height="17" rx="4.5" stroke={color} strokeWidth="2" />
  );

  if (status === "done") {
    return (
      <svg {...common} aria-hidden>
        <rect x="3" y="3" width="18" height="18" rx="5" fill={color} />
        <path
          d="M7.5 12.5l3 3 6-6.5"
          stroke="#fff"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (status === "blocked") {
    return (
      <svg {...common} aria-hidden>
        {box}
        <path d="M8 8l8 8" stroke={color} strokeWidth="2" strokeLinecap="round" />
      </svg>
    );
  }
  if (status === "in progress") {
    return (
      <svg {...common} aria-hidden>
        {box}
        <path
          d="M3.5 12a8.5 8.5 0 008.5 8.5V3.5A8.5 8.5 0 003.5 12z"
          fill={color}
          opacity="0.9"
        />
      </svg>
    );
  }
  // ready — empty box
  return (
    <svg {...common} aria-hidden>
      {box}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// STATUS_LABEL mapping
// ---------------------------------------------------------------------------

const STATUS_LABEL: Record<string, string> = {
  ready: "Ready",
  "in progress": "In Progress",
  blocked: "Blocked",
  done: "Done",
};

// ---------------------------------------------------------------------------
// BoardView
// ---------------------------------------------------------------------------

export interface BoardViewProps {
  project: ProjectSummary;
  onOpen: (qid: string) => void;
}

export default function BoardView({ project, onOpen }: BoardViewProps): React.JSX.Element {
  const [rows, setRows] = useState<EpicRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [expandedLanes, setExpandedLanes] = useState<Record<string, boolean>>({});

  // Fetch tree data when project changes.
  useEffect(() => {
    setLoading(true);
    setError(null);
    setCollapsed({});
    setExpandedLanes({});
    getProjectTree(project.qid)
      .then((tree) => {
        setRows(boardModel(tree));
        setLoading(false);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
  }, [project.qid]);

  const toggleCollapse = useCallback((epicQid: string) => {
    setCollapsed((prev) => ({ ...prev, [epicQid]: !prev[epicQid] }));
  }, []);

  const toggleLane = useCallback((epicQid: string, status: string) => {
    const key = `${epicQid}:${status}`;
    setExpandedLanes((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  if (loading) {
    return (
      <div className="view-scroll" style={{ display: "grid", placeItems: "center", minHeight: 200 }}>
        <span style={{ color: "var(--text-3)", fontSize: 13 }}>Loading…</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="view-scroll" style={{ display: "grid", placeItems: "center", minHeight: 200 }}>
        <span style={{ color: "var(--st-blocked-fg)", fontSize: 13 }}>{error}</span>
      </div>
    );
  }

  const headers = boardColumnHeaders(rows);
  const gridCols = buildGridTemplate(BOARD_STATUSES.length);

  return (
    <div className="view-scroll">
      <div
        className="board-grid"
        style={{ gridTemplateColumns: gridCols }}
        role="grid"
        aria-label="Board"
      >
        {/* ---- Header row ---- */}
        <div className="board-corner">
          <span className="bc-label">Epics</span>
          <span className="bc-count">{rows.length}</span>
        </div>

        {headers.map(({ status, count }) => {
          const colors = statusColor(status);
          return (
            <div className="colhead" key={status} role="columnheader">
              <span className="colhead-glyph">
                <StatusGlyph status={status} />
              </span>
              <span className="colhead-label" style={{ color: colors.fg }}>
                {STATUS_LABEL[status] ?? status}
              </span>
              <span className="cnt" style={{ color: "var(--text-3)" }}>
                {count}
              </span>
            </div>
          );
        })}

        {/* 16px gap between header row and first epic */}
        <div className="board-headgap" style={{ gridColumn: `span ${BOARD_STATUSES.length + 1}` }} />

        {/* ---- Epic rows ---- */}
        {rows.map((row, ei) => {
          const isCollapsed = !!collapsed[row.epicQid];

          return (
            <React.Fragment key={row.epicQid}>
              {/* Separator between epics */}
              {ei > 0 && (
                <div
                  className="epic-sep"
                  style={{ gridColumn: `span ${BOARD_STATUSES.length + 1}` }}
                />
              )}

              {/* Sticky-left epic row header */}
              <EpicRowHeader
                row={row}
                collapsed={isCollapsed}
                onToggle={() => toggleCollapse(row.epicQid)}
                onOpenEpic={onOpen}
              />

              {/* Story cells — one per status column */}
              {isCollapsed ? (
                <div
                  className="row-collapsed"
                  style={{ gridColumn: `span ${BOARD_STATUSES.length}` }}
                >
                  {`${Object.values(row.statusColumns).flat().length} ${
                    Object.values(row.statusColumns).flat().length === 1 ? "story" : "stories"
                  } hidden`}
                </div>
              ) : (
                BOARD_STATUSES.map((status) => {
                  const cells: StoryCell[] = row.statusColumns[status] ?? [];
                  const laneKey = `${row.epicQid}:${status}`;
                  const isLaneExpanded = !!expandedLanes[laneKey];
                  const shown = visibleCells(cells, isLaneExpanded);
                  const hiddenCount = cells.length - shown.length;
                  return (
                    <div className="kcol" key={status} role="group" aria-label={status}>
                      {shown.map((story) => (
                        <StoryCard
                          key={story.qid}
                          story={story}
                          onOpen={onOpen}
                        />
                      ))}
                      {hiddenCount > 0 && (
                        <button
                          className="lane-expander"
                          onClick={() => toggleLane(row.epicQid, status)}
                          aria-expanded={isLaneExpanded}
                        >
                          <span className="lane-expander-chev">
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden>
                              <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          </span>
                          Show {hiddenCount} more
                        </button>
                      )}
                      {isLaneExpanded && cells.length > LANE_STORY_CAP && (
                        <button
                          className="lane-expander lane-expander--collapse"
                          onClick={() => toggleLane(row.epicQid, status)}
                          aria-expanded={isLaneExpanded}
                        >
                          <span className="lane-expander-chev lane-expander-chev--up">
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden>
                              <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          </span>
                          Show less
                        </button>
                      )}
                    </div>
                  );
                })
              )}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}
