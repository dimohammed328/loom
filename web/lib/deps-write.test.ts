/**
 * Tests for deps.ts — write-side: addDependency, removeDependency,
 * topologicalSort, descendants.
 */

import { describe, test, expect } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Index, IndexRecord, initDb, DB_FILENAME } from "./index";
import {
  addDependency,
  removeDependency,
  topologicalSort,
  descendants,
} from "./deps";
import { NotFound, LoomError, CycleError } from "./errors";
import { rebuild } from "./rebuild";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "loom-deps-write-test-"));
}

function writeTaskFile(
  root: string,
  storyN: number,
  taskN: number,
  overrides: Record<string, unknown> = {}
): string {
  const filePath = path.join(
    root,
    `projects/p/epics/backlog/stories/${storyN}/tasks/${taskN}.md`
  );
  const qid = `p:backlog:${storyN}:${taskN}`;
  const fm: Record<string, unknown> = {
    schema_version: 3,
    id: String(taskN),
    qualified_id: qid,
    type: "task",
    title: `Task ${taskN}`,
    status: "ready",
    created_at: "2024-01-01T00:00:00+00:00",
    updated_at: "2024-01-01T00:00:00+00:00",
    ...overrides,
  };
  const lines: string[] = [];
  for (const [k, v] of Object.entries(fm)) {
    if (Array.isArray(v)) {
      lines.push(`${k}:`);
      for (const item of v) lines.push(`  - "${item}"`);
    } else {
      lines.push(`${k}: ${JSON.stringify(v)}`);
    }
  }
  const content = `---\n${lines.join("\n")}\n---\n`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
  return filePath;
}

async function buildRoot(
  root: string,
  tasks: Array<{ story?: number; task: number; overrides?: Record<string, unknown> }>
): Promise<void> {
  for (const t of tasks) {
    writeTaskFile(root, t.story ?? 1, t.task, t.overrides ?? {});
  }
  await rebuild(root);
}

// ---------------------------------------------------------------------------
// addDependency
// ---------------------------------------------------------------------------

describe("addDependency", () => {
  test("adds dep edge: source frontmatter updated and index synced", async () => {
    const root = makeTmpDir();
    await buildRoot(root, [{ task: 1 }, { task: 2 }]);
    await addDependency(root, "p:backlog:1:2", "p:backlog:1:1");
    const idx = new Index(root);
    expect(idx.dependenciesOf("p:backlog:1:2")).toContain("p:backlog:1:1");
  });

  test("is idempotent: adding same dep twice is a no-op", async () => {
    const root = makeTmpDir();
    await buildRoot(root, [{ task: 1 }, { task: 2 }]);
    await addDependency(root, "p:backlog:1:2", "p:backlog:1:1");
    await addDependency(root, "p:backlog:1:2", "p:backlog:1:1");
    const idx = new Index(root);
    const deps = idx.dependenciesOf("p:backlog:1:2");
    expect(deps.filter((d) => d === "p:backlog:1:1")).toHaveLength(1);
  });

  test("rejects unknown source", async () => {
    const root = makeTmpDir();
    await buildRoot(root, [{ task: 1 }]);
    await expect(addDependency(root, "p:backlog:1:99", "p:backlog:1:1")).rejects.toThrow(NotFound);
  });

  test("rejects unknown target", async () => {
    const root = makeTmpDir();
    await buildRoot(root, [{ task: 1 }]);
    await expect(addDependency(root, "p:backlog:1:1", "p:backlog:1:99")).rejects.toThrow(NotFound);
  });

  test("rejects self-dependency", async () => {
    const root = makeTmpDir();
    await buildRoot(root, [{ task: 1 }]);
    await expect(addDependency(root, "p:backlog:1:1", "p:backlog:1:1")).rejects.toThrow(LoomError);
  });

  test("rejects cycle", async () => {
    const root = makeTmpDir();
    await buildRoot(root, [{ task: 1 }, { task: 2 }]);
    await addDependency(root, "p:backlog:1:2", "p:backlog:1:1");
    await expect(addDependency(root, "p:backlog:1:1", "p:backlog:1:2")).rejects.toThrow(CycleError);
  });

  test("rejects depending on a project", async () => {
    const root = makeTmpDir();
    // Create a minimal project.md
    const projPath = path.join(root, "projects/p/project.md");
    fs.mkdirSync(path.dirname(projPath), { recursive: true });
    fs.writeFileSync(projPath, [
      "---",
      'schema_version: 3',
      'id: "p"',
      'qualified_id: "p"',
      'type: "project"',
      'title: "P"',
      'created_at: "2024-01-01T00:00:00+00:00"',
      'updated_at: "2024-01-01T00:00:00+00:00"',
      "---",
      "",
    ].join("\n"), "utf-8");
    writeTaskFile(root, 1, 1);
    await rebuild(root);
    await expect(addDependency(root, "p:backlog:1:1", "p")).rejects.toThrow(LoomError);
  });

  test("rejects project as source", async () => {
    const root = makeTmpDir();
    const projPath = path.join(root, "projects/p/project.md");
    fs.mkdirSync(path.dirname(projPath), { recursive: true });
    fs.writeFileSync(projPath, [
      "---",
      'schema_version: 3',
      'id: "p"',
      'qualified_id: "p"',
      'type: "project"',
      'title: "P"',
      'created_at: "2024-01-01T00:00:00+00:00"',
      'updated_at: "2024-01-01T00:00:00+00:00"',
      "---",
      "",
    ].join("\n"), "utf-8");
    writeTaskFile(root, 1, 1);
    await rebuild(root);
    await expect(addDependency(root, "p", "p:backlog:1:1")).rejects.toThrow(LoomError);
  });

  test("persists depends_on to the markdown file", async () => {
    const root = makeTmpDir();
    await buildRoot(root, [{ task: 1 }, { task: 2 }]);
    await addDependency(root, "p:backlog:1:2", "p:backlog:1:1");
    const content = fs.readFileSync(
      path.join(root, "projects/p/epics/backlog/stories/1/tasks/2.md"),
      "utf-8"
    );
    expect(content).toContain("p:backlog:1:1");
    expect(content).toContain("depends_on");
  });
});

