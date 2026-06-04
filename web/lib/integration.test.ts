/**
 * Integration tests covering:
 * 1. Schema compat — TS Index can open and query a DB built by Python (or
 *    a DB with the exact same schema shape).
 * 2. Cascade preservation — applyRecord's UPSERT contract across updates.
 * 3. Rebuild round-trip — full project→task hierarchy rebuilt with no data loss.
 * 4. Validation kinds — all KIND_* constants exercised end-to-end.
 */

import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Index, IndexRecord, initDb, DB_FILENAME, SCHEMA_VERSION, currentVersion } from "./index";
import { rebuild } from "./rebuild";
import { syncOne } from "./rebuild";
import { validate, KIND_BROKEN_DEP, KIND_DRIFT, KIND_NOT_INDEXED, KIND_ORPHAN_INDEX, KIND_PATH_ID_MISMATCH, KIND_TYPE_MISMATCH, KIND_MISSING_FIELD, KIND_STRAY_FILE } from "./validation";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "loom-integration-test-"));
}

/**
 * Build a "Python-shaped" DB using raw bun:sqlite — identical schema to what
 * Python's init_db creates. The TS Index must be able to open and query it.
 */
function buildPythonStyleDb(dbPath: string): void {
  const db = new Database(dbPath);
  db.run("PRAGMA foreign_keys = ON");
  db.run(`CREATE TABLE IF NOT EXISTS items (
    qualified_id     TEXT PRIMARY KEY,
    type             TEXT NOT NULL CHECK (type IN ('project','epic','story','task')),
    project          TEXT NOT NULL,
    epic             TEXT,
    story            INTEGER,
    task             INTEGER,
    parent_id        TEXT,
    title            TEXT NOT NULL,
    status           TEXT,
    assignee         TEXT,
    branch           TEXT,
    pr_url           TEXT,
    repo             TEXT,
    default_branch   TEXT,
    archived         INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL,
    file_path        TEXT NOT NULL UNIQUE,
    body_hash        TEXT NOT NULL,
    frontmatter_json TEXT NOT NULL
  )`);
  db.run("CREATE INDEX IF NOT EXISTS idx_items_status   ON items(status)");
  db.run("CREATE INDEX IF NOT EXISTS idx_items_type     ON items(type)");
  db.run("CREATE INDEX IF NOT EXISTS idx_items_parent   ON items(parent_id)");
  db.run("CREATE INDEX IF NOT EXISTS idx_items_project  ON items(project)");
  db.run("CREATE INDEX IF NOT EXISTS idx_items_assignee ON items(assignee)");
  db.run("CREATE INDEX IF NOT EXISTS idx_items_archived ON items(archived)");
  db.run(`CREATE TABLE IF NOT EXISTS dependencies (
    source_id   TEXT NOT NULL REFERENCES items(qualified_id) ON DELETE CASCADE,
    target_id   TEXT NOT NULL REFERENCES items(qualified_id) ON DELETE CASCADE,
    created_at  TEXT NOT NULL,
    PRIMARY KEY (source_id, target_id)
  )`);
  db.run("CREATE INDEX IF NOT EXISTS idx_dep_target ON dependencies(target_id)");
  db.run(`CREATE TABLE IF NOT EXISTS tags (
    item_id TEXT NOT NULL REFERENCES items(qualified_id) ON DELETE CASCADE,
    tag     TEXT NOT NULL,
    PRIMARY KEY (item_id, tag)
  )`);
  db.run("CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag)");
  // Insert a sample item
  db.run(
    `INSERT INTO items (qualified_id, type, project, epic, story, task, parent_id,
      title, status, assignee, branch, pr_url, repo, default_branch, archived,
      created_at, updated_at, file_path, body_hash, frontmatter_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      "myproj:backlog:1:1", "task", "myproj", "backlog", 1, 1,
      "myproj:backlog:1", "Python task", "ready", null, null, null, null, null,
      0, "2024-01-01T00:00:00+00:00", "2024-01-01T00:00:00+00:00",
      "projects/myproj/epics/backlog/stories/1/tasks/1.md", "abc123", "{}",
    ]
  );
  db.run(`PRAGMA user_version = 1`);
  db.close();
}

function writeItem(filePath: string, overrides: Record<string, unknown> = {}): void {
  const fm: Record<string, unknown> = {
    qualified_id: "myproj:backlog:1:1",
    id: "1",
    type: "task",
    title: "Test task",
    status: "ready",
    created_at: "2024-01-01T00:00:00+00:00",
    updated_at: "2024-01-01T00:00:00+00:00",
    ...overrides,
  };
  const yamlLines = Object.entries(fm)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join("\n");
  const content = `---\n${yamlLines}\n---\n`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
}

function taskPath(root: string, story = 1, task = 1): string {
  return path.join(root, `projects/myproj/epics/backlog/stories/${story}/tasks/${task}.md`);
}

// ---------------------------------------------------------------------------
// 1. Schema compatibility
// ---------------------------------------------------------------------------

describe("schema compat: TS Index can open a Python-built loom.db", () => {
  test("TS Index reads user_version=1 from a Python-shaped DB", () => {
    const dir = makeTmpDir();
    const dbPath = path.join(dir, DB_FILENAME);
    buildPythonStyleDb(dbPath);
    expect(currentVersion(dbPath)).toBe(1);
  });

  test("TS Index can query items from a Python-shaped DB", () => {
    const dir = makeTmpDir();
    const dbPath = path.join(dir, DB_FILENAME);
    buildPythonStyleDb(dbPath);
    const idx = new Index(dir);
    const rec = idx.get("myproj:backlog:1:1");
    expect(rec).not.toBeNull();
    expect(rec!.title).toBe("Python task");
    expect(rec!.type).toBe("task");
    expect(rec!.project).toBe("myproj");
  });

  test("TS Index can find() items from a Python-shaped DB", () => {
    const dir = makeTmpDir();
    const dbPath = path.join(dir, DB_FILENAME);
    buildPythonStyleDb(dbPath);
    const idx = new Index(dir);
    const results = idx.find({ type: "task", status: "ready" });
    expect(results.length).toBe(1);
    expect(results[0]!.qualified_id).toBe("myproj:backlog:1:1");
  });

  test("TS schema matches Python column order exactly", () => {
    const dir1 = makeTmpDir();
    const dir2 = makeTmpDir();
    // TS-built DB
    initDb(path.join(dir1, DB_FILENAME));
    // Python-shaped DB
    buildPythonStyleDb(path.join(dir2, DB_FILENAME));
    const ts_db = new Database(path.join(dir1, DB_FILENAME), { readonly: true });
    const py_db = new Database(path.join(dir2, DB_FILENAME), { readonly: true });
    const tsCols = (ts_db.query("PRAGMA table_info(items)").all() as { name: string }[]).map(c => c.name);
    const pyCols = (py_db.query("PRAGMA table_info(items)").all() as { name: string }[]).map(c => c.name);
    ts_db.close();
    py_db.close();
    expect(tsCols).toEqual(pyCols);
  });

  test("applyRecord into a Python-shaped DB works without error", () => {
    const dir = makeTmpDir();
    buildPythonStyleDb(path.join(dir, DB_FILENAME));
    const idx = new Index(dir);
    const r: IndexRecord = {
      qualified_id: "myproj:backlog:1:2",
      type: "task",
      project: "myproj",
      epic: "backlog",
      story: 1,
      task: 2,
      parent_id: "myproj:backlog:1",
      title: "New TS task",
      status: "ready",
      assignee: null,
      branch: null,
      pr_url: null,
      repo: null,
      default_branch: null,
      archived: false,
      created_at: "2024-01-02T00:00:00+00:00",
      updated_at: "2024-01-02T00:00:00+00:00",
      file_path: "projects/myproj/epics/backlog/stories/1/tasks/2.md",
      body_hash: "def456",
      frontmatter_json: "{}",
      depends_on: [],
      tags: [],
    };
    idx.applyRecord(r);
    expect(idx.get("myproj:backlog:1:2")!.title).toBe("New TS task");
  });
});

// ---------------------------------------------------------------------------
// 2. Cascade preservation (comprehensive)
// ---------------------------------------------------------------------------

describe("cascade preservation: applyRecord never wipes incoming edges", () => {
  test("updating item A does not drop B→A dep edge", () => {
    const dir = makeTmpDir();
    initDb(path.join(dir, DB_FILENAME));
    const idx = new Index(dir);
    const a: IndexRecord = {
      qualified_id: "p:backlog:1:1", type: "task", project: "p",
      epic: "backlog", story: 1, task: 1, parent_id: "p:backlog:1",
      title: "A", status: "ready", assignee: null, branch: null, pr_url: null,
      repo: null, default_branch: null, archived: false,
      created_at: "2024-01-01T00:00:00+00:00", updated_at: "2024-01-01T00:00:00+00:00",
      file_path: "projects/p/epics/backlog/stories/1/tasks/1.md",
      body_hash: "h1", frontmatter_json: "{}", depends_on: [], tags: [],
    };
    const b: IndexRecord = {
      ...a, qualified_id: "p:backlog:1:2", task: 2, title: "B",
      file_path: "projects/p/epics/backlog/stories/1/tasks/2.md",
      body_hash: "h2", depends_on: ["p:backlog:1:1"],
    };
    idx.applyRecord(a);
    idx.applyRecord(b);
    // Confirm dep exists
    expect(idx.dependentsOf("p:backlog:1:1")).toEqual(["p:backlog:1:2"]);
    // Update A 5 times in succession — dep must survive each update
    for (let i = 0; i < 5; i++) {
      idx.applyRecord({ ...a, title: `A v${i}` });
      expect(idx.dependentsOf("p:backlog:1:1")).toEqual(["p:backlog:1:2"]);
    }
  });

  test("multiple incoming edges preserved across update", () => {
    const dir = makeTmpDir();
    initDb(path.join(dir, DB_FILENAME));
    const idx = new Index(dir);
    const base: IndexRecord = {
      qualified_id: "p:backlog:1:1", type: "task", project: "p",
      epic: "backlog", story: 1, task: 1, parent_id: "p:backlog:1",
      title: "Target", status: "done", assignee: null, branch: null, pr_url: null,
      repo: null, default_branch: null, archived: false,
      created_at: "2024-01-01T00:00:00+00:00", updated_at: "2024-01-01T00:00:00+00:00",
      file_path: "projects/p/epics/backlog/stories/1/tasks/1.md",
      body_hash: "h1", frontmatter_json: "{}", depends_on: [], tags: [],
    };
    idx.applyRecord(base);
    // Two other tasks depending on base
    for (const n of [2, 3]) {
      idx.applyRecord({
        ...base,
        qualified_id: `p:backlog:1:${n}`, task: n, title: `Dep ${n}`,
        file_path: `projects/p/epics/backlog/stories/1/tasks/${n}.md`,
        body_hash: `h${n}`, depends_on: ["p:backlog:1:1"],
      });
    }
    expect(idx.dependentsOf("p:backlog:1:1").sort()).toEqual(["p:backlog:1:2", "p:backlog:1:3"]);
    // Update target
    idx.applyRecord({ ...base, title: "Target updated" });
    expect(idx.dependentsOf("p:backlog:1:1").sort()).toEqual(["p:backlog:1:2", "p:backlog:1:3"]);
  });
});

// ---------------------------------------------------------------------------
// 3. Rebuild round-trip
// ---------------------------------------------------------------------------

describe("rebuild round-trip", () => {
  test("full project→epic→story→task hierarchy rebuilt with no data loss", async () => {
    const root = makeTmpDir();

    // Project
    const projPath = path.join(root, "projects/myproj/project.md");
    fs.mkdirSync(path.dirname(projPath), { recursive: true });
    fs.writeFileSync(projPath, [
      "---",
      'qualified_id: "myproj"',
      'id: "myproj"',
      'title: "My project"',
      'created_at: "2024-01-01T00:00:00+00:00"',
      'updated_at: "2024-01-01T00:00:00+00:00"',
      "---",
      "",
    ].join("\n"), "utf-8");

    // Epic
    const epicPath = path.join(root, "projects/myproj/epics/backlog/epic.md");
    fs.mkdirSync(path.dirname(epicPath), { recursive: true });
    fs.writeFileSync(epicPath, [
      "---",
      'qualified_id: "myproj:backlog"',
      'id: "backlog"',
      'title: "Backlog"',
      'status: "ready"',
      'created_at: "2024-01-01T00:00:00+00:00"',
      'updated_at: "2024-01-01T00:00:00+00:00"',
      "---",
      "",
    ].join("\n"), "utf-8");

    // Story
    const storyPath = path.join(root, "projects/myproj/epics/backlog/stories/1/story.md");
    fs.mkdirSync(path.dirname(storyPath), { recursive: true });
    fs.writeFileSync(storyPath, [
      "---",
      'qualified_id: "myproj:backlog:1"',
      'id: "1"',
      'title: "Story 1"',
      'status: "ready"',
      'created_at: "2024-01-01T00:00:00+00:00"',
      'updated_at: "2024-01-01T00:00:00+00:00"',
      "---",
      "",
    ].join("\n"), "utf-8");

    // Two tasks
    writeItem(taskPath(root, 1, 1), { title: "Task 1" });
    writeItem(taskPath(root, 1, 2), {
      qualified_id: "myproj:backlog:1:2", id: "2", title: "Task 2",
    });

    const result = await rebuild(root);
    expect(result.indexed_count).toBe(5); // project + epic + story + 2 tasks
    expect(result.issues.length).toBe(0);

    const idx = new Index(root);
    expect(idx.has("myproj")).toBe(true);
    expect(idx.has("myproj:backlog")).toBe(true);
    expect(idx.has("myproj:backlog:1")).toBe(true);
    expect(idx.has("myproj:backlog:1:1")).toBe(true);
    expect(idx.has("myproj:backlog:1:2")).toBe(true);
  });

  test("rebuild is idempotent: running twice produces same result", async () => {
    const root = makeTmpDir();
    writeItem(taskPath(root));
    await rebuild(root);
    const r2 = await rebuild(root);
    expect(r2.indexed_count).toBe(1);
    expect(r2.issues.length).toBe(0);
  });

  test("syncOne re-reads a single changed item without touching others", async () => {
    const root = makeTmpDir();
    writeItem(taskPath(root, 1, 1));
    writeItem(taskPath(root, 1, 2), {
      qualified_id: "myproj:backlog:1:2", id: "2", title: "Task 2",
    });
    await rebuild(root);

    // Modify task 1 only
    writeItem(taskPath(root, 1, 1), { title: "Modified task 1" });
    await syncOne(root, "myproj:backlog:1:1");

    const idx = new Index(root);
    expect(idx.get("myproj:backlog:1:1")!.title).toBe("Modified task 1");
    expect(idx.get("myproj:backlog:1:2")!.title).toBe("Task 2");
  });

  test("rebuild preserves dep edges across full repopulation", async () => {
    const root = makeTmpDir();
    // task 2 depends on task 1
    writeItem(taskPath(root, 1, 1), { title: "Task 1" });
    const content = [
      "---",
      'qualified_id: "myproj:backlog:1:2"',
      'id: "2"',
      'title: "Task 2"',
      'status: "ready"',
      'created_at: "2024-01-01T00:00:00+00:00"',
      'updated_at: "2024-01-01T00:00:00+00:00"',
      "depends_on:",
      '  - "myproj:backlog:1:1"',
      "---",
      "",
    ].join("\n");
    const p2 = taskPath(root, 1, 2);
    fs.mkdirSync(path.dirname(p2), { recursive: true });
    fs.writeFileSync(p2, content, "utf-8");
    await rebuild(root);
    const idx = new Index(root);
    expect(idx.dependenciesOf("myproj:backlog:1:2")).toEqual(["myproj:backlog:1:1"]);
    expect(idx.dependentsOf("myproj:backlog:1:1")).toEqual(["myproj:backlog:1:2"]);
  });
});

// ---------------------------------------------------------------------------
// 4. Validation kinds — end-to-end
// ---------------------------------------------------------------------------

describe("validation kinds end-to-end", () => {
  test("clean index produces no issues", async () => {
    const root = makeTmpDir();
    writeItem(taskPath(root));
    await rebuild(root);
    const issues = await validate(root);
    expect(issues).toEqual([]);
  });

  test("KIND_NOT_INDEXED: file on disk but not in index", async () => {
    const root = makeTmpDir();
    initDb(path.join(root, DB_FILENAME));
    writeItem(taskPath(root));
    const issues = await validate(root);
    expect(issues.some(i => i.kind === KIND_NOT_INDEXED)).toBe(true);
  });

  test("KIND_ORPHAN_INDEX: indexed item with no file", async () => {
    const root = makeTmpDir();
    const p = taskPath(root);
    writeItem(p);
    await rebuild(root);
    fs.unlinkSync(p);
    const issues = await validate(root);
    expect(issues.some(i => i.kind === KIND_ORPHAN_INDEX)).toBe(true);
  });

  test("KIND_DRIFT: file modified after indexing", async () => {
    const root = makeTmpDir();
    const p = taskPath(root);
    writeItem(p);
    await rebuild(root);
    fs.appendFileSync(p, "\n# extra\n");
    const issues = await validate(root);
    expect(issues.some(i => i.kind === KIND_DRIFT)).toBe(true);
  });

  test("KIND_PATH_ID_MISMATCH: frontmatter qualified_id wrong", async () => {
    const root = makeTmpDir();
    initDb(path.join(root, DB_FILENAME));
    writeItem(taskPath(root), { qualified_id: "bad:backlog:1:1" });
    const issues = await validate(root);
    expect(issues.some(i => i.kind === KIND_PATH_ID_MISMATCH)).toBe(true);
  });

  test("KIND_TYPE_MISMATCH: frontmatter type wrong", async () => {
    const root = makeTmpDir();
    initDb(path.join(root, DB_FILENAME));
    writeItem(taskPath(root), { type: "story" });
    const issues = await validate(root);
    expect(issues.some(i => i.kind === KIND_TYPE_MISMATCH)).toBe(true);
  });

  test("KIND_MISSING_FIELD: title absent", async () => {
    const root = makeTmpDir();
    initDb(path.join(root, DB_FILENAME));
    const p = taskPath(root);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, [
      "---",
      'qualified_id: "myproj:backlog:1:1"',
      'id: "1"',
      'status: "ready"',
      'created_at: "2024-01-01T00:00:00+00:00"',
      'updated_at: "2024-01-01T00:00:00+00:00"',
      "---",
      "",
    ].join("\n"), "utf-8");
    const issues = await validate(root);
    expect(issues.some(i => i.kind === KIND_MISSING_FIELD && i.message.includes("title"))).toBe(true);
  });

  test("KIND_BROKEN_DEP: depends_on target not in index", async () => {
    const root = makeTmpDir();
    const p = taskPath(root);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, [
      "---",
      'qualified_id: "myproj:backlog:1:1"',
      'id: "1"',
      'title: "T"',
      'status: "ready"',
      'created_at: "2024-01-01T00:00:00+00:00"',
      'updated_at: "2024-01-01T00:00:00+00:00"',
      "depends_on:",
      '  - "myproj:backlog:1:99"',
      "---",
      "",
    ].join("\n"), "utf-8");
    // Use replaceAll so FK violation doesn't abort
    const { buildRecord } = await import("./scan");
    const idx = new Index(path.join(makeTmpDir())); // separate dir for idx init
    initDb(path.join(root, DB_FILENAME));
    const rootIdx = new Index(root);
    rootIdx.replaceAll([await buildRecord(p, root)]);
    const issues = await validate(root);
    expect(issues.some(i => i.kind === KIND_BROKEN_DEP)).toBe(true);
  });

  test("KIND_STRAY_FILE: .md file not in canonical path", async () => {
    const root = makeTmpDir();
    initDb(path.join(root, DB_FILENAME));
    const stray = path.join(root, "projects/myproj/stray.md");
    fs.mkdirSync(path.dirname(stray), { recursive: true });
    fs.writeFileSync(stray, "# stray\n", "utf-8");
    const issues = await validate(root);
    expect(issues.some(i => i.kind === KIND_STRAY_FILE)).toBe(true);
  });
});
