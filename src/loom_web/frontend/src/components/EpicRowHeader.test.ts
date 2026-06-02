import { describe, expect, test } from "bun:test";
import { epicReviewBadge, distBarSegments } from "./EpicRowHeader";
import type { EpicRow, StoryCell } from "../boardModel";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCell(status: string): StoryCell {
  return { qid: "p:aaa23:1", title: "S", status, deps: [], taskNodes: [] };
}

function makeRow(epicStatus: string | null, stories: StoryCell[]): EpicRow {
  const cols: Record<string, StoryCell[]> = {
    ready: [],
    "in progress": [],
    blocked: [],
    done: [],
  };
  for (const s of stories) {
    const k = s.status ?? "ready";
    if (!(k in cols)) cols[k] = [];
    cols[k].push(s);
  }
  return {
    epicQid: "p:aaa23",
    epicTitle: "E",
    epicStatus,
    statusColumns: cols,
  };
}

// ---------------------------------------------------------------------------
// epicReviewBadge
// ---------------------------------------------------------------------------

describe("epicReviewBadge", () => {
  test("returns null when epicStatus is not review-related", () => {
    expect(epicReviewBadge(null)).toBeNull();
    expect(epicReviewBadge("in progress")).toBeNull();
    expect(epicReviewBadge("ready")).toBeNull();
    expect(epicReviewBadge("done")).toBeNull();
  });

  test("returns 'in_review' badge descriptor for 'in review' status", () => {
    const badge = epicReviewBadge("in review");
    expect(badge).not.toBeNull();
    expect(badge!.kind).toBe("in_review");
    expect(badge!.label).toBe("In review");
  });

  test("returns 'accepted' badge descriptor for 'accepted' status", () => {
    const badge = epicReviewBadge("accepted");
    expect(badge).not.toBeNull();
    expect(badge!.kind).toBe("accepted");
    expect(badge!.label).toBe("Accepted");
  });
});

// ---------------------------------------------------------------------------
// distBarSegments
// ---------------------------------------------------------------------------

describe("distBarSegments", () => {
  test("returns one segment per non-empty status with correct flex-grow weight", () => {
    const row = makeRow(null, [
      makeCell("done"),
      makeCell("done"),
      makeCell("ready"),
    ]);
    const segs = distBarSegments(row);
    const readySeg = segs.find((s) => s.status === "ready");
    const doneSeg = segs.find((s) => s.status === "done");
    expect(readySeg).toBeDefined();
    expect(readySeg!.count).toBe(1);
    expect(doneSeg).toBeDefined();
    expect(doneSeg!.count).toBe(2);
  });

  test("omits segments with count === 0", () => {
    const row = makeRow(null, [makeCell("done")]);
    const segs = distBarSegments(row);
    expect(segs.every((s) => s.count > 0)).toBe(true);
  });

  test("returns empty array when there are no stories", () => {
    const row = makeRow(null, []);
    expect(distBarSegments(row)).toHaveLength(0);
  });

  test("includes custom-status segments", () => {
    const row = makeRow(null, [makeCell("custom"), makeCell("done")]);
    const segs = distBarSegments(row);
    expect(segs.find((s) => s.status === "custom")).toBeDefined();
    expect(segs.find((s) => s.status === "done")).toBeDefined();
  });
});
