/**
 * Tests for deps.ts — read-side: ItemRef, computeDependencies, computeDependents,
 * computeBlockers, isPickable, wouldCreateCycle.
 */

import { describe, test, expect } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Index, IndexRecord, initDb, DB_FILENAME } from "./index";
import {
  ItemRef,
  computeDependencies,
  computeDependents,
  computeBlockers,
  isPickable,
  wouldCreateCycle,
} from "./deps";
import { NotFound } from "./errors";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "loom-deps-test-"));
}

function makeRecord(overrides: Partial<IndexRecord> = {}): IndexRecord {
  return {
    qualified_id: "p:backlog:1:1",
    type: "task",
    project: "p",
    epic: "backlog",
    story: 1,
    task: 1,
    parent_id: "p:backlog:1",
    title: "Task 1",
    status: "ready",
    assignee: null,
    branch: null,
    pr_url: null,
    repo: null,
    default_branch: null,
    archived: false,
    created_at: "2024-01-01T00:00:00+00:00",
    updated_at: "2024-01-01T00:00:00+00:00",
    file_path: "projects/p/epics/backlog/stories/1/tasks/1.md",
    body_hash: "h1",
    frontmatter_json: JSON.stringify({ depends_on: [] }),
    depends_on: [],
    tags: [],
    ...overrides,
  };
}

function setupIndex(dir: string, records: IndexRecord[]): Index {
  initDb(path.join(dir, DB_FILENAME));
  const idx = new Index(dir);
  idx.replaceAll(records);
  return idx;
}

// ---------------------------------------------------------------------------
// ItemRef
// ---------------------------------------------------------------------------

