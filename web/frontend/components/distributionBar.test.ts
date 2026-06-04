import { describe, expect, test } from "bun:test";
import { distBarSegments } from "./distributionBarHelpers";

/**
 * Tests for the shared distBarSegments function.
 * DistributionBar is a React component; its rendering is covered by bun build.
 */

describe("distBarSegments (shared)", () => {
  test("returns one segment per non-empty status", () => {
    const cols: Record<string, unknown[]> = {
      ready: ["a"],
      done: ["b", "c"],
      blocked: [],
    };
    const segs = distBarSegments(cols);
    expect(segs.find((s) => s.status === "ready")?.count).toBe(1);
    expect(segs.find((s) => s.status === "done")?.count).toBe(2);
  });

  test("omits segments with count === 0", () => {
    const cols: Record<string, unknown[]> = {
      ready: [],
      done: ["x"],
    };
    const segs = distBarSegments(cols);
    expect(segs.every((s) => s.count > 0)).toBe(true);
    expect(segs).toHaveLength(1);
    expect(segs[0].status).toBe("done");
  });

  test("returns empty array when all status arrays are empty", () => {
    const cols: Record<string, unknown[]> = {
      ready: [],
      done: [],
    };
    expect(distBarSegments(cols)).toHaveLength(0);
  });

  test("handles custom statuses", () => {
    const cols: Record<string, unknown[]> = {
      "custom-status": ["a", "b"],
      done: ["c"],
    };
    const segs = distBarSegments(cols);
    expect(segs.find((s) => s.status === "custom-status")?.count).toBe(2);
    expect(segs.find((s) => s.status === "done")?.count).toBe(1);
  });
});
