/**
 * Live-update render pipeline tests.
 *
 * These tests verify that a simulated store update (via applyWsPayload) causes
 * the affected view model to produce updated output — simulating what happens
 * when an SSE payload arrives and the store's itemsById changes.
 *
 * We test the pure pipeline:
 *   setItems(initialItems) → applyWsPayload(map, payload) → boardModel / tableModel
 *
 * No React mounting required — all functions are pure transforms.
 */

import { describe, expect, test } from "bun:test";
import { setItems, applyWsPayload } from "./itemsReducer";
import type { ItemNode } from "../api/client";
import type { SsePayload as WsPayload } from "../sse/client";
import { boardModel } from "../boardModel";
import { tableModel } from "../tableModel";

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

// Minimal project tree: project → epic → story
// qids use letters from the epic alphabet (no 0/1/i/l/o/u)
const PROJECT_QID = "myproj";
const EPIC_QID = "myproj:aaa2345";
const STORY_QID = "myproj:aaa2345:1";

function makeInitialItems(): ItemNode[] {
  return [
    makeItem({
      qid: PROJECT_QID,
      type: "project",
      title: "My Project",
      status: null,
      children: [EPIC_QID],
    }),
    makeItem({
      qid: EPIC_QID,
      type: "epic",
      title: "An Epic",
      status: "ready",
      children: [STORY_QID],
    }),
    makeItem({
      qid: STORY_QID,
      type: "story",
      title: "A Story",
      status: "ready",
      children: [],
    }),
  ];
}

// ---------------------------------------------------------------------------
// boardModel live-update pipeline
// ---------------------------------------------------------------------------

describe("live-update pipeline: boardModel", () => {
  test("initial store state shows story in ready column", () => {
    const itemsById = setItems(makeInitialItems());
    const items = Object.values(itemsById);
    const rows = boardModel({ root: PROJECT_QID, items });

    expect(rows).toHaveLength(1);
    const epicRow = rows[0];
    expect(epicRow.statusColumns["ready"]).toHaveLength(1);
    expect(epicRow.statusColumns["ready"][0].qid).toBe(STORY_QID);
    expect(epicRow.statusColumns["done"]).toHaveLength(0);
  });

  test("after status update payload, story moves to done column", () => {
    const initial = setItems(makeInitialItems());

    const payload: WsPayload = {
      qid: STORY_QID,
      type: "story",
      title: "A Story",
      status: "done",
      assignee: null,
      branch: null,
      pr_url: null,
      tags: [],
      archived: false,
    };
    const updated = applyWsPayload(initial, payload);
    const items = Object.values(updated);
    const rows = boardModel({ root: PROJECT_QID, items });

    expect(rows).toHaveLength(1);
    const epicRow = rows[0];
    expect(epicRow.statusColumns["ready"]).toHaveLength(0);
    expect(epicRow.statusColumns["done"]).toHaveLength(1);
    expect(epicRow.statusColumns["done"][0].qid).toBe(STORY_QID);
  });

  test("tombstone payload removes story from board", () => {
    const initial = setItems(makeInitialItems());
    const tombstone: WsPayload = { qid: STORY_QID, deleted: true };
    const updated = applyWsPayload(initial, tombstone);
    const items = Object.values(updated);
    const rows = boardModel({ root: PROJECT_QID, items });

    // The epic row still exists but has no stories.
    expect(rows).toHaveLength(1);
    const totalStories = Object.values(rows[0].statusColumns).flat().length;
    expect(totalStories).toBe(0);
  });

  test("new story payload adds story to board", () => {
    const initial = setItems(makeInitialItems());

    // First update the epic to add a new child.
    const NEW_STORY_QID = "myproj:aaa2345:2";
    const epicPayload: WsPayload = {
      qid: EPIC_QID,
      type: "epic",
      title: "An Epic",
      status: "ready",
      assignee: null,
      branch: null,
      pr_url: null,
      tags: [],
      archived: false,
    };
    const afterEpicUpdate = applyWsPayload(initial, epicPayload);

    // Add the new story item.
    const newStoryPayload: WsPayload = {
      qid: NEW_STORY_QID,
      type: "story",
      title: "New Story",
      status: "in progress",
      assignee: null,
      branch: null,
      pr_url: null,
      tags: [],
      archived: false,
    };
    // Manually inject new story and wire it into epic children.
    const afterNewStory = applyWsPayload(afterEpicUpdate, newStoryPayload);
    // Patch epic children to include new story.
    const patchedMap = {
      ...afterNewStory,
      [EPIC_QID]: { ...afterNewStory[EPIC_QID], children: [STORY_QID, NEW_STORY_QID] },
    };

    const items = Object.values(patchedMap);
    const rows = boardModel({ root: PROJECT_QID, items });

    expect(rows).toHaveLength(1);
    expect(epicRow(rows).statusColumns["in progress"]).toHaveLength(1);
    expect(epicRow(rows).statusColumns["in progress"][0].qid).toBe(NEW_STORY_QID);
  });
});

// ---------------------------------------------------------------------------
// tableModel live-update pipeline
// ---------------------------------------------------------------------------

describe("live-update pipeline: tableModel", () => {
  test("initial store state shows story row with ready status", () => {
    const itemsById = setItems(makeInitialItems());
    const items = Object.values(itemsById);
    const rows = tableModel({ root: PROJECT_QID, items }, {});

    const storyRow = rows.find((r) => r.qid === STORY_QID);
    expect(storyRow).toBeDefined();
    expect(storyRow!.status).toBe("ready");
  });

  test("after status update payload, story row reflects new status", () => {
    const initial = setItems(makeInitialItems());

    const payload: WsPayload = {
      qid: STORY_QID,
      type: "story",
      title: "A Story",
      status: "done",
      assignee: null,
      branch: null,
      pr_url: null,
      tags: [],
      archived: false,
    };
    const updated = applyWsPayload(initial, payload);
    const items = Object.values(updated);
    const rows = tableModel({ root: PROJECT_QID, items }, {});

    const storyRow = rows.find((r) => r.qid === STORY_QID);
    expect(storyRow).toBeDefined();
    expect(storyRow!.status).toBe("done");
  });

  test("tombstone payload removes story row from table", () => {
    const initial = setItems(makeInitialItems());
    const tombstone: WsPayload = { qid: STORY_QID, deleted: true };
    const updated = applyWsPayload(initial, tombstone);
    const items = Object.values(updated);
    const rows = tableModel({ root: PROJECT_QID, items }, {});

    const storyRow = rows.find((r) => r.qid === STORY_QID);
    expect(storyRow).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function epicRow(rows: ReturnType<typeof boardModel>) {
  return rows[0];
}
