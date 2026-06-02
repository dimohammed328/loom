/**
 * EpicRowHeader — sticky-left cell in the board grid for one epic row.
 *
 * Shows:
 *  - Collapse chevron + epic title (title click opens modal)
 *  - Qid chip
 *  - Status-distribution bar
 *  - "done/total complete · N blocked" meta line
 *  - Review badge ("In review" / "Accepted") when applicable
 */

import React from "react";
import type { EpicRow } from "../boardModel";
import { epicProgress } from "../progress";
import { statusColor } from "../status";

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

export interface ReviewBadge {
  kind: "in_review" | "accepted";
  label: string;
}

/**
 * Derive the review badge descriptor from an epic's status string.
 * Returns null when no badge should be shown (active / normal statuses).
 */
export function epicReviewBadge(epicStatus: string | null | undefined): ReviewBadge | null {
  if (epicStatus === "in review") return { kind: "in_review", label: "In review" };
  if (epicStatus === "accepted") return { kind: "accepted", label: "Accepted" };
  return null;
}

export interface DistBarSegment {
  status: string;
  count: number;
}

/**
 * Build the list of distribution-bar segments from an EpicRow.
 * Only segments with count > 0 are included.
 */
export function distBarSegments(row: EpicRow): DistBarSegment[] {
  const counts = new Map<string, number>();
  for (const [status, cells] of Object.entries(row.statusColumns)) {
    if (cells.length > 0) {
      counts.set(status, (counts.get(status) ?? 0) + cells.length);
    }
  }
  return Array.from(counts.entries())
    .filter(([, count]) => count > 0)
    .map(([status, count]) => ({ status, count }));
}

// ---------------------------------------------------------------------------
// Inline SVG icons
// ---------------------------------------------------------------------------

function IconChevronDown({ rotated }: { rotated?: boolean }): React.JSX.Element {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      style={{ transform: rotated ? "rotate(-90deg)" : undefined, transition: "transform .12s" }}
    >
      <path
        d="M6 9l6 6 6-6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconReview(): React.JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="10.5" cy="10.5" r="6.5" stroke="currentColor" strokeWidth="1.9" />
      <path d="M15.5 15.5L20 20" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
      <path
        d="M8 10.5l1.8 1.8L13.5 9"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconAccepted(): React.JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 2.5l2.4 1.7 2.9-.2 1 2.7 2.4 1.6-.7 2.9.7 2.9-2.4 1.6-1 2.7-2.9-.2L12 21.5l-2.4-1.7-2.9.2-1-2.7L3.3 15.7l.7-2.9-.7-2.9 2.4-1.6 1-2.7 2.9.2L12 2.5z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path
        d="M8.5 12l2.3 2.3L15.5 9.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconHash(): React.JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M10 4.2L8 19.8M16 4.2L14 19.8M4.8 9H19.6M4.4 15H19.2"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function QidChip({ id }: { id: string }): React.JSX.Element {
  return (
    <span className="qid">
      <span className="qid-hash">
        <IconHash />
      </span>
      <span className="qid-text mono">{id}</span>
    </span>
  );
}

function DistributionBar({ row }: { row: EpicRow }): React.JSX.Element {
  const segs = distBarSegments(row);
  return (
    <span className="dist-bar" title="Status distribution">
      {segs.length === 0 ? (
        <span className="dist-empty" />
      ) : (
        segs.map(({ status, count }) => {
          const colors = statusColor(status);
          return (
            <span
              key={status}
              className="dist-seg"
              style={{ flexGrow: count, background: colors.dot }}
              title={`${count} ${status}`}
            />
          );
        })
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// EpicRowHeader
// ---------------------------------------------------------------------------

export interface EpicRowHeaderProps {
  row: EpicRow;
  collapsed: boolean;
  onToggle: () => void;
  onOpenEpic: (qid: string) => void;
}

export default function EpicRowHeader({
  row,
  collapsed,
  onToggle,
  onOpenEpic,
}: EpicRowHeaderProps): React.JSX.Element {
  const { total, done, blocked } = epicProgress(row);
  const badge = epicReviewBadge(row.epicStatus);

  return (
    <div
      className={`epic-rowhead${collapsed ? " collapsed" : ""}`}
      onClick={onToggle}
      role="button"
      aria-expanded={!collapsed}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onToggle();
        }
      }}
    >
      {/* Title row */}
      <div className="erh-top">
        <span className="erh-chev">
          <IconChevronDown rotated={collapsed} />
        </span>
        <span
          className="erh-title"
          onClick={(e) => {
            e.stopPropagation();
            onOpenEpic(row.epicQid);
          }}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.stopPropagation();
              onOpenEpic(row.epicQid);
            }
          }}
        >
          {row.epicTitle}
        </span>
      </div>

      {/* Qid */}
      <div className="erh-id">
        <QidChip id={row.epicQid} />
      </div>

      {/* Distribution bar */}
      <DistributionBar row={row} />

      {/* Meta line */}
      <div className="erh-meta">
        <strong>
          {done}/{total}
        </strong>{" "}
        complete
        {blocked > 0 && (
          <>
            {" "}
            <span className="erh-dot">·</span>{" "}
            <span className="erh-blocked">{blocked} blocked</span>
          </>
        )}
      </div>

      {/* Review badge */}
      {badge?.kind === "in_review" && (
        <span className="erv-chip erv-c-inreview erh-rev">
          <IconReview /> {badge.label}
        </span>
      )}
      {badge?.kind === "accepted" && (
        <span className="erv-chip erv-c-done erh-rev">
          <IconAccepted /> {badge.label}
        </span>
      )}
    </div>
  );
}
