import { describe, expect, test } from "bun:test";
import { taskMeterLabel, progressBarSegments, statusPillLabel } from "./tableRowHelpers";
import { formatUpdated } from "../formatUpdated";

// ---------------------------------------------------------------------------
// taskMeterLabel
// ---------------------------------------------------------------------------

describe("taskMeterLabel", () => {
  test("formats done/total as string", () => {
    expect(taskMeterLabel(2, 5)).toBe("2/5");
  });

  test("handles zero tasks", () => {
    expect(taskMeterLabel(0, 0)).toBe("0/0");
  });

  test("all done", () => {
    expect(taskMeterLabel(3, 3)).toBe("3/3");
  });
});

// ---------------------------------------------------------------------------
// progressBarSegments — for epic-level story progress
// ---------------------------------------------------------------------------

describe("progressBarSegments", () => {
  test("returns done and remaining segments that sum to total", () => {
    const segs = progressBarSegments(2, 5);
    expect(segs.done).toBe(2);
    expect(segs.remaining).toBe(3);
  });

  test("all done yields remaining=0", () => {
    const segs = progressBarSegments(4, 4);
    expect(segs.done).toBe(4);
    expect(segs.remaining).toBe(0);
  });

  test("none done yields done=0", () => {
    const segs = progressBarSegments(0, 3);
    expect(segs.done).toBe(0);
    expect(segs.remaining).toBe(3);
  });

  test("zero total yields zeros", () => {
    const segs = progressBarSegments(0, 0);
    expect(segs.done).toBe(0);
    expect(segs.remaining).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// statusPillLabel
// ---------------------------------------------------------------------------

describe("statusPillLabel", () => {
  test("formats canonical statuses with title-casing", () => {
    expect(statusPillLabel("ready")).toBe("Ready");
    expect(statusPillLabel("in progress")).toBe("In Progress");
    expect(statusPillLabel("blocked")).toBe("Blocked");
    expect(statusPillLabel("done")).toBe("Done");
  });

  test("returns em-dash for null status", () => {
    expect(statusPillLabel(null)).toBe("—");
  });

  test("capitalizes first letter of unknown statuses", () => {
    expect(statusPillLabel("custom-status")).toBe("Custom-status");
  });
});

// ---------------------------------------------------------------------------
// formatUpdated integration — verifies the util used in TableRow's Updated cell
// ---------------------------------------------------------------------------

describe("formatUpdated (used by TableRow Updated cell)", () => {
  test("recent timestamp produces relative label", () => {
    const now = new Date("2024-06-15T12:00:00Z");
    const ts = new Date(now.getTime() - 10 * 60_000).toISOString(); // 10m ago
    expect(formatUpdated(ts, now)).toBe("10m ago");
  });

  test("old timestamp produces absolute date label", () => {
    const now = new Date("2024-06-15T12:00:00Z");
    const ts = new Date("2024-01-10T08:00:00Z").toISOString();
    expect(formatUpdated(ts, now)).toBe("Jan 10");
  });
});
