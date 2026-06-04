/**
 * Tests for items.ts — Item base class + mutator contract.
 *
 * Covers:
 * - Property accessors (identity, metadata snapshot)
 * - _mutateField (title, body, assignee, branch, pr_url, status)
 * - add_tag / remove_tag
 * - archive
 * - refresh / detachment behavior
 * - item_from_record dispatcher
 */

import { describe, test, expect } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { rebuild } from "./rebuild";
import { Index, DB_FILENAME, initDb } from "./index";
import { Item, itemFromRecord } from "./items";
import { NotFound } from "./errors";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "loom-items-test-"));
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
}

function makeTaskContent(overrides: Record<string, unknown> = {}): string {
  const fm: Record<string, unknown> = {
    schema_version: 3,
    id: "1",
    qualified_id: "p:backlog:1:1",
    type: "task",
    title: "My Task",
    status: "ready",
    created_at: "2024-01-01T00:00:00+00:00",
    updated_at: "2024-01-01T00:00:00+00:00",
    ...overrides,
  };
  const lines: string[] = [];
  for (const [k, v] of Object.entries(fm)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) {
      lines.push(`${k}:`);
      for (const item of v) lines.push(`  - "${item}"`);
    } else {
      lines.push(`${k}: ${JSON.stringify(v)}`);
    }
  }
  return `---\n${lines.join("\n")}\n---\nInitial body.\n`;
}

function taskPath(root: string): string {
  return path.join(root, "projects/p/epics/backlog/stories/1/tasks/1.md");
}

async function setupTask(
  root: string,
  overrides: Record<string, unknown> = {}
): Promise<Item> {
  const p = taskPath(root);
  writeFile(p, makeTaskContent(overrides));
  await rebuild(root);
  const idx = new Index(root);
  const rec = idx.get("p:backlog:1:1");
  if (!rec) throw new Error("task not indexed");
  return itemFromRecord(root, rec);
}

// ---------------------------------------------------------------------------
// Property accessors
// ---------------------------------------------------------------------------

describe("Item property accessors", () => {
  test("qualified_id, type, title, status, archived", async () => {
    const root = makeTmpDir();
    const item = await setupTask(root);
    expect(item.qualifiedId).toBe("p:backlog:1:1");
    expect(item.type).toBe("task");
    expect(item.title).toBe("My Task");
    expect((item as any).status).toBe("ready");
    expect(item.archived).toBe(false);
  });

  test("body lazily loaded on first access", async () => {
    const root = makeTmpDir();
    const item = await setupTask(root);
    expect(item.body).toBe("Initial body.\n");
  });

  test("root, filePath properties", async () => {
    const root = makeTmpDir();
    const item = await setupTask(root);
    expect(item.root).toBe(root);
    expect(item.filePath).toBe(taskPath(root));
  });
});

// ---------------------------------------------------------------------------
// setTitle
// ---------------------------------------------------------------------------

describe("Item.setTitle", () => {
  test("mutates title on disk and in self._record", async () => {
    const root = makeTmpDir();
    const item = await setupTask(root);
    item.setTitle("Updated Title");
    expect(item.title).toBe("Updated Title");
    // Verify file changed
    const content = fs.readFileSync(taskPath(root), "utf-8");
    expect(content).toContain("Updated Title");
  });

  test("index reflects updated title", async () => {
    const root = makeTmpDir();
    const item = await setupTask(root);
    item.setTitle("New Title");
    const idx = new Index(root);
    expect(idx.get("p:backlog:1:1")!.title).toBe("New Title");
  });

  test("returned item is the same instance (not detached)", async () => {
    const root = makeTmpDir();
    const item = await setupTask(root);
    const returned = item.setTitle("Same Instance");
    expect(returned).toBe(item);
  });
});

// ---------------------------------------------------------------------------
// setBody
// ---------------------------------------------------------------------------

describe("Item.setBody", () => {
  test("updates body on disk and clears cache", async () => {
    const root = makeTmpDir();
    const item = await setupTask(root);
    item.setBody("New body.\n");
    expect(item.body).toBe("New body.\n");
    const content = fs.readFileSync(taskPath(root), "utf-8");
    expect(content).toContain("New body.");
  });
});

// ---------------------------------------------------------------------------
// addTag / removeTag
// ---------------------------------------------------------------------------

