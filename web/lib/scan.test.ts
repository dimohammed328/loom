/**
 * Tests for web/lib/scan.ts — walk_md_files, hash_file_bytes, build_record.
 */

import { describe, test, expect } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { walkMdFiles, hashFileBytes, buildRecord } from "./scan";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "loom-scan-test-"));
}

/** Write a minimal loom markdown file at the given absolute path. */
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
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join("\n");
  const content = `---\n${yamlLines}\n---\n## Body\n`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
}

// ---------------------------------------------------------------------------
// walkMdFiles
// ---------------------------------------------------------------------------

describe("walkMdFiles", () => {
  test("returns empty array when no projects/ dir exists", () => {
    const root = makeTmpDir();
    expect(walkMdFiles(root)).toEqual([]);
  });

  test("yields .md files under projects/", () => {
    const root = makeTmpDir();
    const taskPath = path.join(
      root,
      "projects/myproj/epics/backlog/stories/1/tasks/1.md"
    );
    writeItem(taskPath);
    const files = walkMdFiles(root);
    expect(files).toContain(taskPath);
  });

  test("yields .md files under _archive/projects/", () => {
    const root = makeTmpDir();
    const archivePath = path.join(
      root,
      "_archive/projects/myproj/epics/backlog/stories/1/tasks/1.md"
    );
    writeItem(archivePath);
    const files = walkMdFiles(root);
    expect(files).toContain(archivePath);
  });

  test("yields both live and archived files", () => {
    const root = makeTmpDir();
    const livePath = path.join(
      root,
      "projects/myproj/epics/backlog/stories/1/tasks/1.md"
    );
    const archivePath = path.join(
      root,
      "_archive/projects/myproj/epics/backlog/stories/2/tasks/1.md"
    );
    writeItem(livePath);
    writeItem(archivePath, { qualified_id: "myproj:backlog:2:1", id: "1" });
    const files = walkMdFiles(root);
    expect(files).toContain(livePath);
    expect(files).toContain(archivePath);
  });

  test("does not yield files outside projects/ subtrees", () => {
    const root = makeTmpDir();
    const stray = path.join(root, "README.md");
    fs.writeFileSync(stray, "# readme", "utf-8");
    const files = walkMdFiles(root);
    expect(files).not.toContain(stray);
  });

  test("yields sorted files within projects/", () => {
    const root = makeTmpDir();
    const p1 = path.join(
      root,
      "projects/myproj/epics/backlog/stories/1/tasks/2.md"
    );
    const p2 = path.join(
      root,
      "projects/myproj/epics/backlog/stories/1/tasks/1.md"
    );
    writeItem(p1, { id: "2", qualified_id: "myproj:backlog:1:2" });
    writeItem(p2);
    const files = walkMdFiles(root);
    const rel1 = files.indexOf(p2);
    const rel2 = files.indexOf(p1);
    expect(rel1).toBeLessThan(rel2); // 1.md before 2.md
  });
});

// ---------------------------------------------------------------------------
// hashFileBytes
// ---------------------------------------------------------------------------

describe("hashFileBytes", () => {
  test("returns sha256 hex of file bytes", async () => {
    const dir = makeTmpDir();
    const file = path.join(dir, "test.md");
    fs.writeFileSync(file, "hello", "utf-8");
    const hash = await hashFileBytes(file);
    // sha256("hello") = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
    expect(hash).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
    );
  });

  test("produces different hashes for different content", async () => {
    const dir = makeTmpDir();
    const f1 = path.join(dir, "a.md");
    const f2 = path.join(dir, "b.md");
    fs.writeFileSync(f1, "aaa");
    fs.writeFileSync(f2, "bbb");
    expect(await hashFileBytes(f1)).not.toBe(await hashFileBytes(f2));
  });
});

// ---------------------------------------------------------------------------
// buildRecord
// ---------------------------------------------------------------------------

