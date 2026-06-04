/**
 * Tests for web/lib/validation.ts — validate() emits the correct KIND_* for
 * each inconsistency class.
 */

import { describe, test, expect } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  validate,
  KIND_BROKEN_DEP,
  KIND_DRIFT,
  KIND_PATH_ID_MISMATCH,
  KIND_TYPE_MISMATCH,
  KIND_PARSE_ERROR,
  KIND_STRAY_FILE,
  KIND_MISSING_FIELD,
  KIND_NOT_INDEXED,
  KIND_ORPHAN_INDEX,
} from "./validation";
import { Index, initDb, DB_FILENAME } from "./index";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "loom-validation-test-"));
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
// KIND constants are exported strings
// ---------------------------------------------------------------------------

describe("KIND_* constants", () => {
  test("KIND_BROKEN_DEP is 'broken_dep'", () => {
    expect(KIND_BROKEN_DEP).toBe("broken_dep");
  });
  test("KIND_DRIFT is 'drift'", () => {
    expect(KIND_DRIFT).toBe("drift");
  });
  test("KIND_PATH_ID_MISMATCH is 'path_id_mismatch'", () => {
    expect(KIND_PATH_ID_MISMATCH).toBe("path_id_mismatch");
  });
  test("KIND_TYPE_MISMATCH is 'type_mismatch'", () => {
    expect(KIND_TYPE_MISMATCH).toBe("type_mismatch");
  });
  test("KIND_PARSE_ERROR is 'parse_error'", () => {
    expect(KIND_PARSE_ERROR).toBe("parse_error");
  });
  test("KIND_STRAY_FILE is 'stray_file'", () => {
    expect(KIND_STRAY_FILE).toBe("stray_file");
  });
  test("KIND_MISSING_FIELD is 'missing_field'", () => {
    expect(KIND_MISSING_FIELD).toBe("missing_field");
  });
  test("KIND_NOT_INDEXED is 'not_indexed'", () => {
    expect(KIND_NOT_INDEXED).toBe("not_indexed");
  });
  test("KIND_ORPHAN_INDEX is 'orphan_index'", () => {
    expect(KIND_ORPHAN_INDEX).toBe("orphan_index");
  });
});

// ---------------------------------------------------------------------------
// validate()
// ---------------------------------------------------------------------------

