/**
 * distributionBarHelpers — pure helpers for the DistributionBar component.
 *
 * Kept in a plain .ts file so they can be unit-tested without needing the
 * JSX dev runtime (same pattern as tableRowHelpers.ts).
 */

export interface DistBarSegment {
  status: string;
  count: number;
}

/**
 * Build the list of distribution-bar segments from a statusColumns map.
 * Only segments with count > 0 are included.
 *
 * @param statusColumns  Map from status string to an array of any items.
 */
export function distBarSegments(
  statusColumns: Record<string, unknown[]>,
): DistBarSegment[] {
  return Object.entries(statusColumns)
    .filter(([, items]) => items.length > 0)
    .map(([status, items]) => ({ status, count: items.length }));
}
