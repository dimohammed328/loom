import { describe, expect, test } from "bun:test";
import { formatUpdated } from "./formatUpdated";

/**
 * formatUpdated — relative-then-absolute time formatting:
 *   - within 2 days: relative ("just now", "5m ago", "3h ago", "1d ago")
 *   - beyond 2 days: absolute date ("Jun 1", "Dec 31 2023" if prior year)
 */

describe("formatUpdated", () => {
  const NOW = new Date("2024-06-15T12:00:00Z");

  test("returns 'just now' for timestamps within the last minute", () => {
    const ts = new Date(NOW.getTime() - 30_000).toISOString(); // 30s ago
    expect(formatUpdated(ts, NOW)).toBe("just now");
  });

  test("returns minutes ago for timestamps 1-59 minutes old", () => {
    const ts = new Date(NOW.getTime() - 5 * 60_000).toISOString(); // 5m ago
    expect(formatUpdated(ts, NOW)).toBe("5m ago");
  });

  test("returns hours ago for timestamps 1-47 hours old", () => {
    const ts = new Date(NOW.getTime() - 3 * 3600_000).toISOString(); // 3h ago
    expect(formatUpdated(ts, NOW)).toBe("3h ago");
  });

  test("returns '1d ago' for timestamps ~24 hours old", () => {
    const ts = new Date(NOW.getTime() - 24 * 3600_000).toISOString();
    expect(formatUpdated(ts, NOW)).toBe("1d ago");
  });

  test("returns absolute date for timestamps older than 2 days (same year)", () => {
    const ts = new Date("2024-06-01T10:00:00Z").toISOString();
    expect(formatUpdated(ts, NOW)).toBe("Jun 1");
  });

  test("returns absolute date with year for timestamps in a prior year", () => {
    const ts = new Date("2023-12-31T10:00:00Z").toISOString();
    expect(formatUpdated(ts, NOW)).toBe("Dec 31 2023");
  });

  test("boundary: exactly 2 days ago uses relative", () => {
    const ts = new Date(NOW.getTime() - 2 * 24 * 3600_000).toISOString();
    expect(formatUpdated(ts, NOW)).toBe("2d ago");
  });

  test("boundary: just over 2 days uses absolute date", () => {
    const ts = new Date(NOW.getTime() - 2 * 24 * 3600_000 - 1).toISOString();
    expect(formatUpdated(ts, NOW)).toBe("Jun 13");
  });
});
