/**
 * formatUpdated — formats an ISO-8601 timestamp for display in the Updated cell.
 *
 * Rules:
 *   - within the last minute: "just now"
 *   - within the last hour: "Xm ago"
 *   - within the last 2 days (inclusive): "Xh ago" or "Xd ago"
 *   - older than 2 days, same year as `now`: "Mon D" (e.g. "Jun 1")
 *   - older than 2 days, prior year: "Mon D YYYY" (e.g. "Dec 31 2023")
 *
 * @param isoString  ISO-8601 timestamp string (from the API).
 * @param now        Reference "now" date; defaults to `new Date()`.
 */
export function formatUpdated(isoString: string, now: Date = new Date()): string {
  const date = new Date(isoString);
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 60) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffMs <= 2 * 24 * 3600_000) {
    // Within 2 days (inclusive): show hours or days
    if (diffHour < 24) return `${diffHour}h ago`;
    return `${diffDay}d ago`;
  }

  // Older than 2 days — absolute date
  const month = date.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  const day = date.getUTCDate();
  const year = date.getUTCFullYear();

  if (year === now.getFullYear()) {
    return `${month} ${day}`;
  }
  return `${month} ${day} ${year}`;
}