describe("validate", () => {
  test("returns empty issues for a clean in-sync loom dir", async () => {
    const root = makeTmpDir();
    initDb(path.join(root, DB_FILENAME));
    const taskP = taskPath(root);
    writeItem(taskP);
    // Index the item
    const { buildRecord } = await import("./scan");
    const idx = new Index(root);
    idx.applyRecord(await buildRecord(taskP, root));
    const issues = await validate(root);
    expect(issues).toEqual([]);
  });

  test("emits KIND_NOT_INDEXED for a file that exists on disk but not in index", async () => {
    const root = makeTmpDir();
    initDb(path.join(root, DB_FILENAME));
    writeItem(taskPath(root));
    const issues = await validate(root);
    const kinds = issues.map((i) => i.kind);
    expect(kinds).toContain(KIND_NOT_INDEXED);
  });

  test("emits KIND_ORPHAN_INDEX for an indexed item with no file", async () => {
    const root = makeTmpDir();
    initDb(path.join(root, DB_FILENAME));
    const taskP = taskPath(root);
    writeItem(taskP);
    const { buildRecord } = await import("./scan");
    const idx = new Index(root);
    idx.applyRecord(await buildRecord(taskP, root));
    // Delete the file — index entry remains
    fs.unlinkSync(taskP);
    const issues = await validate(root);
    const kinds = issues.map((i) => i.kind);
    expect(kinds).toContain(KIND_ORPHAN_INDEX);
  });

  test("emits KIND_DRIFT when file content differs from indexed body_hash", async () => {
    const root = makeTmpDir();
    initDb(path.join(root, DB_FILENAME));
    const taskP = taskPath(root);
    writeItem(taskP);
    const { buildRecord } = await import("./scan");
    const idx = new Index(root);
    idx.applyRecord(await buildRecord(taskP, root));
    // Modify file without re-indexing
    fs.appendFileSync(taskP, "\nextra line\n");
    const issues = await validate(root);
    const kinds = issues.map((i) => i.kind);
    expect(kinds).toContain(KIND_DRIFT);
  });

  test("emits KIND_PATH_ID_MISMATCH when frontmatter qualified_id != path-derived", async () => {
    const root = makeTmpDir();
    initDb(path.join(root, DB_FILENAME));
    const taskP = taskPath(root);
    // Write with wrong qualified_id
    writeItem(taskP, { qualified_id: "wrong:backlog:1:1" });
    const issues = await validate(root);
    const kinds = issues.map((i) => i.kind);
    expect(kinds).toContain(KIND_PATH_ID_MISMATCH);
  });

  test("emits KIND_TYPE_MISMATCH when frontmatter type != path-derived type", async () => {
    const root = makeTmpDir();
    initDb(path.join(root, DB_FILENAME));
    const taskP = taskPath(root);
    writeItem(taskP, { type: "story" }); // path says task, fm says story
    const issues = await validate(root);
    const kinds = issues.map((i) => i.kind);
    expect(kinds).toContain(KIND_TYPE_MISMATCH);
  });

  test("emits KIND_MISSING_FIELD when title is absent", async () => {
    const root = makeTmpDir();
    initDb(path.join(root, DB_FILENAME));
    const taskP = taskPath(root);
    const content = `---\nqualified_id: "myproj:backlog:1:1"\nid: "1"\nstatus: "ready"\ncreated_at: "2024-01-01T00:00:00+00:00"\nupdated_at: "2024-01-01T00:00:00+00:00"\n---\n`;
    fs.mkdirSync(path.dirname(taskP), { recursive: true });
    fs.writeFileSync(taskP, content, "utf-8");
    const issues = await validate(root);
    const missing = issues.filter((i) => i.kind === KIND_MISSING_FIELD);
    expect(missing.some((i) => i.message.includes("title"))).toBe(true);
  });

  test("emits KIND_MISSING_FIELD for missing status on non-project", async () => {
    const root = makeTmpDir();
    initDb(path.join(root, DB_FILENAME));
    const taskP = taskPath(root);
    const content = `---\nqualified_id: "myproj:backlog:1:1"\nid: "1"\ntitle: "T"\ncreated_at: "2024-01-01T00:00:00+00:00"\nupdated_at: "2024-01-01T00:00:00+00:00"\n---\n`;
    fs.mkdirSync(path.dirname(taskP), { recursive: true });
    fs.writeFileSync(taskP, content, "utf-8");
    const issues = await validate(root);
    const missing = issues.filter((i) => i.kind === KIND_MISSING_FIELD);
    expect(missing.some((i) => i.message.includes("status"))).toBe(true);
  });

  test("emits KIND_BROKEN_DEP when depends_on target is not indexed", async () => {
    const root = makeTmpDir();
    initDb(path.join(root, DB_FILENAME));
    const taskP = taskPath(root);
    // Write with a dep that doesn't exist
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
    fs.mkdirSync(path.dirname(taskP), { recursive: true });
    fs.writeFileSync(taskP, content, "utf-8");
    // Index via replaceAll so broken dep doesn't cause FK constraint failure
    const { buildRecord } = await import("./scan");
    const idx = new Index(root);
    idx.replaceAll([await buildRecord(taskP, root)]);
    const issues = await validate(root);
    const kinds = issues.map((i) => i.kind);
    expect(kinds).toContain(KIND_BROKEN_DEP);
  });

  test("emits KIND_STRAY_FILE for a .md file outside canonical layout", async () => {
    const root = makeTmpDir();
    initDb(path.join(root, DB_FILENAME));
    // Write a file directly under projects/<proj>/ (not in canonical spot)
    const strayPath = path.join(root, "projects/myproj/stray.md");
    fs.mkdirSync(path.dirname(strayPath), { recursive: true });
    fs.writeFileSync(strayPath, "# stray\n", "utf-8");
    const issues = await validate(root);
    const kinds = issues.map((i) => i.kind);
    expect(kinds).toContain(KIND_STRAY_FILE);
  });

  test("emits KIND_PARSE_ERROR for a file with malformed YAML frontmatter", async () => {
    const root = makeTmpDir();
    initDb(path.join(root, DB_FILENAME));
    const taskP = taskPath(root);
    fs.mkdirSync(path.dirname(taskP), { recursive: true });
    fs.writeFileSync(taskP, "---\nbad: : yaml\n---\n", "utf-8");
    const issues = await validate(root);
    const kinds = issues.map((i) => i.kind);
    expect(kinds).toContain(KIND_PARSE_ERROR);
  });

  test("ValidationIssue has kind, qualified_id, file_path, message fields", async () => {
    const root = makeTmpDir();
    initDb(path.join(root, DB_FILENAME));
    writeItem(taskPath(root));
    const issues = await validate(root);
    expect(issues.length).toBeGreaterThan(0);
    const issue = issues[0]!;
    expect(typeof issue.kind).toBe("string");
    expect("qualified_id" in issue).toBe(true);
    expect("file_path" in issue).toBe(true);
    expect(typeof issue.message).toBe("string");
  });
});
