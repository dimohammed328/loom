/**
 * Tests for concrete Project/Epic/Story/Task item classes and
 * nextSequentialId sequential-id allocation (including archive scanning).
 */

import { describe, test, expect } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { rebuild } from "./rebuild";
import { Index } from "./index";
import { Project, Epic, Story, Task, itemFromRecord, nextSequentialId } from "./items";
import { QualifiedId, ItemType } from "./ids";
import { Duplicate, LoomError } from "./errors";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "loom-concrete-test-"));
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
}

function makeProjectContent(name: string): string {
  return [
    "---",
    "schema_version: 3",
    `id: "${name}"`,
    `qualified_id: "${name}"`,
    'type: "project"',
    `title: "Project ${name}"`,
    'created_at: "2024-01-01T00:00:00+00:00"',
    'updated_at: "2024-01-01T00:00:00+00:00"',
    "---\n",
  ].join("\n");
}

/**
 * Build a minimal initialized root: one project + backlog epic.
 * Returns a Project item.
 */
async function buildProject(root: string, name = "p"): Promise<Project> {
  // Write project.md
  writeFile(
    path.join(root, `projects/${name}/project.md`),
    makeProjectContent(name)
  );
  // Write backlog epic
  writeFile(
    path.join(root, `projects/${name}/epics/backlog/epic.md`),
    [
      "---",
      "schema_version: 3",
      'id: "backlog"',
      `qualified_id: "${name}:backlog"`,
      'type: "epic"',
      'title: "Backlog"',
      'status: "ready"',
      'created_at: "2024-01-01T00:00:00+00:00"',
      'updated_at: "2024-01-01T00:00:00+00:00"',
      "---\n",
    ].join("\n")
  );
  await rebuild(root);
  const idx = new Index(root);
  const rec = idx.get(name);
  if (!rec) throw new Error("project not indexed");
  return itemFromRecord(root, rec) as Project;
}

// ---------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------

