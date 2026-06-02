import { describe, expect, test } from "bun:test";
import { tableModel, TABLE_COLUMNS } from "./tableModel";
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
): ItemNode {
  return {
    qid,
    type,
    title,
    status,
    assignee: null,
    branch: null,
    pr_url: null,
    deps: [],
    children,
  };
}

/**
 * Minimal tree: project → two epics → stories → tasks
 */
function makeTree(): TreeResponse {
  const proj = makeNode("proj", "project", "My Project", null, [
    "proj:aaa23",
    "proj:bbb23",
  ]);
  const epic1 = makeNode("proj:aaa23", "epic", "Alpha Epic", "in progress", [
    "proj:aaa23:1",
    "proj:aaa23:2",
  ]);
  const epic2 = makeNode("proj:bbb23", "epic", "Beta Epic", "ready", [
    "proj:bbb23:1",
  ]);
  const s1 = makeNode("proj:aaa23:1", "story", "Story A", "ready", [
    "proj:aaa23:1:1",
    "proj:aaa23:1:2",
  ]);
  const s2 = makeNode("proj:aaa23:2", "story", "Story B", "done");
  const s3 = makeNode("proj:bbb23:1", "story", "Story C", "in progress");
  const t1 = makeNode("proj:aaa23:1:1", "task", "Task 1", "done");
  const t2 = makeNode("proj:aaa23:1:2", "task", "Task 2", "ready");
  return {
    root: "proj",
    items: [proj, epic1, epic2, s1, s2, s3, t1, t2],
  };
}

// ---------------------------------------------------------------------------
// TABLE_COLUMNS constant
// ---------------------------------------------------------------------------