describe("Item.addTag / removeTag", () => {
  test("addTag appends tag to frontmatter", async () => {
    const root = makeTmpDir();
    const item = await setupTask(root);
    item.addTag("urgent");
    expect(item.tags).toContain("urgent");
    const content = fs.readFileSync(taskPath(root), "utf-8");
    expect(content).toContain("urgent");
  });

  test("addTag is idempotent", async () => {
    const root = makeTmpDir();
    const item = await setupTask(root);
    item.addTag("urgent");
    item.addTag("urgent");
    expect(item.tags.filter((t) => t === "urgent")).toHaveLength(1);
  });

  test("removeTag removes existing tag", async () => {
    const root = makeTmpDir();
    const item = await setupTask(root, { tags: ["urgent", "bug"] });
    item.removeTag("urgent");
    expect(item.tags).not.toContain("urgent");
    expect(item.tags).toContain("bug");
  });

  test("removeTag is no-op when tag absent", async () => {
    const root = makeTmpDir();
    const item = await setupTask(root);
    // Should not throw
    item.removeTag("nonexistent");
    expect(item.tags).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// archive
// ---------------------------------------------------------------------------

describe("Item.archive", () => {
  test("moves file to _archive and updates record", async () => {
    const root = makeTmpDir();
    const item = await setupTask(root);
    item.archive();
    expect(item.archived).toBe(true);
    const archPath = path.join(
      root,
      "_archive/projects/p/epics/backlog/stories/1/tasks/1.md"
    );
    expect(fs.existsSync(archPath)).toBe(true);
    expect(fs.existsSync(taskPath(root))).toBe(false);
  });

  test("archive throws if already archived", async () => {
    const root = makeTmpDir();
    const item = await setupTask(root);
    item.archive();
    expect(() => item.archive()).toThrow();
  });

  test("index reflects archived=true after archive", async () => {
    const root = makeTmpDir();
    const item = await setupTask(root);
    item.archive();
    const idx = new Index(root);
    const rec = idx.get("p:backlog:1:1");
    expect(rec).not.toBeNull();
    expect(rec!.archived).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// refresh — detached snapshot rule
// ---------------------------------------------------------------------------

describe("Item.refresh", () => {
  test("refresh reloads from index after external change", async () => {
    const root = makeTmpDir();
    const item = await setupTask(root);
    // Manually update via index (simulating another handle)
    const p = taskPath(root);
    const content = fs.readFileSync(p, "utf-8").replace('"My Task"', '"External Update"');
    fs.writeFileSync(p, content, "utf-8");
    await rebuild(root);
    // item is stale; refresh should update it
    item.refresh();
    expect(item.title).toBe("External Update");
  });

  test("two independent item objects are detached snapshots of each other", async () => {
    const root = makeTmpDir();
    const item1 = await setupTask(root);
    const item2 = await setupTask(root); // separate object
    item1.setTitle("Updated");
    // item2 is a detached snapshot — not updated automatically
    expect(item2.title).toBe("My Task");
    // but after refresh, item2 sees the new title
    item2.refresh();
    expect(item2.title).toBe("Updated");
  });
});

// ---------------------------------------------------------------------------
// itemFromRecord dispatcher
// ---------------------------------------------------------------------------

describe("itemFromRecord", () => {
  test("returns correct subclass for each type", async () => {
    const root = makeTmpDir();
    // Build a minimal hierarchy: project, epic, story, task
    const files = [
      {
        path: path.join(root, "projects/p/project.md"),
        content: [
          "---",
          'schema_version: 3',
          'id: "p"',
          'qualified_id: "p"',
          'type: "project"',
          'title: "P"',
          'created_at: "2024-01-01T00:00:00+00:00"',
          'updated_at: "2024-01-01T00:00:00+00:00"',
          "---\n",
        ].join("\n"),
      },
      {
        path: path.join(root, "projects/p/epics/backlog/epic.md"),
        content: [
          "---",
          'schema_version: 3',
          'id: "backlog"',
          'qualified_id: "p:backlog"',
          'type: "epic"',
          'title: "Backlog"',
          'status: "ready"',
          'created_at: "2024-01-01T00:00:00+00:00"',
          'updated_at: "2024-01-01T00:00:00+00:00"',
          "---\n",
        ].join("\n"),
      },
      {
        path: path.join(root, "projects/p/epics/backlog/stories/1/story.md"),
        content: [
          "---",
          'schema_version: 3',
          'id: "1"',
          'qualified_id: "p:backlog:1"',
          'type: "story"',
          'title: "Story 1"',
          'status: "ready"',
          'created_at: "2024-01-01T00:00:00+00:00"',
          'updated_at: "2024-01-01T00:00:00+00:00"',
          "---\n",
        ].join("\n"),
      },
    ];
    for (const f of files) writeFile(f.path, f.content);
    writeFile(taskPath(root), makeTaskContent());
    await rebuild(root);

    const idx = new Index(root);
    const { Project } = await import("./items");
    const { Epic } = await import("./items");
    const { Story } = await import("./items");
    const { Task } = await import("./items");

    const project = itemFromRecord(root, idx.get("p")!);
    const epic = itemFromRecord(root, idx.get("p:backlog")!);
    const story = itemFromRecord(root, idx.get("p:backlog:1")!);
    const task = itemFromRecord(root, idx.get("p:backlog:1:1")!);

    expect(project).toBeInstanceOf(Project);
    expect(epic).toBeInstanceOf(Epic);
    expect(story).toBeInstanceOf(Story);
    expect(task).toBeInstanceOf(Task);
  });
});
