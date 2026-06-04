/**
 * Tests for the items store reducer.
 *
 * The reducer manages a Record<string, ItemNode> keyed by qid.
 * - setItems: replace the whole map (fresh tree load).
 * - applyWsPayload: replace or remove a single item by qid.
 */

import { describe, expect, test } from "bun:test";
import { setItems, applyWsPayload } from "./itemsReducer";
import type { ItemNode } from "../api/client";
import type { WsPayload } from "../ws/client";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeItem(overrides: Partial<ItemNode> & { qid: string }): ItemNode {
  return {
    type: "task",
    title: "A task",
    status: "ready",
    assignee: null,
    branch: null,
    pr_url: null,
    deps: [],
    children: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// setItems
// ---------------------------------------------------------------------------

describe("setItems", () => {
  test("builds a Record keyed by qid from an array", () => {
    const items = [
      makeItem({ qid: "p:abc23:1" }),
      makeItem({ qid: "p:abc23:2", title: "Another" }),
    ];
    const state = setItems(items);
    expect(Object.keys(state)).toHaveLength(2);
    expect(state["p:abc23:1"].title).toBe("A task");
    expect(state["p:abc23:2"].title).toBe("Another");
  });

  test("later items overwrite earlier duplicates", () => {
    const a = makeItem({ qid: "p:abc23:1", title: "first" });
    const b = makeItem({ qid: "p:abc23:1", title: "second" });
    const state = setItems([a, b]);
    expect(state["p:abc23:1"].title).toBe("second");
  });

  test("empty array produces empty map", () => {
    expect(setItems([])).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// applyWsPayload — update
// ---------------------------------------------------------------------------

describe("applyWsPayload — update", () => {
  test("replaces an existing item by qid", () => {
    const initial = setItems([makeItem({ qid: "p:abc23:1", status: "ready" })]);
    const payload: WsPayload = {
      qid: "p:abc23:1",
      type: "task",
      title: "A task",
      status: "done",
      assignee: null,
      branch: null,
      pr_url: null,
      tags: [],
      archived: false,
    };
    const next = applyWsPayload(initial, payload);
    expect(next["p:abc23:1"].status).toBe("done");
  });

  test("adds a new item when qid not yet in store", () => {
    const initial = setItems([makeItem({ qid: "p:abc23:1" })]);
    const payload: WsPayload = {
      qid: "p:abc23:2",
      type: "task",
      title: "New task",
      status: "ready",
      assignee: null,
      branch: null,
      pr_url: null,
      tags: [],
      archived: false,
    };
    const next = applyWsPayload(initial, payload);
    expect(Object.keys(next)).toHaveLength(2);
    expect(next["p:abc23:2"].title).toBe("New task");
  });

  test("does not mutate the previous state object", () => {
    const initial = setItems([makeItem({ qid: "p:abc23:1", status: "ready" })]);
    const payload: WsPayload = {
      qid: "p:abc23:1",
      type: "task",
      title: "A task",
      status: "done",
      assignee: null,
      branch: null,
      pr_url: null,
      tags: [],
      archived: false,
    };
    const next = applyWsPayload(initial, payload);
    // Original must be unmodified.
    expect(initial["p:abc23:1"].status).toBe("ready");
    expect(next).not.toBe(initial);
  });
});

// ---------------------------------------------------------------------------
// applyWsPayload — tombstone
// ---------------------------------------------------------------------------

describe("applyWsPayload — tombstone", () => {
  test("removes an item when payload carries deleted:true", () => {
    const initial = setItems([
      makeItem({ qid: "p:abc23:1" }),
      makeItem({ qid: "p:abc23:2" }),
    ]);
    const tombstone: WsPayload = { qid: "p:abc23:1", deleted: true };
    const next = applyWsPayload(initial, tombstone);
    expect(next["p:abc23:1"]).toBeUndefined();
    expect(next["p:abc23:2"]).toBeDefined();
  });

  test("tombstone for unknown qid is a no-op", () => {
    const initial = setItems([makeItem({ qid: "p:abc23:1" })]);
    const tombstone: WsPayload = { qid: "p:xyz99:9", deleted: true };
    const next = applyWsPayload(initial, tombstone);
    expect(Object.keys(next)).toHaveLength(1);
    expect(next["p:abc23:1"]).toBeDefined();
  });

  test("tombstone does not mutate previous state", () => {
    const initial = setItems([makeItem({ qid: "p:abc23:1" })]);
    applyWsPayload(initial, { qid: "p:abc23:1", deleted: true });
    // initial must still have the item.
    expect(initial["p:abc23:1"]).toBeDefined();
  });
});