// ---------------------------------------------------------------------------
// removeDependency
// ---------------------------------------------------------------------------

describe("removeDependency", () => {
  test("removes existing dep edge and syncs index", async () => {
    const root = makeTmpDir();
    await buildRoot(root, [{ task: 1 }, { task: 2 }]);
    await addDependency(root, "p:backlog:1:2", "p:backlog:1:1");
    await removeDependency(root, "p:backlog:1:2", "p:backlog:1:1");
    const idx = new Index(root);
    expect(idx.dependenciesOf("p:backlog:1:2")).not.toContain("p:backlog:1:1");
  });

  test("raises NotFound when edge does not exist", async () => {
    const root = makeTmpDir();
    await buildRoot(root, [{ task: 1 }, { task: 2 }]);
    await expect(
      removeDependency(root, "p:backlog:1:2", "p:backlog:1:1")
    ).rejects.toThrow(NotFound);
  });

  test("raises NotFound when source does not exist", async () => {
    const root = makeTmpDir();
    await buildRoot(root, [{ task: 1 }]);
    await expect(
      removeDependency(root, "p:backlog:1:99", "p:backlog:1:1")
    ).rejects.toThrow(NotFound);
  });

  test("persists removal to the markdown file", async () => {
    const root = makeTmpDir();
    await buildRoot(root, [{ task: 1 }, { task: 2 }]);
    await addDependency(root, "p:backlog:1:2", "p:backlog:1:1");
    await removeDependency(root, "p:backlog:1:2", "p:backlog:1:1");
    const content = fs.readFileSync(
      path.join(root, "projects/p/epics/backlog/stories/1/tasks/2.md"),
      "utf-8"
    );
    // depends_on list should be empty or absent
    expect(content).not.toMatch(/depends_on:\s*\n\s*- /);
  });
});

// ---------------------------------------------------------------------------
// topologicalSort
// ---------------------------------------------------------------------------

