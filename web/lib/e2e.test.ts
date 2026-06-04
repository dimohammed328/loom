/**
 * End-to-end tests covering:
 * 1. Full create chain: project → epic → story → task (library + Loom facade)
 * 2. Mutator detachment: returned items are detached snapshots
 * 3. Archive-id shadowing: sequential ids skip archived siblings
 * 4. Dep semantics: only 'done' satisfies; custom status does not
 * 5. Non-vacuous close_if_children_done for empty containers
 *
 * Mirrors tests/test_e2e.py, tests/test_deps.py, tests/test_rebuild.py
 */

import { describe, test, expect } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { initDb, DB_FILENAME, Index } from "./index";
import { rebuild } from "./rebuild";
import { Loom } from "./loom";
import { Project, Epic, Story, Task, itemFromRecord } from "./items";
import { LoomError } from "./errors";
import { QualifiedId, ItemType } from "./ids";
import { nextSequentialId } from "./items";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-e2e-test-"));
  initDb(path.join(dir, DB_FILENAME));
  return dir;
}

// ---------------------------------------------------------------------------
// 1. Full create chain — library surface
// ---------------------------------------------------------------------------

describe("e2e: full create chain (library)", () => {
  test("project → epic → story → task creates canonical files and index entries", async () => {
    const root = makeTmpDir();
    const loom = new Loom(root);

    const project = await loom.createProject("acme", { title: "Acme Corp" });
    expect(project).toBeInstanceOf(Project);
    expect(project.qualifiedId).toBe("acme");
    expect(loom.index.has("acme:backlog")).toBe(true);

    const epic = await project.createEpic({ title: "Sprint 1", epicId: "aaaaaaa" });
    expect(epic).toBeInstanceOf(Epic);
    expect(epic.qualifiedId).toBe("acme:aaaaaaa");
    expect(fs.existsSync(path.join(root, "projects/acme/epics/aaaaaaa/epic.md"))).toBe(true);

    const story = await epic.createStory({ title: "User auth" });
    expect(story).toBeInstanceOf(Story);
    expect(story.qualifiedId).toBe("acme:aaaaaaa:1");
    expect(fs.existsSync(path.join(root, "projects/acme/epics/aaaaaaa/stories/1/story.md"))).toBe(true);

    const task = await story.createTask({ title: "Write tests" });
    expect(task).toBeInstanceOf(Task);
    expect(task.qualifiedId).toBe("acme:aaaaaaa:1:1");
    expect(
      fs.existsSync(path.join(root, "projects/acme/epics/aaaaaaa/stories/1/tasks/1.md"))
    ).toBe(true);
  });

  test("task status starts as 'ready'", async () => {
    const root = makeTmpDir();
    const loom = new Loom(root);
    const project = await loom.createProject("p", { title: "P" });
    const epic = await project.createEpic({ title: "E" });
    const story = await epic.createStory({ title: "S" });
    const task = await story.createTask({ title: "T" });
    expect(task.status).toBe("ready");
  });

  test("complete task then verify via Loom.get", async () => {
    const root = makeTmpDir();
    const loom = new Loom(root);
    const project = await loom.createProject("p", { title: "P" });
    const epic = await project.createEpic({ title: "E" });
    const story = await epic.createStory({ title: "S" });
    const task = await story.createTask({ title: "T" });
    task.complete();
    const fetched = loom.get(task.qualifiedId) as Task;
    expect(fetched.status).toBe("done");
  });

  test("multiple tasks under same story get sequential ids", async () => {
    const root = makeTmpDir();
    const loom = new Loom(root);
    const project = await loom.createProject("p", { title: "P" });
    const epic = await project.createEpic({ title: "E" });
    const story = await epic.createStory({ title: "S" });
    const t1 = await story.createTask({ title: "T1" });
    const t2 = await story.createTask({ title: "T2" });
    const t3 = await story.createTask({ title: "T3" });
    expect(t1.qualifiedId).toMatch(/:1$/);
    expect(t2.qualifiedId).toMatch(/:2$/);
    expect(t3.qualifiedId).toMatch(/:3$/);
  });
});

