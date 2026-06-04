/**
 * Tests for web/lib/rebuild.ts — rebuild() and syncOne().
 */

import { describe, test, expect } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { rebuild, syncOne, RebuildResult } from "./rebuild";
import { Index, initDb, DB_FILENAME } from "./index";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "loom-rebuild-test-"));
}

function writeItem(
  filePath: string,
  overrides: Record<string, unknown> = {}
): void {
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
  return path.join(
    root,
    `projects/myproj/epics/backlog/stories/${story}/tasks/${task}.md`
  );
}

// ---------------------------------------------------------------------------
// RebuildResult type
// ---------------------------------------------------------------------------

describe("RebuildResult", () => {
  test("rebuild returns a RebuildResult with indexed_count, rewrites, issues", async () => {
    const root = makeTmpDir();
    writeItem(taskPath(root));
    const result = await rebuild(root);
    expect(typeof result.indexed_count).toBe("number");
    expect(Array.isArray(result.rewrites)).toBe(true);
    expect(Array.isArray(result.issues)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// rebuild()
// ---------------------------------------------------------------------------

describe("rebuild", () => {
  test("repopulates index from markdown files", async () => {
    const root = makeTmpDir();
    writeItem(taskPath(root));
    const result = await rebuild(root);
    expect(result.indexed_count).toBe(1);
    const idx = new Index(root);
    expect(idx.has("myproj:backlog:1:1")).toBe(true);
  });

  test("indexes multiple items", async () => {
    const root = makeTmpDir();
    writeItem(taskPath(root, 1, 1));
    writeItem(taskPath(root, 1, 2), {
      qualified_id: "myproj:backlog:1:2",
      id: "2",
      title: "Task 2",
    });
    const result = await rebuild(root);
    expect(result.indexed_count).toBe(2);
  });

  test("no data loss: all items accessible after rebuild", async () => {
    const root = makeTmpDir();
    writeItem(taskPath(root));
    await rebuild(root);
    const idx = new Index(root);
    const rec = idx.get("myproj:backlog:1:1");
    expect(rec).not.toBeNull();
    expect(rec!.title).toBe("Test task");
  });

  test("rewrites frontmatter when qualified_id disagrees with path", async () => {
    const root = makeTmpDir();
    const p = taskPath(root);
    // Write with wrong qualified_id — path should win
    writeItem(p, { qualified_id: "wrong:backlog:1:1" });
    const result = await rebuild(root);
    expect(result.rewrites.length).toBeGreaterThan(0);
    // After rewrite, file should have correct qualified_id
    const content = fs.readFileSync(p, "utf-8");
    expect(content).toContain("myproj:backlog:1:1");
    expect(content).not.toContain("wrong:backlog:1:1");
  });

  test("stray file produces an issue, not an abort", async () => {
    const root = makeTmpDir();
    writeItem(taskPath(root));
    const stray = path.join(root, "projects/myproj/stray.md");
    fs.mkdirSync(path.dirname(stray), { recursive: true });
    fs.writeFileSync(stray, "# stray\n", "utf-8");
    const result = await rebuild(root);
    const kinds = result.issues.map((i) => i.kind);
    expect(kinds).toContain("stray_file");
    // The valid task should still be indexed
    expect(result.indexed_count).toBe(1);
  });

  test("parse error produces an issue, not an abort", async () => {
    const root = makeTmpDir();
    writeItem(taskPath(root));
    const bad = taskPath(root, 1, 2);
    fs.mkdirSync(path.dirname(bad), { recursive: true });
    fs.writeFileSync(bad, "---\nbad: : yaml\n---\n", "utf-8");
    const result = await rebuild(root);
    const kinds = result.issues.map((i) => i.kind);
    expect(kinds).toContain("parse_error");
    expect(result.indexed_count).toBe(1);
  });

  test("broken dep produces an issue in result", async () => {
    const root = makeTmpDir();
    const content = [
      "---",
      'qualified_id: "myproj:backlog:1:1"',
      'id: "1"',
      'title: "Task"',
      'status: "ready"',
      'created_at: "2024-01-01T00:00:00+00:00"',
      'updated_at: "2024-01-01T00:00:00+00:00"',
      "depends_on:",
      '  - "myproj:backlog:1:99"',
      "---",
      "",
    ].join("\n");
    const p = taskPath(root);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, "utf-8");
    const result = await rebuild(root);
    const kinds = result.issues.map((i) => i.kind);
    expect(kinds).toContain("broken_dep");
  });

  test("accepts optional log callback", async () => {
    const root = makeTmpDir();
    writeItem(taskPath(root));
    const logs: string[] = [];
    await rebuild(root, { log: (msg) => logs.push(msg) });
    // log may be called for rewrites etc.; just confirm it doesn't throw
    expect(Array.isArray(logs)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// syncOne()
// ---------------------------------------------------------------------------

describe("syncOne", () => {
  test("adds an item to the index", async () => {
    const root = makeTmpDir();
    initDb(path.join(root, DB_FILENAME));
    const p = taskPath(root);
    writeItem(p);
    await syncOne(root, "myproj:backlog:1:1");
    const idx = new Index(root);
    expect(idx.has("myproj:backlog:1:1")).toBe(true);
  });

  test("updates an existing item in the index", async () => {
    const root = makeTmpDir();
    initDb(path.join(root, DB_FILENAME));
    const p = taskPath(root);
    writeItem(p);
    await syncOne(root, "myproj:backlog:1:1");
    // Modify the file
    writeItem(p, { title: "Updated title" });
    await syncOne(root, "myproj:backlog:1:1");
    const idx = new Index(root);
    expect(idx.get("myproj:backlog:1:1")!.title).toBe("Updated title");
  });

  test("removes item from index when file is deleted", async () => {
    const root = makeTmpDir();
    initDb(path.join(root, DB_FILENAME));
    const p = taskPath(root);
    writeItem(p);
    await syncOne(root, "myproj:backlog:1:1");
    fs.unlinkSync(p);
    await syncOne(root, "myproj:backlog:1:1");
    const idx = new Index(root);
    expect(idx.has("myproj:backlog:1:1")).toBe(false);
  });

  test("throws NotFound when file does not exist and item was never indexed", async () => {
    const root = makeTmpDir();
    initDb(path.join(root, DB_FILENAME));
    const { NotFound } = await import("./errors");
    await expect(syncOne(root, "myproj:backlog:1:1")).rejects.toBeInstanceOf(NotFound);
  });

  test("syncs archived item from _archive/projects/", async () => {
    const root = makeTmpDir();
    initDb(path.join(root, DB_FILENAME));
    const archivePath = path.join(
      root,
      "_archive/projects/myproj/epics/backlog/stories/1/tasks/1.md"
    );
    writeItem(archivePath);
    await syncOne(root, "myproj:backlog:1:1");
    const idx = new Index(root);
    const rec = idx.get("myproj:backlog:1:1");
    expect(rec).not.toBeNull();
    expect(rec!.archived).toBe(true);
  });
});
