/**
 * distributionBar — shared status-distribution bar React component.
 *
 * Import `distBarSegments` from `./distributionBarHelpers` (plain .ts, testable
 * without JSX runtime) and `DistributionBar` from here for rendering.
 *
 * Used by:
 *  - EpicRowHeader (board view epic rows)
 *  - TableRow (table view epic rows)
 */

import React from "react";
import { statusColor } from "../status";
import type { DistBarSegment } from "./distributionBarHelpers";

export type { DistBarSegment } from "./distributionBarHelpers";
export { distBarSegments } from "./distributionBarHelpers";

// ---------------------------------------------------------------------------
// React component
// ---------------------------------------------------------------------------

export interface DistributionBarProps {
  segments: DistBarSegment[];
  title?: string;
}

/** Renders a horizontal status-distribution bar from pre-computed segments. */
export function DistributionBar({
  segments,
  title = "Status distribution",
}: DistributionBarProps): React.JSX.Element {
  return (
    <span className="dist-bar" title={title}>
      {segments.length === 0 ? (
        <span className="dist-empty" />
      ) : (
        segments.map(({ status, count }) => {
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