describe("buildRecord", () => {
  test("builds a task record from a canonical path", async () => {
    const root = makeTmpDir();
    const taskPath = path.join(
      root,
      "projects/myproj/epics/backlog/stories/1/tasks/1.md"
    );
    writeItem(taskPath);
    const rec = await buildRecord(taskPath, root);
    expect(rec.qualified_id).toBe("myproj:backlog:1:1");
    expect(rec.type).toBe("task");
    expect(rec.project).toBe("myproj");
    expect(rec.epic).toBe("backlog");
    expect(rec.story).toBe(1);
    expect(rec.task).toBe(1);
    expect(rec.title).toBe("Test task");
    expect(rec.status).toBe("ready");
    expect(rec.archived).toBe(false);
  });

  test("path wins over frontmatter qualified_id", async () => {
    const root = makeTmpDir();
    const taskPath = path.join(
      root,
      "projects/myproj/epics/backlog/stories/1/tasks/1.md"
    );
    // Write with a wrong qualified_id in frontmatter
    writeItem(taskPath, { qualified_id: "wrong:backlog:1:1" });
    const rec = await buildRecord(taskPath, root);
    // Path-derived qid wins
    expect(rec.qualified_id).toBe("myproj:backlog:1:1");
  });

  test("archived flag is true for files under _archive/", async () => {
    const root = makeTmpDir();
    const archivePath = path.join(
      root,
      "_archive/projects/myproj/epics/backlog/stories/1/tasks/1.md"
    );
    writeItem(archivePath);
    const rec = await buildRecord(archivePath, root);
    expect(rec.archived).toBe(true);
  });

  test("missing status defaults to ready for non-project", async () => {
    const root = makeTmpDir();
    const taskPath = path.join(
      root,
      "projects/myproj/epics/backlog/stories/1/tasks/1.md"
    );
    const fm: Record<string, unknown> = {
      qualified_id: "myproj:backlog:1:1",
      id: "1",
      title: "No status",
      created_at: "2024-01-01T00:00:00+00:00",
      updated_at: "2024-01-01T00:00:00+00:00",
    };
    const yamlLines = Object.entries(fm)
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
      .join("\n");
    fs.mkdirSync(path.dirname(taskPath), { recursive: true });
    fs.writeFileSync(taskPath, `---\n${yamlLines}\n---\n`, "utf-8");
    const rec = await buildRecord(taskPath, root);
    expect(rec.status).toBe("ready");
  });

  test("project item has null status", async () => {
    const root = makeTmpDir();
    const projPath = path.join(root, "projects/myproj/project.md");
    fs.mkdirSync(path.dirname(projPath), { recursive: true });
    const content = `---\nqualified_id: "myproj"\nid: "myproj"\ntitle: "My project"\ncreated_at: "2024-01-01T00:00:00+00:00"\nupdated_at: "2024-01-01T00:00:00+00:00"\n---\n`;
    fs.writeFileSync(projPath, content, "utf-8");
    const rec = await buildRecord(projPath, root);
    expect(rec.status).toBeNull();
    expect(rec.type).toBe("project");
  });

  test("depends_on and tags are read from frontmatter", async () => {
    const root = makeTmpDir();
    const taskPath = path.join(
      root,
      "projects/myproj/epics/backlog/stories/1/tasks/1.md"
    );
    fs.mkdirSync(path.dirname(taskPath), { recursive: true });
    const content = [
      "---",
      'qualified_id: "myproj:backlog:1:1"',
      'id: "1"',
      'title: "Task with deps"',
      'status: "ready"',
      'created_at: "2024-01-01T00:00:00+00:00"',
      'updated_at: "2024-01-01T00:00:00+00:00"',
      "depends_on:",
      '  - "myproj:backlog:1:2"',
      "tags:",
      '  - "urgent"',
      "---",
      "",
    ].join("\n");
    fs.writeFileSync(taskPath, content, "utf-8");
    const rec = await buildRecord(taskPath, root);
    expect(rec.depends_on).toEqual(["myproj:backlog:1:2"]);
    expect(rec.tags).toEqual(["urgent"]);
  });

  test("body_hash matches sha256 of raw file bytes", async () => {
    const root = makeTmpDir();
    const taskPath = path.join(
      root,
      "projects/myproj/epics/backlog/stories/1/tasks/1.md"
    );
    writeItem(taskPath);
    const rec = await buildRecord(taskPath, root);
    const expectedHash = await hashFileBytes(taskPath);
    expect(rec.body_hash).toBe(expectedHash);
  });

  test("file_path is relative to root", async () => {
    const root = makeTmpDir();
    const taskPath = path.join(
      root,
      "projects/myproj/epics/backlog/stories/1/tasks/1.md"
    );
    writeItem(taskPath);
    const rec = await buildRecord(taskPath, root);
    expect(rec.file_path).toBe("projects/myproj/epics/backlog/stories/1/tasks/1.md");
  });
});
