import { describe, expect, test } from "bun:test";
import { buildCollapseAll, toggleCollapse, allCollapsed } from "./tableViewHelpers";
import type { TableRow } from "../tableModel";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRow(
  qid: string,
  hasChildren: boolean,
  isCollapsed = false,
): TableRow {
  return {
    qid,
    type: "epic",
    title: "T",
    status: null,
    depth: 0,
    hasChildren,
    isCollapsed,
    taskDone: null,
    taskTotal: null,
    storyDone: null,
    storyTotal: null,
  };
}

// ---------------------------------------------------------------------------
// buildCollapseAll
// ---------------------------------------------------------------------------

describe("buildCollapseAll", () => {
  test("marks all rows with hasChildren=true as collapsed=true", () => {
    const rows = [makeRow("a", true), makeRow("b", false), makeRow("c", true)];
    const state = buildCollapseAll(rows, true);
    expect(state["a"]).toBe(true);
    expect(state["c"]).toBe(true);
    expect("b" in state).toBe(false);
  });

  test("marks all collapsible rows as expanded when collapsed=false", () => {
    const rows = [makeRow("a", true), makeRow("b", true)];
    const state = buildCollapseAll(rows, false);
    expect(state["a"]).toBe(false);
    expect(state["b"]).toBe(false);
  });

  test("returns empty object when no rows have children", () => {
    const rows = [makeRow("a", false), makeRow("b", false)];
    const state = buildCollapseAll(rows, true);
    expect(Object.keys(state)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// toggleCollapse
// ---------------------------------------------------------------------------

describe("toggleCollapse", () => {
  test("sets true when previously false", () => {
    const result = toggleCollapse({ a: false }, "a");
    expect(result["a"]).toBe(true);
  });

  test("sets false when previously true", () => {
    const result = toggleCollapse({ a: true }, "a");
    expect(result["a"]).toBe(false);
  });

  test("sets true for an unknown qid (undefined → !undefined = true)", () => {
    const result = toggleCollapse({}, "x");
    expect(result["x"]).toBe(true);
  });

  test("does not mutate the original object", () => {
    const prev = { a: true };
    const next = toggleCollapse(prev, "a");
    expect(prev["a"]).toBe(true);
    expect(next["a"]).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// allCollapsed
// ---------------------------------------------------------------------------

describe("allCollapsed", () => {
  test("returns true when every collapsible row is collapsed", () => {
    const rows = [
      makeRow("a", true, true),
      makeRow("b", false, false), // leaf — ignored
      makeRow("c", true, true),
    ];
    expect(allCollapsed(rows)).toBe(true);
  });

  test("returns false when at least one collapsible row is expanded", () => {
    const rows = [makeRow("a", true, true), makeRow("b", true, false)];
    expect(allCollapsed(rows)).toBe(false);
  });

  test("returns false for an empty list", () => {
    expect(allCollapsed([])).toBe(false);
  });

  test("returns false when no rows have children (nothing to collapse)", () => {
    const rows = [makeRow("a", false), makeRow("b", false)];
    expect(allCollapsed(rows)).toBe(false);
  });
});
