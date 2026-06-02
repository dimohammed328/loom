/**
 * Status color mapping for Loom item statuses.
 *
 * Returns CSS custom-property references so the colours automatically
 * respond to the active theme/accent. An unknown status string falls back
 * to neutral tokens rather than throwing.
 */

export interface StatusColors {
  /** Dot/indicator colour (e.g. used in distribution bars). */
  dot: string;
  /** Foreground colour for text on the coloured surface. */
  fg: string;
  /** Background colour for pills / chips. */
  bg: string;
}

/** Known canonical statuses. */
const STATUS_MAP: Record<string, StatusColors> = {
  ready: {
    dot: "var(--st-ready-dot)",
    fg: "var(--st-ready-fg)",
    bg: "var(--st-ready-bg)",
  },
  "in progress": {
    dot: "var(--st-progress-dot)",
    fg: "var(--st-progress-fg)",
    bg: "var(--st-progress-bg)",
  },
  "in review": {
    dot: "var(--st-review-dot)",
    fg: "var(--st-review-fg)",
    bg: "var(--st-review-bg)",
  },
  blocked: {
    dot: "var(--st-blocked-dot)",
    fg: "var(--st-blocked-fg)",
    bg: "var(--st-blocked-bg)",
  },
  done: {
    dot: "var(--st-done-dot)",
    fg: "var(--st-done-fg)",
    bg: "var(--st-done-bg)",
  },
};

/** Neutral fallback used for unrecognised status strings. */
export const FALLBACK_COLORS: StatusColors = {
  dot: "var(--text-3)",
  fg: "var(--text-2)",
  bg: "var(--surface-2)",
};

/**
 * Return the CSS colour tokens for a given status string.
 *
 * Unrecognised strings (including null/undefined callers passing an
 * unknown custom status) receive the neutral fallback — they never throw.
 */
export function statusColor(status: string | null | undefined): StatusColors {
  if (status == null) return FALLBACK_COLORS;
  return STATUS_MAP[status.toLowerCase()] ?? FALLBACK_COLORS;
}

/** The set of status strings that have a dedicated palette entry. */
export const KNOWN_STATUSES = Object.keys(STATUS_MAP) as ReadonlyArray<string>;