describe("TABLE_COLUMNS", () => {
  test("has four entries: Name, Progress, Status, Updated", () => {
    expect(TABLE_COLUMNS).toHaveLength(4);
    expect(TABLE_COLUMNS.map((c) => c.label)).toEqual([
      "Name",
      "Progress",
      "Status",
      "Updated",
    ]);
  });

  test("widths sum to 100%", () => {
    const total = TABLE_COLUMNS.reduce((s, c) => s + c.widthPct, 0);
    expect(total).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// tableModel — basic structure
// ---------------------------------------------------------------------------

describe("tableModel", () => {
  test("returns a row for every item that should be visible", () => {
    const tree = makeTree();
    // No collapse state → all rows visible: 2 epics + 3 stories + 2 tasks = 7
    const rows = tableModel(tree, {});
    expect(rows).toHaveLength(7);
  });

  test("each row carries qid, type, title, status, depth", () => {
    const tree = makeTree();
    const rows = tableModel(tree, {});
    const epicRow = rows.find((r) => r.qid === "proj:aaa23");
    expect(epicRow).toBeDefined();
    expect(epicRow!.type).toBe("epic");
    expect(epicRow!.title).toBe("Alpha Epic");
    expect(epicRow!.status).toBe("in progress");
    expect(epicRow!.depth).toBe(0);
  });

  test("epics are at depth 0, stories at depth 1, tasks at depth 2", () => {
    const tree = makeTree();
    const rows = tableModel(tree, {});
    const epicRow = rows.find((r) => r.qid === "proj:aaa23")!;
    const storyRow = rows.find((r) => r.qid === "proj:aaa23:1")!;
    const taskRow = rows.find((r) => r.qid === "proj:aaa23:1:1")!;
    expect(epicRow.depth).toBe(0);
    expect(storyRow.depth).toBe(1);
    expect(taskRow.depth).toBe(2);
  });

  test("rows appear in tree order: epics, then their stories, then tasks", () => {
    const tree = makeTree();
    const rows = tableModel(tree, {});
    const qids = rows.map((r) => r.qid);
    expect(qids).toEqual([
      "proj:aaa23",
      "proj:aaa23:1",
      "proj:aaa23:1:1",
      "proj:aaa23:1:2",
      "proj:aaa23:2",
      "proj:bbb23",
      "proj:bbb23:1",
    ]);
  });

  test("hasChildren is true for nodes that have child items", () => {
    const tree = makeTree();
    const rows = tableModel(tree, {});
    const epicRow = rows.find((r) => r.qid === "proj:aaa23")!;
    const storyRowWithTasks = rows.find((r) => r.qid === "proj:aaa23:1")!;
    const storyRowNoTasks = rows.find((r) => r.qid === "proj:aaa23:2")!;
    const taskRow = rows.find((r) => r.qid === "proj:aaa23:1:1")!;
    expect(epicRow.hasChildren).toBe(true);
    expect(storyRowWithTasks.hasChildren).toBe(true);
    expect(storyRowNoTasks.hasChildren).toBe(false);
    expect(taskRow.hasChildren).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Collapse state
  // ---------------------------------------------------------------------------

  test("collapsing an epic hides its stories and their tasks", () => {
    const tree = makeTree();
    const rows = tableModel(tree, { "proj:aaa23": true });
    // epic1's stories (and their tasks) are hidden; epic2 and its story remain
    const qids = rows.map((r) => r.qid);
    expect(qids).not.toContain("proj:aaa23:1");
    expect(qids).not.toContain("proj:aaa23:2");
    expect(qids).not.toContain("proj:aaa23:1:1");
    expect(qids).toContain("proj:aaa23");   // epic itself is visible
    expect(qids).toContain("proj:bbb23");
    expect(qids).toContain("proj:bbb23:1");
  });

  test("collapsing a story hides its tasks but not sibling stories", () => {
    const tree = makeTree();
    const rows = tableModel(tree, { "proj:aaa23:1": true });
    const qids = rows.map((r) => r.qid);
    expect(qids).not.toContain("proj:aaa23:1:1");
    expect(qids).not.toContain("proj:aaa23:1:2");
    expect(qids).toContain("proj:aaa23:1");  // story itself visible
    expect(qids).toContain("proj:aaa23:2");  // sibling story still visible
  });

  test("collapsed rows carry isCollapsed=true, expanded rows false", () => {
    const tree = makeTree();
    const rows = tableModel(tree, { "proj:aaa23": true });
    const epicRow = rows.find((r) => r.qid === "proj:aaa23")!;
    const epic2Row = rows.find((r) => r.qid === "proj:bbb23")!;
    expect(epicRow.isCollapsed).toBe(true);
    expect(epic2Row.isCollapsed).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Progress fields
  // ---------------------------------------------------------------------------

  test("story row exposes taskDone and taskTotal counts", () => {
    const tree = makeTree();
    const rows = tableModel(tree, {});
    const storyRow = rows.find((r) => r.qid === "proj:aaa23:1")!;
    // t1 is done, t2 is ready
    expect(storyRow.taskDone).toBe(1);
    expect(storyRow.taskTotal).toBe(2);
  });

  test("epic row exposes storyDone and storyTotal counts", () => {
    const tree = makeTree();
    const rows = tableModel(tree, {});
    const epicRow = rows.find((r) => r.qid === "proj:aaa23")!;
    // s1=ready, s2=done → 1 done out of 2
    expect(epicRow.storyDone).toBe(1);
    expect(epicRow.storyTotal).toBe(2);
  });

  test("task rows have null for progress counts", () => {
    const tree = makeTree();
    const rows = tableModel(tree, {});
    const taskRow = rows.find((r) => r.qid === "proj:aaa23:1:1")!;
    expect(taskRow.taskDone).toBeNull();
    expect(taskRow.taskTotal).toBeNull();
    expect(taskRow.storyDone).toBeNull();
    expect(taskRow.storyTotal).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  test("returns empty array for a project with no epics", () => {
    const proj = makeNode("p", "project", "P", null, []);
    const tree: TreeResponse = { root: "p", items: [proj] };
    expect(tableModel(tree, {})).toHaveLength(0);
  });

  test("items with unknown qid in children array are skipped gracefully", () => {
    const proj = makeNode("p", "project", "P", null, ["p:aaa23"]);
    const epic = makeNode("p:aaa23", "epic", "E", null, ["p:aaa23:1", "p:aaa23:MISSING"]);
    const story = makeNode("p:aaa23:1", "story", "S", "ready");
    const tree: TreeResponse = { root: "p", items: [proj, epic, story] };
    const rows = tableModel(tree, {});
    // Should not throw; missing child is skipped
    const qids = rows.map((r) => r.qid);
    expect(qids).toContain("p:aaa23");
    expect(qids).toContain("p:aaa23:1");
    expect(qids).toHaveLength(2);
  });
});