describe("Project", () => {
  test("repo and defaultBranch accessors", async () => {
    const root = makeTmpDir();
    writeFile(path.join(root, "projects/p/project.md"), [
      "---",
      "schema_version: 3",
      'id: "p"',
      'qualified_id: "p"',
      'type: "project"',
      'title: "P"',
      'repo: "https://github.com/org/repo"',
      'default_branch: "main"',
      'created_at: "2024-01-01T00:00:00+00:00"',
      'updated_at: "2024-01-01T00:00:00+00:00"',
      "---\n",
    ].join("\n"));
    await rebuild(root);
    const idx = new Index(root);
    const project = itemFromRecord(root, idx.get("p")!) as Project;
    expect(project.repo).toBe("https://github.com/org/repo");
    expect(project.defaultBranch).toBe("main");
  });

  test("setRepo and setDefaultBranch round-trip", async () => {
    const root = makeTmpDir();
    const project = await buildProject(root);
    project.setRepo("https://example.com/repo");
    expect(project.repo).toBe("https://example.com/repo");
    project.setDefaultBranch("develop");
    expect(project.defaultBranch).toBe("develop");
    // Clear
    project.setRepo(null);
    expect(project.repo).toBeNull();
  });

  test("createEpic creates an epic with a random id", async () => {
    const root = makeTmpDir();
    const project = await buildProject(root);
    const epic = await project.createEpic({ title: "My Epic" });
    expect(epic).toBeInstanceOf(Epic);
    expect(epic.title).toBe("My Epic");
    expect(epic.qualifiedId).toMatch(/^p:[a-z2-9]{7}$/);
  });

  test("createEpic with explicit epicId uses that id", async () => {
    const root = makeTmpDir();
    const project = await buildProject(root);
    const epic = await project.createEpic({ title: "E", epicId: "aaaaaaa" });
    expect(epic.qualifiedId).toBe("p:aaaaaaa");
  });

  test("createEpic with duplicate epicId throws Duplicate", async () => {
    const root = makeTmpDir();
    const project = await buildProject(root);
    await project.createEpic({ title: "E", epicId: "aaaaaaa" });
    await expect(project.createEpic({ title: "E2", epicId: "aaaaaaa" })).rejects.toThrow(Duplicate);
  });

  test("epics() returns all epics under project", async () => {
    const root = makeTmpDir();
    const project = await buildProject(root);
    await project.createEpic({ title: "E1" });
    await project.createEpic({ title: "E2" });
    const epics = project.epics();
    // includes backlog + 2 new ones
    expect(epics.length).toBeGreaterThanOrEqual(3);
    expect(epics.every((e) => e instanceof Epic)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Epic.createStory
// ---------------------------------------------------------------------------

describe("Epic.createStory", () => {
  test("creates a story with sequential id starting at 1", async () => {
    const root = makeTmpDir();
    const project = await buildProject(root);
    const epic = await project.createEpic({ title: "E" });
    const story = await epic.createStory({ title: "Story 1" });
    expect(story).toBeInstanceOf(Story);
    expect(story.title).toBe("Story 1");
    expect(story.qualifiedId).toMatch(/:1$/);
  });

  test("sequential ids increment: 1, 2, 3", async () => {
    const root = makeTmpDir();
    const project = await buildProject(root);
    const epic = await project.createEpic({ title: "E" });
    const s1 = await epic.createStory({ title: "S1" });
    const s2 = await epic.createStory({ title: "S2" });
    const s3 = await epic.createStory({ title: "S3" });
    expect(s1.qualifiedId).toMatch(/:1$/);
    expect(s2.qualifiedId).toMatch(/:2$/);
    expect(s3.qualifiedId).toMatch(/:3$/);
  });

  test("stories() returns all stories under epic", async () => {
    const root = makeTmpDir();
    const project = await buildProject(root);
    const epic = await project.createEpic({ title: "E" });
    await epic.createStory({ title: "S1" });
    await epic.createStory({ title: "S2" });
    expect(epic.stories()).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Story.createTask
// ---------------------------------------------------------------------------

describe("Story.createTask", () => {
  test("creates a task with sequential id starting at 1", async () => {
    const root = makeTmpDir();
    const project = await buildProject(root);
    const epic = await project.createEpic({ title: "E" });
    const story = await epic.createStory({ title: "S" });
    const task = await story.createTask({ title: "T1" });
    expect(task).toBeInstanceOf(Task);
    expect(task.title).toBe("T1");
    expect(task.qualifiedId).toMatch(/:1$/);
  });

  test("task sequential ids increment: 1, 2, 3", async () => {
    const root = makeTmpDir();
    const project = await buildProject(root);
    const epic = await project.createEpic({ title: "E" });
    const story = await epic.createStory({ title: "S" });
    const t1 = await story.createTask({ title: "T1" });
    const t2 = await story.createTask({ title: "T2" });
    const t3 = await story.createTask({ title: "T3" });
    expect(t1.qualifiedId).toMatch(/:1$/);
    expect(t2.qualifiedId).toMatch(/:2$/);
    expect(t3.qualifiedId).toMatch(/:3$/);
  });

  test("tasks() returns all tasks under story", async () => {
    const root = makeTmpDir();
    const project = await buildProject(root);
    const epic = await project.createEpic({ title: "E" });
    const story = await epic.createStory({ title: "S" });
    await story.createTask({ title: "T1" });
    await story.createTask({ title: "T2" });
    expect(story.tasks()).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// nextSequentialId — scans both live and archived
// ---------------------------------------------------------------------------

describe("nextSequentialId — archive scanning", () => {
  test("skips archived story id and allocates next available", async () => {
    const root = makeTmpDir();
    const project = await buildProject(root);
    const epic = await project.createEpic({ title: "E", epicId: "aaaaaaa" });
    // Create story 1 and then archive it
    const story1 = await epic.createStory({ title: "S1" });
    story1.archive();
    // Now allocate a new story — must be 2, not 1
    const epicQid = new QualifiedId("p", "aaaaaaa");
    const nextId = nextSequentialId(root, epicQid, ItemType.STORY);
    expect(nextId).toBe(2);
  });

  test("skips archived task id and allocates next available", async () => {
    const root = makeTmpDir();
    const project = await buildProject(root);
    const epic = await project.createEpic({ title: "E", epicId: "aaaaaaa" });
    const story = await epic.createStory({ title: "S" });
    // Create and archive task 1
    const t1 = await story.createTask({ title: "T1" });
    t1.archive();
    // Next task should be 2, not 1
    const storyQid = new QualifiedId("p", "aaaaaaa", 1);
    const nextId = nextSequentialId(root, storyQid, ItemType.TASK);
    expect(nextId).toBe(2);
  });

  test("with no children at all, returns 1", async () => {
    const root = makeTmpDir();
    const project = await buildProject(root);
    const epic = await project.createEpic({ title: "E", epicId: "bbbbbbb" });
    const epicQid = new QualifiedId("p", "bbbbbbb");
    expect(nextSequentialId(root, epicQid, ItemType.STORY)).toBe(1);
  });

  test("does not shadow archived sibling when creating multiple", async () => {
    const root = makeTmpDir();
    const project = await buildProject(root);
    const epic = await project.createEpic({ title: "E", epicId: "ccccccc" });
    const s1 = await epic.createStory({ title: "S1" });
    const s2 = await epic.createStory({ title: "S2" });
    s2.archive();
    // Archive story 2; next new story should be 3
    const epicQid = new QualifiedId("p", "ccccccc");
    expect(nextSequentialId(root, epicQid, ItemType.STORY)).toBe(3);
  });
});