// ---------------------------------------------------------------------------
// 2. Mutator detachment — detached snapshot rule
// ---------------------------------------------------------------------------

describe("e2e: mutator detachment", () => {
  test("mutating one handle does not update a separate in-memory copy", async () => {
    const root = makeTmpDir();
    const loom = new Loom(root);
    const project = await loom.createProject("p", { title: "P" });
    const epic = await project.createEpic({ title: "E" });
    const story = await epic.createStory({ title: "S" });
    const task = await story.createTask({ title: "Original" });

    // Second handle obtained before the mutation
    const handle2 = loom.get(task.qualifiedId) as Task;

    task.setTitle("Updated");

    // Same handle reflects the change immediately
    expect(task.title).toBe("Updated");

    // handle2 is a detached snapshot — still shows "Original"
    expect(handle2.title).toBe("Original");

    // After refresh, handle2 catches up
    handle2.refresh();
    expect(handle2.title).toBe("Updated");
  });

  test("setTitle returns same instance", async () => {
    const root = makeTmpDir();
    const loom = new Loom(root);
    const project = await loom.createProject("p", { title: "P" });
    const epic = await project.createEpic({ title: "E" });
    const story = await epic.createStory({ title: "S" });
    const task = await story.createTask({ title: "T" });
    const returned = task.setTitle("New");
    expect(returned).toBe(task);
  });

  test("setBody updates the body on disk and in cache", async () => {
    const root = makeTmpDir();
    const loom = new Loom(root);
    const project = await loom.createProject("p", { title: "P" });
    const epic = await project.createEpic({ title: "E" });
    const story = await epic.createStory({ title: "S" });
    const task = await story.createTask({ title: "T" });
    task.setBody("New body content.\n");
    expect(task.body).toBe("New body content.\n");
    const content = fs.readFileSync(task.filePath, "utf-8");
    expect(content).toContain("New body content.");
  });

  test("add_tag / remove_tag round-trip with detachment", async () => {
    const root = makeTmpDir();
    const loom = new Loom(root);
    const project = await loom.createProject("p", { title: "P" });
    const epic = await project.createEpic({ title: "E" });
    const story = await epic.createStory({ title: "S" });
    const task = await story.createTask({ title: "T" });
    task.addTag("urgent");
    const handle2 = loom.get(task.qualifiedId) as Task;
    expect(handle2.tags).toContain("urgent"); // fresh fetch sees the tag
    task.removeTag("urgent");
    handle2.refresh();
    expect(handle2.tags).not.toContain("urgent");
  });
});

// ---------------------------------------------------------------------------
// 3. Archive-id shadowing — sequential ids skip archived siblings
// ---------------------------------------------------------------------------

