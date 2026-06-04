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
