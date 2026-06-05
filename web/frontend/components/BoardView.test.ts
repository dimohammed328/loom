import { describe, expect, test } from "bun:test";
import { boardColumnHeaders, LANE_MIN_WIDTH } from "./BoardView";
import type { EpicRow, StoryCell } from "../boardModel";
import { BOARD_STATUSES } from "../boardModel";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCell(status: string): StoryCell {
  return { qid: "p:aaa23:1", title: "S", status, deps: [], taskNodes: [] };
}

function makeRow(stories: StoryCell[]): EpicRow {
  const cols: Record<string, StoryCell[]> = {};
  for (const s of BOARD_STATUSES) cols[s] = [];
  for (const s of stories) {
    const k = s.status ?? "ready";
    if (!(k in cols)) cols[k] = [];
    cols[k].push(s);
  }
  return { epicQid: "p:aaa23", epicTitle: "E", epicStatus: null, statusColumns: cols };
}

// ---------------------------------------------------------------------------
// boardColumnHeaders
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// LANE_MIN_WIDTH
// ---------------------------------------------------------------------------

describe("LANE_MIN_WIDTH", () => {
  test("is 160px so the board fits on screens >= ~900px wide", () => {
    expect(LANE_MIN_WIDTH).toBe(160);
  });
});

// ---------------------------------------------------------------------------
// boardColumnHeaders
// ---------------------------------------------------------------------------

describe("boardColumnHeaders", () => {
  test("returns one header entry per BOARD_STATUS in canonical order", () => {
    const rows: EpicRow[] = [];
    const headers = boardColumnHeaders(rows);
    expect(headers.map((h) => h.status)).toEqual([...BOARD_STATUSES]);
  });

  test("count reflects total stories across all rows for each status", () => {
    const rows = [
      makeRow([makeCell("ready"), makeCell("done"), makeCell("done")]),
      makeRow([makeCell("ready"), makeCell("blocked")]),
    ];
    const headers = boardColumnHeaders(rows);
    const byStatus = Object.fromEntries(headers.map((h) => [h.status, h.count]));
    expect(byStatus["ready"]).toBe(2);
    expect(byStatus["done"]).toBe(2);
    expect(byStatus["blocked"]).toBe(1);
    expect(byStatus["in progress"]).toBe(0);
  });

  test("returns zero counts when there are no rows", () => {
    const headers = boardColumnHeaders([]);
    expect(headers.every((h) => h.count === 0)).toBe(true);
  });

  test("does not include custom-status columns in the headers (only canonical)", () => {
    const rows = [makeRow([makeCell("custom")])];
    const headers = boardColumnHeaders(rows);
    expect(headers.map((h) => h.status)).toEqual([...BOARD_STATUSES]);
    expect(headers.find((h) => h.status === "custom")).toBeUndefined();
  });
});