describe("ItemRef.fromRecord", () => {
  test("builds an ItemRef from an IndexRecord", () => {
    const rec = makeRecord({ title: "My task", status: "done" });
    const ref = ItemRef.fromRecord(rec);
    expect(ref.qualifiedId).toBe("p:backlog:1:1");
    expect(ref.type).toBe("task");
    expect(ref.title).toBe("My task");
    expect(ref.status).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// computeDependencies
// ---------------------------------------------------------------------------

describe("computeDependencies", () => {
  test("returns empty list when item has no deps", () => {
    const dir = makeTmpDir();
    const a = makeRecord();
    const idx = setupIndex(dir, [a]);
    expect(computeDependencies(idx, "p:backlog:1:1")).toEqual([]);
  });

  test("returns refs for declared deps", () => {
    const dir = makeTmpDir();
    const a = makeRecord({ qualified_id: "p:backlog:1:1", task: 1, title: "A", file_path: "projects/p/epics/backlog/stories/1/tasks/1.md", frontmatter_json: "{}" });
    const b = makeRecord({
      qualified_id: "p:backlog:1:2", task: 2, title: "B",
      file_path: "projects/p/epics/backlog/stories/1/tasks/2.md",
      depends_on: ["p:backlog:1:1"],
      frontmatter_json: JSON.stringify({ depends_on: ["p:backlog:1:1"] }),
    });
    const idx = setupIndex(dir, [a, b]);
    const deps = computeDependencies(idx, "p:backlog:1:2");
    expect(deps).toHaveLength(1);
    expect(deps[0]!.qualifiedId).toBe("p:backlog:1:1");
    expect(deps[0]!.type).toBe("task");
    expect(deps[0]!.title).toBe("A");
  });

  test("drops missing targets gracefully (broken dep)", () => {
    const dir = makeTmpDir();
    // b declares dep on a, but only b is in the index
    const b = makeRecord({
      qualified_id: "p:backlog:1:2", task: 2,
      file_path: "projects/p/epics/backlog/stories/1/tasks/2.md",
      depends_on: ["p:backlog:1:99"],
      frontmatter_json: JSON.stringify({ depends_on: ["p:backlog:1:99"] }),
    });
    // Must use replaceAll to avoid FK violations
    initDb(path.join(dir, DB_FILENAME));
    const idx = new Index(dir);
    idx.replaceAll([b]);
    const deps = computeDependencies(idx, "p:backlog:1:2");
    // dependenciesOf returns from DB where FK cascade removed the edge — empty
    expect(deps).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// computeDependents
// ---------------------------------------------------------------------------

describe("computeDependents", () => {
  test("returns empty list when nothing depends on item", () => {
    const dir = makeTmpDir();
    const a = makeRecord();
    const idx = setupIndex(dir, [a]);
    expect(computeDependents(idx, "p:backlog:1:1")).toEqual([]);
  });

  test("returns refs for items that depend on the given item", () => {
    const dir = makeTmpDir();
    const a = makeRecord({ title: "A", frontmatter_json: "{}" });
    const b = makeRecord({
      qualified_id: "p:backlog:1:2", task: 2, title: "B",
      file_path: "projects/p/epics/backlog/stories/1/tasks/2.md",
      depends_on: ["p:backlog:1:1"],
      frontmatter_json: JSON.stringify({ depends_on: ["p:backlog:1:1"] }),
    });
    const idx = setupIndex(dir, [a, b]);
    const dependents = computeDependents(idx, "p:backlog:1:1");
    expect(dependents).toHaveLength(1);
    expect(dependents[0]!.qualifiedId).toBe("p:backlog:1:2");
  });
});

// ---------------------------------------------------------------------------
// computeBlockers
// ---------------------------------------------------------------------------

describe("computeBlockers", () => {
  test("raises NotFound for unknown item", () => {
    const dir = makeTmpDir();
    initDb(path.join(dir, DB_FILENAME));
    const idx = new Index(dir);
    expect(() => computeBlockers(idx, "p:backlog:1:99")).toThrow(NotFound);
  });

  test("returns empty when item has no deps", () => {
    const dir = makeTmpDir();
    const a = makeRecord({ frontmatter_json: "{}" });
    const idx = setupIndex(dir, [a]);
    expect(computeBlockers(idx, "p:backlog:1:1")).toEqual([]);
  });

  test("returns non-done deps as blockers", () => {
    const dir = makeTmpDir();
    const a = makeRecord({ title: "A", status: "ready", frontmatter_json: "{}" });
    const b = makeRecord({
      qualified_id: "p:backlog:1:2", task: 2, title: "B",
      file_path: "projects/p/epics/backlog/stories/1/tasks/2.md",
      status: "ready",
      depends_on: ["p:backlog:1:1"],
      frontmatter_json: JSON.stringify({ depends_on: ["p:backlog:1:1"] }),
    });
    const idx = setupIndex(dir, [a, b]);
    const blockers = computeBlockers(idx, "p:backlog:1:2");
    expect(blockers).toHaveLength(1);
    expect(blockers[0]!.qualifiedId).toBe("p:backlog:1:1");
  });

  test("done dep is not a blocker", () => {
    const dir = makeTmpDir();
    const a = makeRecord({ title: "A", status: "done", frontmatter_json: "{}" });
    const b = makeRecord({
      qualified_id: "p:backlog:1:2", task: 2, title: "B",
      file_path: "projects/p/epics/backlog/stories/1/tasks/2.md",
      status: "ready",
      depends_on: ["p:backlog:1:1"],
      frontmatter_json: JSON.stringify({ depends_on: ["p:backlog:1:1"] }),
    });
    const idx = setupIndex(dir, [a, b]);
    expect(computeBlockers(idx, "p:backlog:1:2")).toHaveLength(0);
  });

  test("custom status (not 'done') still blocks", () => {
    const dir = makeTmpDir();
    const a = makeRecord({ title: "A", status: "completed", frontmatter_json: "{}" });
    const b = makeRecord({
      qualified_id: "p:backlog:1:2", task: 2, title: "B",
      file_path: "projects/p/epics/backlog/stories/1/tasks/2.md",
      status: "ready",
      depends_on: ["p:backlog:1:1"],
      frontmatter_json: JSON.stringify({ depends_on: ["p:backlog:1:1"] }),
    });
    const idx = setupIndex(dir, [a, b]);
    const blockers = computeBlockers(idx, "p:backlog:1:2");
    expect(blockers).toHaveLength(1);
    expect(blockers[0]!.qualifiedId).toBe("p:backlog:1:1");
  });

  test("missing dep target surfaces as placeholder blocker", () => {
    const dir = makeTmpDir();
    // b depends on a non-existent item, declared in frontmatter
    const b = makeRecord({
      qualified_id: "p:backlog:1:2", task: 2, title: "B",
      file_path: "projects/p/epics/backlog/stories/1/tasks/2.md",
      status: "ready",
      depends_on: [],  // DB edge dropped (FK), but frontmatter still declares it
      frontmatter_json: JSON.stringify({ depends_on: ["p:backlog:1:99"] }),
    });
    initDb(path.join(dir, DB_FILENAME));
    const idx = new Index(dir);
    idx.replaceAll([b]);
    const blockers = computeBlockers(idx, "p:backlog:1:2");
    expect(blockers).toHaveLength(1);
    expect(blockers[0]!.qualifiedId).toBe("p:backlog:1:99");
    expect(blockers[0]!.type).toBe("missing");
    expect(blockers[0]!.status).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isPickable
// ---------------------------------------------------------------------------

describe("isPickable", () => {
  test("raises NotFound for unknown item", () => {
    const dir = makeTmpDir();
    initDb(path.join(dir, DB_FILENAME));
    const idx = new Index(dir);
    expect(() => isPickable(idx, "p:backlog:1:99")).toThrow(NotFound);
  });

  test("true when status=ready, not archived, no deps", () => {
    const dir = makeTmpDir();
    const a = makeRecord({ status: "ready", archived: false, frontmatter_json: "{}" });
    const idx = setupIndex(dir, [a]);
    expect(isPickable(idx, "p:backlog:1:1")).toBe(true);
  });

  test("false when status is not ready", () => {
    const dir = makeTmpDir();
    const a = makeRecord({ status: "blocked", frontmatter_json: "{}" });
    const idx = setupIndex(dir, [a]);
    expect(isPickable(idx, "p:backlog:1:1")).toBe(false);
  });

  test("false when archived", () => {
    const dir = makeTmpDir();
    const a = makeRecord({ archived: true, frontmatter_json: "{}" });
    const idx = setupIndex(dir, [a]);
    expect(isPickable(idx, "p:backlog:1:1")).toBe(false);
  });

  test("false when dep is not done", () => {
    const dir = makeTmpDir();
    const a = makeRecord({ title: "A", status: "ready", frontmatter_json: "{}" });
    const b = makeRecord({
      qualified_id: "p:backlog:1:2", task: 2, title: "B",
      file_path: "projects/p/epics/backlog/stories/1/tasks/2.md",
      status: "ready",
      depends_on: ["p:backlog:1:1"],
      frontmatter_json: JSON.stringify({ depends_on: ["p:backlog:1:1"] }),
    });
    const idx = setupIndex(dir, [a, b]);
    expect(isPickable(idx, "p:backlog:1:2")).toBe(false);
  });

  test("true when all deps are done", () => {
    const dir = makeTmpDir();
    const a = makeRecord({ title: "A", status: "done", frontmatter_json: "{}" });
    const b = makeRecord({
      qualified_id: "p:backlog:1:2", task: 2, title: "B",
      file_path: "projects/p/epics/backlog/stories/1/tasks/2.md",
      status: "ready",
      depends_on: ["p:backlog:1:1"],
      frontmatter_json: JSON.stringify({ depends_on: ["p:backlog:1:1"] }),
    });
    const idx = setupIndex(dir, [a, b]);
    expect(isPickable(idx, "p:backlog:1:2")).toBe(true);
  });

  test("false when missing dep target (broken dep)", () => {
    const dir = makeTmpDir();
    const b = makeRecord({
      qualified_id: "p:backlog:1:2", task: 2, title: "B",
      file_path: "projects/p/epics/backlog/stories/1/tasks/2.md",
      status: "ready",
      depends_on: [],
      frontmatter_json: JSON.stringify({ depends_on: ["p:backlog:1:99"] }),
    });
    initDb(path.join(dir, DB_FILENAME));
    const idx = new Index(dir);
    idx.replaceAll([b]);
    expect(isPickable(idx, "p:backlog:1:2")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// wouldCreateCycle
// ---------------------------------------------------------------------------

describe("wouldCreateCycle", () => {
  test("returns null when no cycle would form", () => {
    const dir = makeTmpDir();
    const a = makeRecord({ title: "A", frontmatter_json: "{}" });
    const b = makeRecord({
      qualified_id: "p:backlog:1:2", task: 2, title: "B",
      file_path: "projects/p/epics/backlog/stories/1/tasks/2.md",
      frontmatter_json: "{}",
    });
    const idx = setupIndex(dir, [a, b]);
    // a -> b would not cycle since b has no deps
    expect(wouldCreateCycle(idx, "p:backlog:1:1", "p:backlog:1:2")).toBeNull();
  });

  test("returns cycle path for direct self-loop (source == target)", () => {
    const dir = makeTmpDir();
    const a = makeRecord({ frontmatter_json: "{}" });
    const idx = setupIndex(dir, [a]);
    const cycle = wouldCreateCycle(idx, "p:backlog:1:1", "p:backlog:1:1");
    expect(cycle).not.toBeNull();
    expect(cycle!.length).toBeGreaterThanOrEqual(2);
  });

  test("detects indirect cycle: b->a exists, adding a->b creates cycle", () => {
    const dir = makeTmpDir();
    const a = makeRecord({ title: "A", frontmatter_json: "{}" });
    const b = makeRecord({
      qualified_id: "p:backlog:1:2", task: 2, title: "B",
      file_path: "projects/p/epics/backlog/stories/1/tasks/2.md",
      depends_on: ["p:backlog:1:1"],
      frontmatter_json: JSON.stringify({ depends_on: ["p:backlog:1:1"] }),
    });
    const idx = setupIndex(dir, [a, b]);
    // b->a exists; adding a->b would close a->b->a
    const cycle = wouldCreateCycle(idx, "p:backlog:1:1", "p:backlog:1:2");
    expect(cycle).not.toBeNull();
    expect(cycle).toContain("p:backlog:1:1");
    expect(cycle).toContain("p:backlog:1:2");
  });

  test("detects longer chain cycle: c->b->a, adding a->c creates cycle", () => {
    const dir = makeTmpDir();
    const a = makeRecord({ title: "A", frontmatter_json: "{}" });
    const b = makeRecord({
      qualified_id: "p:backlog:1:2", task: 2, title: "B",
      file_path: "projects/p/epics/backlog/stories/1/tasks/2.md",
      depends_on: ["p:backlog:1:1"],
      frontmatter_json: JSON.stringify({ depends_on: ["p:backlog:1:1"] }),
    });
    const c = makeRecord({
      qualified_id: "p:backlog:1:3", task: 3, title: "C",
      file_path: "projects/p/epics/backlog/stories/1/tasks/3.md",
      depends_on: ["p:backlog:1:2"],
      frontmatter_json: JSON.stringify({ depends_on: ["p:backlog:1:2"] }),
    });
    const idx = setupIndex(dir, [a, b, c]);
    // c->b->a; adding a->c would create a->c->b->a
    const cycle = wouldCreateCycle(idx, "p:backlog:1:1", "p:backlog:1:3");
    expect(cycle).not.toBeNull();
  });
});
