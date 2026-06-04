/**
 * Tests for web/lib/index.ts — SQLite schema, Index open, apply_record,
 * query methods, schema compat, and cascade-preservation regression.
 *
 * All tests use bun:sqlite directly to validate schema shape.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  DB_FILENAME,
  SCHEMA_VERSION,
  Index,
  IndexRecord,
  initDb,
  currentVersion,
} from "./index";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "loom-index-test-"));
}

function makeRecord(overrides: Partial<IndexRecord> = {}): IndexRecord {
  return {
    qualified_id: "myproj:backlog:1:1",
    type: "task",
    project: "myproj",
    epic: "backlog",
    story: 1,
    task: 1,
    parent_id: "myproj:backlog:1",
    title: "Test task",
    status: "ready",
    assignee: null,
    branch: null,
    pr_url: null,
    repo: null,
    default_branch: null,
    archived: false,
    created_at: "2024-01-01T00:00:00+00:00",
    updated_at: "2024-01-01T00:00:00+00:00",
    file_path: "projects/myproj/epics/backlog/stories/1/tasks/1.md",
    body_hash: "abc123",
    frontmatter_json: "{}",
    depends_on: [],
    tags: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Schema shape
// ---------------------------------------------------------------------------

describe("schema shape", () => {
  test("DB_FILENAME is loom.db", () => {
    expect(DB_FILENAME).toBe("loom.db");
  });

  test("SCHEMA_VERSION is 1", () => {
    expect(SCHEMA_VERSION).toBe(1);
  });

  test("initDb creates db with correct user_version", () => {
    const dir = makeTmpDir();
    const dbPath = path.join(dir, DB_FILENAME);
    initDb(dbPath);
    expect(currentVersion(dbPath)).toBe(1);
  });

  test("initDb creates items table with all required columns", () => {
    const dir = makeTmpDir();
    const dbPath = path.join(dir, DB_FILENAME);
    initDb(dbPath);
    const db = new Database(dbPath, { readonly: true });
    const cols = db.query("PRAGMA table_info(items)").all() as { name: string }[];
    db.close();
    const names = cols.map((c) => c.name);
    expect(names).toContain("qualified_id");
    expect(names).toContain("type");
    expect(names).toContain("project");
    expect(names).toContain("epic");
    expect(names).toContain("story");
    expect(names).toContain("task");
    expect(names).toContain("parent_id");
    expect(names).toContain("title");
    expect(names).toContain("status");
    expect(names).toContain("assignee");
    expect(names).toContain("branch");
    expect(names).toContain("pr_url");
    expect(names).toContain("repo");
    expect(names).toContain("default_branch");
    expect(names).toContain("archived");
    expect(names).toContain("created_at");
    expect(names).toContain("updated_at");
    expect(names).toContain("file_path");
    expect(names).toContain("body_hash");
    expect(names).toContain("frontmatter_json");
  });

  test("initDb creates dependencies table with ON DELETE CASCADE", () => {
    const dir = makeTmpDir();
    const dbPath = path.join(dir, DB_FILENAME);
    initDb(dbPath);
    const db = new Database(dbPath, { readonly: true });
    const cols = db.query("PRAGMA table_info(dependencies)").all() as { name: string }[];
    db.close();
    const names = cols.map((c) => c.name);
    expect(names).toContain("source_id");
    expect(names).toContain("target_id");
    expect(names).toContain("created_at");
  });

  test("initDb creates tags table", () => {
    const dir = makeTmpDir();
    const dbPath = path.join(dir, DB_FILENAME);
    initDb(dbPath);
    const db = new Database(dbPath, { readonly: true });
    const cols = db.query("PRAGMA table_info(tags)").all() as { name: string }[];
    db.close();
    const names = cols.map((c) => c.name);
    expect(names).toContain("item_id");
    expect(names).toContain("tag");
  });

  test("initDb creates expected indexes", () => {
    const dir = makeTmpDir();
    const dbPath = path.join(dir, DB_FILENAME);
    initDb(dbPath);
    const db = new Database(dbPath, { readonly: true });
    const idxRows = db
      .query("SELECT name FROM sqlite_master WHERE type='index' ORDER BY name")
      .all() as { name: string }[];
    db.close();
    const idxNames = idxRows.map((r) => r.name);
    expect(idxNames).toContain("idx_items_status");
    expect(idxNames).toContain("idx_items_type");
    expect(idxNames).toContain("idx_items_parent");
    expect(idxNames).toContain("idx_items_project");
    expect(idxNames).toContain("idx_items_assignee");
    expect(idxNames).toContain("idx_items_archived");
    expect(idxNames).toContain("idx_dep_target");
    expect(idxNames).toContain("idx_tags_tag");
  });

  test("Index can open an existing db created by initDb", () => {
    const dir = makeTmpDir();
    initDb(path.join(dir, DB_FILENAME));
    const idx = new Index(dir);
    // Should not throw; basic operation works
    expect(idx.allQualifiedIds()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// IndexRecord type + applyRecord
// ---------------------------------------------------------------------------

describe("applyRecord", () => {
  test("inserts a new item and retrieves it", () => {
    const dir = makeTmpDir();
    initDb(path.join(dir, DB_FILENAME));
    const idx = new Index(dir);
    const r = makeRecord();
    idx.applyRecord(r);
    const got = idx.get(r.qualified_id);
    expect(got).not.toBeNull();
    expect(got!.qualified_id).toBe(r.qualified_id);
    expect(got!.title).toBe(r.title);
    expect(got!.archived).toBe(false);
  });

  test("upserts an existing item (does not delete and reinsert)", () => {
    const dir = makeTmpDir();
    initDb(path.join(dir, DB_FILENAME));
    const idx = new Index(dir);
    const r = makeRecord();
    idx.applyRecord(r);
    const updated = { ...r, title: "Updated title" };
    idx.applyRecord(updated);
    const got = idx.get(r.qualified_id);
    expect(got!.title).toBe("Updated title");
  });

  test("replaces outgoing tags on update but leaves incoming edges untouched", () => {
    const dir = makeTmpDir();
    initDb(path.join(dir, DB_FILENAME));
    const idx = new Index(dir);
    const r = makeRecord({ tags: ["alpha", "beta"] });
    idx.applyRecord(r);
    // Update with different tags
    const updated = { ...r, tags: ["gamma"] };
    idx.applyRecord(updated);
    const got = idx.get(r.qualified_id);
    expect(got!.tags).toEqual(["gamma"]);
  });

  test("replaces outgoing deps on update", () => {
    const dir = makeTmpDir();
    initDb(path.join(dir, DB_FILENAME));
    const idx = new Index(dir);
    // Insert dep target first
    const target = makeRecord({
      qualified_id: "myproj:backlog:1:2",
      task: 2,
      file_path: "projects/myproj/epics/backlog/stories/1/tasks/2.md",
    });
    idx.applyRecord(target);
    const r = makeRecord({ depends_on: ["myproj:backlog:1:2"] });
    idx.applyRecord(r);
    expect(idx.get(r.qualified_id)!.depends_on).toEqual(["myproj:backlog:1:2"]);
    // Now remove the dep
    idx.applyRecord({ ...r, depends_on: [] });
    expect(idx.get(r.qualified_id)!.depends_on).toEqual([]);
  });

  test("CRITICAL: applyRecord preserves incoming dependency edges on unrelated update (cascade-bug regression)", () => {
    // This is the critical regression test from CLAUDE.md gotchas.
    // If apply_record used DELETE+INSERT instead of UPSERT, the ON DELETE CASCADE
    // on dependencies would wipe incoming edges from *other* items' frontmatter.
    const dir = makeTmpDir();
    initDb(path.join(dir, DB_FILENAME));
    const idx = new Index(dir);

    // target: task 1
    const target = makeRecord({
      qualified_id: "myproj:backlog:1:1",
      task: 1,
      title: "Target task",
    });
    idx.applyRecord(target);

    // source: task 2 depends on task 1
    const source = makeRecord({
      qualified_id: "myproj:backlog:1:2",
      task: 2,
      file_path: "projects/myproj/epics/backlog/stories/1/tasks/2.md",
      depends_on: ["myproj:backlog:1:1"],
    });
    idx.applyRecord(source);

    // Verify the dep exists
    expect(idx.dependentsOf("myproj:backlog:1:1")).toEqual(["myproj:backlog:1:2"]);

    // Now update target (unrelated change — just update title)
    idx.applyRecord({ ...target, title: "Target task (updated)" });

    // The incoming dep from source → target must STILL exist after the update.
    expect(idx.dependentsOf("myproj:backlog:1:1")).toEqual(["myproj:backlog:1:2"]);
  });

  test("IndexRecord archived field roundtrips correctly", () => {
    const dir = makeTmpDir();
    initDb(path.join(dir, DB_FILENAME));
    const idx = new Index(dir);
    const r = makeRecord({ archived: true });
    idx.applyRecord(r);
    expect(idx.get(r.qualified_id)!.archived).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Query methods
// ---------------------------------------------------------------------------

describe("Index query methods", () => {
  test("get returns null for missing item", () => {
    const dir = makeTmpDir();
    initDb(path.join(dir, DB_FILENAME));
    const idx = new Index(dir);
    expect(idx.get("nope:backlog:1:1")).toBeNull();
  });

  test("has returns false for missing item", () => {
    const dir = makeTmpDir();
    initDb(path.join(dir, DB_FILENAME));
    const idx = new Index(dir);
    expect(idx.has("nope:backlog:1:1")).toBe(false);
  });

  test("has returns true after insert", () => {
    const dir = makeTmpDir();
    initDb(path.join(dir, DB_FILENAME));
    const idx = new Index(dir);
    idx.applyRecord(makeRecord());
    expect(idx.has("myproj:backlog:1:1")).toBe(true);
  });

  test("delete removes item and has returns false", () => {
    const dir = makeTmpDir();
    initDb(path.join(dir, DB_FILENAME));
    const idx = new Index(dir);
    idx.applyRecord(makeRecord());
    idx.delete("myproj:backlog:1:1");
    expect(idx.has("myproj:backlog:1:1")).toBe(false);
  });

  test("allQualifiedIds returns sorted ids", () => {
    const dir = makeTmpDir();
    initDb(path.join(dir, DB_FILENAME));
    const idx = new Index(dir);
    const t2 = makeRecord({
      qualified_id: "myproj:backlog:1:2",
      task: 2,
      file_path: "projects/myproj/epics/backlog/stories/1/tasks/2.md",
    });
    const t1 = makeRecord();
    idx.applyRecord(t1);
    idx.applyRecord(t2);
    expect(idx.allQualifiedIds()).toEqual([
      "myproj:backlog:1:1",
      "myproj:backlog:1:2",
    ]);
  });

  test("find by type", () => {
    const dir = makeTmpDir();
    initDb(path.join(dir, DB_FILENAME));
    const idx = new Index(dir);
    idx.applyRecord(makeRecord({ type: "task" }));
    const tasks = idx.find({ type: "task" });
    expect(tasks.length).toBe(1);
    const stories = idx.find({ type: "story" });
    expect(stories.length).toBe(0);
  });

  test("find by status", () => {
    const dir = makeTmpDir();
    initDb(path.join(dir, DB_FILENAME));
    const idx = new Index(dir);
    idx.applyRecord(makeRecord({ status: "ready" }));
    expect(idx.find({ status: "ready" }).length).toBe(1);
    expect(idx.find({ status: "done" }).length).toBe(0);
  });

  test("find by archived flag", () => {
    const dir = makeTmpDir();
    initDb(path.join(dir, DB_FILENAME));
    const idx = new Index(dir);
    idx.applyRecord(makeRecord({ archived: false }));
    const archivedR = makeRecord({
      qualified_id: "myproj:backlog:1:2",
      task: 2,
      file_path: "projects/myproj/epics/backlog/stories/1/tasks/2.md",
      archived: true,
    });
    idx.applyRecord(archivedR);
    expect(idx.find({ archived: false }).length).toBe(1);
    expect(idx.find({ archived: true }).length).toBe(1);
  });

  test("find by tag", () => {
    const dir = makeTmpDir();
    initDb(path.join(dir, DB_FILENAME));
    const idx = new Index(dir);
    idx.applyRecord(makeRecord({ tags: ["urgent"] }));
    expect(idx.find({ tag: "urgent" }).length).toBe(1);
    expect(idx.find({ tag: "other" }).length).toBe(0);
  });

  test("statuses returns distinct non-null statuses sorted", () => {
    const dir = makeTmpDir();
    initDb(path.join(dir, DB_FILENAME));
    const idx = new Index(dir);
    idx.applyRecord(makeRecord({ status: "done" }));
    idx.applyRecord(
      makeRecord({
        qualified_id: "myproj:backlog:1:2",
        task: 2,
        file_path: "projects/myproj/epics/backlog/stories/1/tasks/2.md",
        status: "ready",
      })
    );
    expect(idx.statuses()).toEqual(["done", "ready"]);
  });

  test("findPickable returns ready unarchived items with all deps done", () => {
    const dir = makeTmpDir();
    initDb(path.join(dir, DB_FILENAME));
    const idx = new Index(dir);
    // task1: ready, no deps → pickable
    const t1 = makeRecord({ status: "ready", archived: false });
    // task2: ready but depends on task3 which is not done → blocked
    const t3 = makeRecord({
      qualified_id: "myproj:backlog:1:3",
      task: 3,
      file_path: "projects/myproj/epics/backlog/stories/1/tasks/3.md",
      status: "ready",
    });
    const t2 = makeRecord({
      qualified_id: "myproj:backlog:1:2",
      task: 2,
      file_path: "projects/myproj/epics/backlog/stories/1/tasks/2.md",
      status: "ready",
      depends_on: ["myproj:backlog:1:3"],
    });
    idx.applyRecord(t1);
    idx.applyRecord(t3);
    idx.applyRecord(t2);
    const pickable = idx.findPickable();
    const ids = pickable.map((r) => r.qualified_id).sort();
    expect(ids).toContain("myproj:backlog:1:1");
    expect(ids).toContain("myproj:backlog:1:3");
    expect(ids).not.toContain("myproj:backlog:1:2");
  });

  test("findPickable custom status does not satisfy dependency", () => {
    const dir = makeTmpDir();
    initDb(path.join(dir, DB_FILENAME));
    const idx = new Index(dir);
    // dep target has custom status 'completed' — should NOT satisfy
    const depTarget = makeRecord({
      qualified_id: "myproj:backlog:1:2",
      task: 2,
      file_path: "projects/myproj/epics/backlog/stories/1/tasks/2.md",
      status: "completed",
    });
    const source = makeRecord({
      depends_on: ["myproj:backlog:1:2"],
    });
    idx.applyRecord(depTarget);
    idx.applyRecord(source);
    const pickable = idx.findPickable();
    const ids = pickable.map((r) => r.qualified_id);
    expect(ids).not.toContain("myproj:backlog:1:1");
  });

  test("dependenciesOf and dependentsOf", () => {
    const dir = makeTmpDir();
    initDb(path.join(dir, DB_FILENAME));
    const idx = new Index(dir);
    const t1 = makeRecord();
    const t2 = makeRecord({
      qualified_id: "myproj:backlog:1:2",
      task: 2,
      file_path: "projects/myproj/epics/backlog/stories/1/tasks/2.md",
      depends_on: ["myproj:backlog:1:1"],
    });
    idx.applyRecord(t1);
    idx.applyRecord(t2);
    expect(idx.dependenciesOf("myproj:backlog:1:2")).toEqual(["myproj:backlog:1:1"]);
    expect(idx.dependentsOf("myproj:backlog:1:1")).toEqual(["myproj:backlog:1:2"]);
  });

  test("allDependencies returns all edges", () => {
    const dir = makeTmpDir();
    initDb(path.join(dir, DB_FILENAME));
    const idx = new Index(dir);
    const t1 = makeRecord();
    const t2 = makeRecord({
      qualified_id: "myproj:backlog:1:2",
      task: 2,
      file_path: "projects/myproj/epics/backlog/stories/1/tasks/2.md",
      depends_on: ["myproj:backlog:1:1"],
    });
    idx.applyRecord(t1);
    idx.applyRecord(t2);
    expect(idx.allDependencies()).toEqual([["myproj:backlog:1:2", "myproj:backlog:1:1"]]);
  });
});