describe("e2e: archive-id shadowing", () => {
  test("archiving task 1, then creating new task allocates id 2", async () => {
    const root = makeTmpDir();
    const loom = new Loom(root);
    const project = await loom.createProject("p", { title: "P" });
    const epic = await project.createEpic({ title: "E", epicId: "aaaaaaa" });
    const story = await epic.createStory({ title: "S" });
    const t1 = await story.createTask({ title: "T1" });
    t1.archive();
    const t2 = await story.createTask({ title: "T2" });
    expect(t2.qualifiedId).toMatch(/:2$/);
  });

  test("archiving story 2, next story is 3", async () => {
    const root = makeTmpDir();
    const loom = new Loom(root);
    const project = await loom.createProject("p", { title: "P" });
    const epic = await project.createEpic({ title: "E", epicId: "bbbbbbb" });
    const s1 = await epic.createStory({ title: "S1" });
    const s2 = await epic.createStory({ title: "S2" });
    s2.archive();
    const s3 = await epic.createStory({ title: "S3" });
    expect(s3.qualifiedId).toMatch(/:3$/);
  });

  test("nextSequentialId with only archived children returns max+1", async () => {
    const root = makeTmpDir();
    const loom = new Loom(root);
    const project = await loom.createProject("p", { title: "P" });
    const epic = await project.createEpic({ title: "E", epicId: "ccccccc" });
    const story = await epic.createStory({ title: "S" });
    const t1 = await story.createTask({ title: "T1" });
    const t2 = await story.createTask({ title: "T2" });
    t1.archive();
    t2.archive();
    // Both tasks archived; next id must be 3
    const storyQid = new QualifiedId("p", "ccccccc", 1);
    expect(nextSequentialId(root, storyQid, ItemType.TASK)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 4. Dep semantics — only 'done' satisfies; custom status does not
// ---------------------------------------------------------------------------

describe("e2e: dep semantics", () => {
  test("custom status 'completed' does not satisfy a dependency", async () => {
    const root = makeTmpDir();
    const loom = new Loom(root);
    const project = await loom.createProject("p", { title: "P" });
    const epic = await project.createEpic({ title: "E" });
    const story = await epic.createStory({ title: "S" });
    const t1 = await story.createTask({ title: "T1" });
    const t2 = await story.createTask({ title: "T2" });
    await t2.dependsOn(t1.qualifiedId);

    t1.setStatus("completed"); // custom — not 'done'
    expect(t2.blockers()).toHaveLength(1);
    expect(t2.isPickable()).toBe(false);
  });

  test("'done' status satisfies a dependency", async () => {
    const root = makeTmpDir();
    const loom = new Loom(root);
    const project = await loom.createProject("p", { title: "P" });
    const epic = await project.createEpic({ title: "E" });
    const story = await epic.createStory({ title: "S" });
    const t1 = await story.createTask({ title: "T1" });
    const t2 = await story.createTask({ title: "T2" });
    await t2.dependsOn(t1.qualifiedId);

    t1.complete();
    expect(t2.blockers()).toHaveLength(0);
    expect(t2.isPickable()).toBe(true);
  });

  test("loom.ready() returns only unblocked tasks", async () => {
    const root = makeTmpDir();
    const loom = new Loom(root);
    const project = await loom.createProject("p", { title: "P" });
    const epic = await project.createEpic({ title: "E" });
    const story = await epic.createStory({ title: "S" });
    const t1 = await story.createTask({ title: "T1" });
    const t2 = await story.createTask({ title: "T2" });
    await t2.dependsOn(t1.qualifiedId);

    const readyItems = loom.ready({ type: "task" });
    const qids = readyItems.map((i) => i.qualifiedId);
    expect(qids).toContain(t1.qualifiedId);
    expect(qids).not.toContain(t2.qualifiedId);

    // After completing t1, t2 becomes pickable
    t1.complete();
    const readyAfter = loom.ready({ type: "task" });
    const qidsAfter = readyAfter.map((i) => i.qualifiedId);
    expect(qidsAfter).toContain(t2.qualifiedId);
  });

  test("cycle is rejected when adding dep", async () => {
    const root = makeTmpDir();
    const loom = new Loom(root);
    const project = await loom.createProject("p", { title: "P" });
    const epic = await project.createEpic({ title: "E" });
    const story = await epic.createStory({ title: "S" });
    const t1 = await story.createTask({ title: "T1" });
    const t2 = await story.createTask({ title: "T2" });
    await t2.dependsOn(t1.qualifiedId);
    await expect(t1.dependsOn(t2.qualifiedId)).rejects.toThrow();
  });

  test("depending on a project is forbidden", async () => {
    const root = makeTmpDir();
    const loom = new Loom(root);
    const project = await loom.createProject("p", { title: "P" });
    const epic = await project.createEpic({ title: "E" });
    const story = await epic.createStory({ title: "S" });
    const task = await story.createTask({ title: "T" });
    await expect(task.dependsOn("p")).rejects.toThrow(LoomError);
  });
});

// ---------------------------------------------------------------------------
// 5. Non-vacuous close_if_children_done
// ---------------------------------------------------------------------------

describe("e2e: close_if_children_done", () => {
  test("closes story when all tasks are done", async () => {
    const root = makeTmpDir();
    const loom = new Loom(root);
    const project = await loom.createProject("p", { title: "P" });
    const epic = await project.createEpic({ title: "E" });
    const story = await epic.createStory({ title: "S" });
    const task = await story.createTask({ title: "T" });
    task.complete();
    expect(loom.closeIfChildrenDone(story.qualifiedId)).toBe(true);
    story.refresh();
    expect(story.status).toBe("done");
  });

  test("returns false for empty story (no tasks)", async () => {
    const root = makeTmpDir();
    const loom = new Loom(root);
    const project = await loom.createProject("p", { title: "P" });
    const epic = await project.createEpic({ title: "E" });
    const story = await epic.createStory({ title: "S" });
    expect(loom.closeIfChildrenDone(story.qualifiedId)).toBe(false);
    story.refresh();
    expect(story.status).toBe("ready");
  });

  test("returns false when any child is not done", async () => {
    const root = makeTmpDir();
    const loom = new Loom(root);
    const project = await loom.createProject("p", { title: "P" });
    const epic = await project.createEpic({ title: "E" });
    const story = await epic.createStory({ title: "S" });
    const t1 = await story.createTask({ title: "T1" });
    const t2 = await story.createTask({ title: "T2" });
    t1.complete();
    expect(loom.closeIfChildrenDone(story.qualifiedId)).toBe(false);
  });

  test("throws LoomError for task (no children)", async () => {
    const root = makeTmpDir();
    const loom = new Loom(root);
    const project = await loom.createProject("p", { title: "P" });
    const epic = await project.createEpic({ title: "E" });
    const story = await epic.createStory({ title: "S" });
    const task = await story.createTask({ title: "T" });
    expect(() => loom.closeIfChildrenDone(task.qualifiedId)).toThrow(LoomError);
  });

  test("throws LoomError for project (no status)", async () => {
    const root = makeTmpDir();
    const loom = new Loom(root);
    await loom.createProject("p", { title: "P" });
    expect(() => loom.closeIfChildrenDone("p")).toThrow(LoomError);
  });

  test("close epic when all stories and tasks done", async () => {
    const root = makeTmpDir();
    const loom = new Loom(root);
    const project = await loom.createProject("p", { title: "P" });
    const epic = await project.createEpic({ title: "E" });
    const story = await epic.createStory({ title: "S" });
    const task = await story.createTask({ title: "T" });
    task.complete();
    story.complete();
    expect(loom.closeIfChildrenDone(epic.qualifiedId)).toBe(true);
    epic.refresh();
    expect(epic.status).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// 6. Rebuild round-trip — index rebuilt from files, no data loss
// ---------------------------------------------------------------------------

describe("e2e: rebuild round-trip", () => {
  test("rebuild after create chain recovers all items", async () => {
    const root = makeTmpDir();
    const loom = new Loom(root);
    const project = await loom.createProject("p", { title: "P" });
    const epic = await project.createEpic({ title: "E" });
    const story = await epic.createStory({ title: "S" });
    const task = await story.createTask({ title: "T" });

    const result = await loom.rebuild();
    expect(result.indexed_count).toBeGreaterThanOrEqual(4); // project + backlog + epic + story + task
    expect(loom.index.has(project.qualifiedId)).toBe(true);
    expect(loom.index.has(task.qualifiedId)).toBe(true);
  });

  test("rebuild is idempotent", async () => {
    const root = makeTmpDir();
    const loom = new Loom(root);
    await loom.createProject("p", { title: "P" });
    const r1 = await loom.rebuild();
    const r2 = await loom.rebuild();
    expect(r1.indexed_count).toBe(r2.indexed_count);
  });
});
