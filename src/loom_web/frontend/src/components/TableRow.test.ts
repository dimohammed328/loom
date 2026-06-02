import { describe, expect, test } from "bun:test";
import { taskMeterLabel, progressBarSegments, statusPillLabel } from "./tableRowHelpers";

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
