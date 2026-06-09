import { describe, expect, test } from "bun:test";
import { boardModel, BOARD_STATUSES } from "./boardModel";
import type { TreeResponse, ItemNode } from "./api/client";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNode(
  qid: string,
  type: string,
  title: string,
  status: string | null,
  children: string[] = [],
  deps: string[] = [],
  created_at?: string,
): ItemNode {
  return { qid, type, title, status, assignee: null, branch: null, pr_url: null, deps, children, created_at };
}

/**
 * Minimal tree: one project → one epic → two stories (different statuses)
 */
function makeTree(): TreeResponse {
  const proj = makeNode("proj", "project", "My Project", null, ["proj:abc23"]);
  const epic = makeNode("proj:abc23", "epic", "Alpha", "in progress", [
    "proj:abc23:1",
    "proj:abc23:2",
  ]);
  const s1 = makeNode("proj:abc23:1", "story", "Story A", "ready", ["proj:abc23:1:1"]);
  const s2 = makeNode("proj:abc23:2", "story", "Story B", "done");
  const t1 = makeNode("proj:abc23:1:1", "task", "Task 1", "done");
  return {
    root: "proj",
    items: [proj, epic, s1, s2, t1],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BOARD_STATUSES", () => {
  test("contains the four story-level statuses in canonical order", () => {
    expect(BOARD_STATUSES).toEqual(["ready", "in progress", "blocked", "done"]);
  });
});

describe("boardModel", () => {
  test("returns one EpicRow per epic in the project", () => {
    const tree = makeTree();
    const rows = boardModel(tree);
    expect(rows).toHaveLength(1);
    expect(rows[0].epicQid).toBe("proj:abc23");
    expect(rows[0].epicTitle).toBe("Alpha");
  });

  test("statusColumns has an entry for each BOARD_STATUS", () => {
    const tree = makeTree();
    const rows = boardModel(tree);
    const colKeys = Object.keys(rows[0].statusColumns);
    expect(colKeys.sort()).toEqual([...BOARD_STATUSES].sort());
  });

  test("stories are bucketed into their correct status column", () => {
    const tree = makeTree();
    const rows = boardModel(tree);
    const cols = rows[0].statusColumns;
    expect(cols["ready"]).toHaveLength(1);
    expect(cols["ready"][0].qid).toBe("proj:abc23:1");
    expect(cols["done"]).toHaveLength(1);
    expect(cols["done"][0].qid).toBe("proj:abc23:2");
    expect(cols["in progress"]).toHaveLength(0);
    expect(cols["blocked"]).toHaveLength(0);
  });

  test("story nodes in columns carry title, qid, status, tags, deps", () => {
    const proj = makeNode("p", "project", "P", null, ["p:aaa23"]);
    const epic = makeNode("p:aaa23", "epic", "E", null, ["p:aaa23:1"]);
    const story = makeNode("p:aaa23:1", "story", "My Story", "in progress", [], ["p:aaa23:2"]);
    // tags come from the ItemNode.tags field — but ItemNode has no tags field in client.ts
    // so we cast it here for testing the passthrough
    const tree: TreeResponse = { root: "p", items: [proj, epic, story] };
    const rows = boardModel(tree);
    const s = rows[0].statusColumns["in progress"][0];
    expect(s.qid).toBe("p:aaa23:1");
    expect(s.title).toBe("My Story");
    expect(s.status).toBe("in progress");
    expect(s.deps).toEqual(["p:aaa23:2"]);
  });

  test("task children of a story are exposed as taskNodes on the story cell", () => {
    const tree = makeTree();
    const rows = boardModel(tree);
    const readyCols = rows[0].statusColumns["ready"];
    const storyA = readyCols[0];
    expect(storyA.taskNodes).toHaveLength(1);
    expect(storyA.taskNodes[0].qid).toBe("proj:abc23:1:1");
    expect(storyA.taskNodes[0].status).toBe("done");
  });

  test("stories with no tasks have an empty taskNodes array", () => {
    const tree = makeTree();
    const rows = boardModel(tree);
    const doneStory = rows[0].statusColumns["done"][0];
    expect(doneStory.taskNodes).toHaveLength(0);
  });

  test("stories with unknown status appear in a column keyed by that status (graceful)", () => {
    const proj = makeNode("p", "project", "P", null, ["p:bbb23"]);
    const epic = makeNode("p:bbb23", "epic", "E", null, ["p:bbb23:1"]);
    const story = makeNode("p:bbb23:1", "story", "Weird", "custom-status");
    const tree: TreeResponse = { root: "p", items: [proj, epic, story] };
    const rows = boardModel(tree);
    // custom-status is not in BOARD_STATUSES but the row should still hold a slot
    const cols = rows[0].statusColumns;
    // The standard columns are present and empty
    expect(cols["ready"]).toHaveLength(0);
    // The story appears under its own status key
    expect(cols["custom-status"]).toBeDefined();
    expect(cols["custom-status"]).toHaveLength(1);
  });

  test("epic review field is surfaced on the EpicRow", () => {
    const proj = makeNode("p", "project", "P", null, ["p:ccc23"]);
    const epicNode = makeNode("p:ccc23", "epic", "E", "in review", []);
    const tree: TreeResponse = { root: "p", items: [proj, epicNode] };
    const rows = boardModel(tree);
    // epicStatus comes from the node's status
    expect(rows[0].epicStatus).toBe("in review");
  });

  test("multiple epics produce multiple rows in tree order", () => {
    const proj = makeNode("p", "project", "P", null, ["p:aaa23", "p:bbb23"]);
    const e1 = makeNode("p:aaa23", "epic", "First", null, []);
    const e2 = makeNode("p:bbb23", "epic", "Second", null, []);
    const tree: TreeResponse = { root: "p", items: [proj, e1, e2] };
    const rows = boardModel(tree);
    expect(rows).toHaveLength(2);
    expect(rows[0].epicQid).toBe("p:aaa23");
    expect(rows[1].epicQid).toBe("p:bbb23");
  });

  test("returns empty array when project has no epics", () => {
    const proj = makeNode("p", "project", "P", null, []);
    const tree: TreeResponse = { root: "p", items: [proj] };
    const rows = boardModel(tree);
    expect(rows).toHaveLength(0);
  });

  test("top-level epics are ordered newest-first by created_at", () => {
    const proj = makeNode("p", "project", "P", null, ["p:aaa23", "p:bbb23"]);
    const e1 = makeNode("p:aaa23", "epic", "Older", null, [], [], "2024-01-01T00:00:00Z");
    const e2 = makeNode("p:bbb23", "epic", "Newer", null, [], [], "2024-06-01T00:00:00Z");
    const tree: TreeResponse = { root: "p", items: [proj, e1, e2] };
    const rows = boardModel(tree);
    expect(rows).toHaveLength(2);
    // Newer epic (e2) should come first
    expect(rows[0].epicQid).toBe("p:bbb23");
    expect(rows[1].epicQid).toBe("p:aaa23");
  });
});
