/**
 * Tests for the epicSort shared helper.
 *
 * Covers the sorting of top-level epic qids by created_at descending,
 * including edge cases (missing created_at, ties, empty input).
 */

import { describe, test, expect } from "bun:test";
import type { ItemNode } from "./api/client";
import { sortEpicsNewestFirst } from "./epicSort";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEpic(qid: string, created_at?: string): ItemNode {
  return {
    qid,
    type: "epic",
    title: qid,
    status: null,
    assignee: null,
    branch: null,
    pr_url: null,
    deps: [],
    children: [],
    created_at,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("sortEpicsNewestFirst", () => {
  test("returns empty array for empty input", () => {
    const byQid = new Map<string, ItemNode>();
    const result = sortEpicsNewestFirst([], byQid);
    expect(result).toEqual([]);
  });

  test("single epic is returned unchanged", () => {
    const e1 = makeEpic("p:aaa23", "2024-01-01T00:00:00Z");
    const byQid = new Map([["p:aaa23", e1]]);
    const result = sortEpicsNewestFirst(["p:aaa23"], byQid);
    expect(result).toEqual(["p:aaa23"]);
  });

  test("newer epic sorts before older epic", () => {
    const e1 = makeEpic("p:aaa23", "2024-01-01T00:00:00Z"); // older
    const e2 = makeEpic("p:bbb23", "2024-06-01T00:00:00Z"); // newer
    const byQid = new Map([["p:aaa23", e1], ["p:bbb23", e2]]);
    // Input order: [older, newer]
    const result = sortEpicsNewestFirst(["p:aaa23", "p:bbb23"], byQid);
    // Result: [newer, older]
    expect(result).toEqual(["p:bbb23", "p:aaa23"]);
  });

  test("already-sorted input (newest first) remains unchanged", () => {
    const e1 = makeEpic("p:aaa23", "2024-06-01T00:00:00Z"); // newer
    const e2 = makeEpic("p:bbb23", "2024-01-01T00:00:00Z"); // older
    const byQid = new Map([["p:aaa23", e1], ["p:bbb23", e2]]);
    const result = sortEpicsNewestFirst(["p:aaa23", "p:bbb23"], byQid);
    expect(result).toEqual(["p:aaa23", "p:bbb23"]);
  });

  test("epics missing created_at sort after those with it", () => {
    const e1 = makeEpic("p:aaa23"); // no created_at
    const e2 = makeEpic("p:bbb23", "2024-01-01T00:00:00Z"); // has created_at
    const byQid = new Map([["p:aaa23", e1], ["p:bbb23", e2]]);
    const result = sortEpicsNewestFirst(["p:aaa23", "p:bbb23"], byQid);
    // e2 (has timestamp) sorts before e1 (no timestamp)
    expect(result).toEqual(["p:bbb23", "p:aaa23"]);
  });

  test("epics with equal created_at retain their original relative order", () => {
    const ts = "2024-01-01T00:00:00Z";
    const e1 = makeEpic("p:aaa23", ts);
    const e2 = makeEpic("p:bbb23", ts);
    const byQid = new Map([["p:aaa23", e1], ["p:bbb23", e2]]);
    const result = sortEpicsNewestFirst(["p:aaa23", "p:bbb23"], byQid);
    // Both have same timestamp; original order preserved (stable sort)
    expect(result).toEqual(["p:aaa23", "p:bbb23"]);
  });

  test("does not mutate the input array", () => {
    const e1 = makeEpic("p:aaa23", "2024-01-01T00:00:00Z");
    const e2 = makeEpic("p:bbb23", "2024-06-01T00:00:00Z");
    const byQid = new Map([["p:aaa23", e1], ["p:bbb23", e2]]);
    const input = ["p:aaa23", "p:bbb23"];
    sortEpicsNewestFirst(input, byQid);
    // Input should be unchanged
    expect(input).toEqual(["p:aaa23", "p:bbb23"]);
  });
});