describe("topologicalSort", () => {
  test("empty list returns empty", () => {
    const dir = makeTmpDir();
    initDb(path.join(dir, DB_FILENAME));
    const idx = new Index(dir);
    expect(topologicalSort([], idx)).toEqual([]);
  });

  test("single item with no deps", () => {
    const dir = makeTmpDir();
    initDb(path.join(dir, DB_FILENAME));
    const idx = new Index(dir);
    const rec: IndexRecord = {
      qualified_id: "p:backlog:1:1", type: "task", project: "p",
      epic: "backlog", story: 1, task: 1, parent_id: "p:backlog:1",
      title: "T", status: "ready", assignee: null, branch: null, pr_url: null,
      repo: null, default_branch: null, archived: false,
      created_at: "2024-01-01T00:00:00+00:00", updated_at: "2024-01-01T00:00:00+00:00",
      file_path: "projects/p/epics/backlog/stories/1/tasks/1.md",
      body_hash: "h1", frontmatter_json: "{}", depends_on: [], tags: [],
    };
    idx.applyRecord(rec);
    const sorted = topologicalSort([rec], idx);
    expect(sorted).toHaveLength(1);
    expect(sorted[0]!.qualified_id).toBe("p:backlog:1:1");
  });

  test("dep comes before dependent in sort order", () => {
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
      frontmatter_json: JSON.stringify({ depends_on: ["p:backlog:1:1"] }),
    };
    idx.applyRecord(a);
    idx.applyRecord(b);
    const sorted = topologicalSort([b, a], idx);
    const aIdx = sorted.findIndex((r) => r.qualified_id === "p:backlog:1:1");
    const bIdx = sorted.findIndex((r) => r.qualified_id === "p:backlog:1:2");
    expect(aIdx).toBeLessThan(bIdx);
  });

  test("items at same dep-rank sorted by qualified_id", () => {
    const dir = makeTmpDir();
    initDb(path.join(dir, DB_FILENAME));
    const idx = new Index(dir);
    const base: IndexRecord = {
      qualified_id: "p:backlog:1:1", type: "task", project: "p",
      epic: "backlog", story: 1, task: 1, parent_id: "p:backlog:1",
      title: "A", status: "ready", assignee: null, branch: null, pr_url: null,
      repo: null, default_branch: null, archived: false,
      created_at: "2024-01-01T00:00:00+00:00", updated_at: "2024-01-01T00:00:00+00:00",
      file_path: "projects/p/epics/backlog/stories/1/tasks/1.md",
      body_hash: "h1", frontmatter_json: "{}", depends_on: [], tags: [],
    };
    const b: IndexRecord = { ...base, qualified_id: "p:backlog:1:2", task: 2, title: "B", file_path: "projects/p/epics/backlog/stories/1/tasks/2.md", body_hash: "h2" };
    const c: IndexRecord = { ...base, qualified_id: "p:backlog:1:3", task: 3, title: "C", file_path: "projects/p/epics/backlog/stories/1/tasks/3.md", body_hash: "h3" };
    for (const r of [base, b, c]) idx.applyRecord(r);
    const sorted = topologicalSort([c, base, b], idx);
    // All at same rank (no deps), should be sorted by qid
    expect(sorted.map((r) => r.qualified_id)).toEqual([
      "p:backlog:1:1", "p:backlog:1:2", "p:backlog:1:3",
    ]);
  });
});

// ---------------------------------------------------------------------------
// descendants
// ---------------------------------------------------------------------------

describe("descendants", () => {
  test("returns empty for leaf item with no children", () => {
    const dir = makeTmpDir();
    initDb(path.join(dir, DB_FILENAME));
    const idx = new Index(dir);
    const rec: IndexRecord = {
      qualified_id: "p:backlog:1:1", type: "task", project: "p",
      epic: "backlog", story: 1, task: 1, parent_id: "p:backlog:1",
      title: "T", status: "ready", assignee: null, branch: null, pr_url: null,
      repo: null, default_branch: null, archived: false,
      created_at: "2024-01-01T00:00:00+00:00", updated_at: "2024-01-01T00:00:00+00:00",
      file_path: "projects/p/epics/backlog/stories/1/tasks/1.md",
      body_hash: "h1", frontmatter_json: "{}", depends_on: [], tags: [],
    };
    idx.applyRecord(rec);
    expect(descendants(idx, "p:backlog:1:1")).toEqual([]);
  });

  test("returns all items under parent qid", async () => {
    const root = makeTmpDir();
    await buildRoot(root, [{ task: 1 }, { task: 2 }, { task: 3 }]);
    const idx = new Index(root);
    const desc = descendants(idx, "p:backlog:1");
    const qids = desc.map((r) => r.qualified_id).sort();
    expect(qids).toEqual(["p:backlog:1:1", "p:backlog:1:2", "p:backlog:1:3"]);
  });

  test("only includes items that start with parent qid prefix", async () => {
    const root = makeTmpDir();
    // story 1 and story 2
    await buildRoot(root, [
      { story: 1, task: 1 },
      { story: 1, task: 2 },
      { story: 2, task: 1, overrides: { qualified_id: "p:backlog:2:1", id: "1", title: "Story2Task1" } },
    ]);
    const idx = new Index(root);
    const desc = descendants(idx, "p:backlog:1");
    const qids = desc.map((r) => r.qualified_id).sort();
    expect(qids).toEqual(["p:backlog:1:1", "p:backlog:1:2"]);
    expect(qids).not.toContain("p:backlog:2:1");
  });
});
