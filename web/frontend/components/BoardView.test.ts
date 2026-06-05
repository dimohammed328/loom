import { describe, expect, test } from "bun:test";
import { boardColumnHeaders, LANE_MIN_WIDTH, LANE_STORY_CAP, buildGridTemplate, visibleCells } from "./BoardView";
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
// LANE_MIN_WIDTH
// ---------------------------------------------------------------------------

describe("LANE_MIN_WIDTH", () => {
  test("is 160px so the board fits on screens >= ~900px wide", () => {
    expect(LANE_MIN_WIDTH).toBe(160);
  });
});

// ---------------------------------------------------------------------------
// buildGridTemplate — floor-then-scroll contract
// ---------------------------------------------------------------------------

describe("buildGridTemplate", () => {
  test("uses LANE_MIN_WIDTH as floor (not 244px) in grid template", () => {
    const tpl = buildGridTemplate(4);
    expect(tpl).toContain(`minmax(${LANE_MIN_WIDTH}px, 1fr)`);
    expect(tpl).not.toContain("244px");
  });

  test("repeats the lane track for every column count passed", () => {
    const tpl = buildGridTemplate(4);
    expect(tpl).toBe(
      `var(--epic-col) repeat(4, minmax(${LANE_MIN_WIDTH}px, 1fr))`
    );
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

// ---------------------------------------------------------------------------
// LANE_STORY_CAP
// ---------------------------------------------------------------------------

describe('LANE_STORY_CAP', () => {
  test('is 5', () => {
    expect(LANE_STORY_CAP).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// visibleCells
// ---------------------------------------------------------------------------

describe('visibleCells', () => {
  const cells: StoryCell[] = Array.from({ length: 8 }, (_, i) => ({
    qid: `p:aaa23:${i + 1}`,
    title: `Story ${i + 1}`,
    status: 'ready',
    deps: [],
    taskNodes: [],
  }));

  test('returns all cells when expanded', () => {
    expect(visibleCells(cells, true)).toHaveLength(8);
    expect(visibleCells(cells, true)).toEqual(cells);
  });

  test('returns at most LANE_STORY_CAP cells when collapsed', () => {
    const result = visibleCells(cells, false);
    expect(result).toHaveLength(LANE_STORY_CAP);
    expect(result).toEqual(cells.slice(0, LANE_STORY_CAP));
  });

  test('returns all cells when collapsed but count <= cap', () => {
    const few = cells.slice(0, 3);
    expect(visibleCells(few, false)).toHaveLength(3);
    expect(visibleCells(few, false)).toEqual(few);
  });

  test('returns all cells when expanded and count <= cap', () => {
    const few = cells.slice(0, 5);
    expect(visibleCells(few, true)).toHaveLength(5);
    expect(visibleCells(few, true)).toEqual(few);
  });

  test('returns all cells when expanded and count > cap', () => {
    expect(visibleCells(cells, true)).toEqual(cells);
  });
});
