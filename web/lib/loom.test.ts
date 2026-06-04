/**
 * Tests for the Loom facade — web/lib/loom.ts.
 *
 * Covers: createProject, get/get_or_none, find, projects, tree, order,
 * statuses, project_status, ready, reopen, close_if_children_done,
 * sync, rebuild, validate, root/index props.
 */

import { describe, test, expect } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Loom } from "./loom";
import { Project, Epic, Story, Task } from "./items";
import { NotFound, Duplicate, LoomError } from "./errors";
import { initDb, DB_FILENAME } from "./index";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-facade-test-"));
  initDb(path.join(dir, DB_FILENAME));
  return dir;
}

async function buildLoomWithProject(
  root: string,
  name = "p"
): Promise<{ loom: Loom; project: Project }> {
  const loom = new Loom(root);
  const project = await loom.createProject(name, { title: `Project ${name}` });
  return { loom, project };
}

// ---------------------------------------------------------------------------
// constructor / root / index
// ---------------------------------------------------------------------------

describe("Loom constructor", () => {
  test("throws LoomError when root does not exist", () => {
    expect(() => new Loom("/nonexistent/path")).toThrow(LoomError);
  });

  test("root property returns the resolved path", () => {
    const root = makeTmpDir();
    const loom = new Loom(root);
    expect(loom.root).toBe(root);
  });

  test("index property is usable", () => {
    const root = makeTmpDir();
    const loom = new Loom(root);
    expect(loom.index).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// createProject
// ---------------------------------------------------------------------------

describe("Loom.createProject", () => {
  test("creates a project and backlog epic", async () => {
    const root = makeTmpDir();
    const loom = new Loom(root);
    const project = await loom.createProject("myproj", { title: "My Project" });
    expect(project).toBeInstanceOf(Project);
    expect(project.title).toBe("My Project");
    // Backlog epic exists
    const idx = loom.index;
    expect(idx.has("myproj:backlog")).toBe(true);
  });

  test("throws Duplicate if project already exists", async () => {
    const root = makeTmpDir();
    const loom = new Loom(root);
    await loom.createProject("dup", { title: "D" });
    await expect(loom.createProject("dup", { title: "D2" })).rejects.toThrow(Duplicate);
  });

  test("sets repo and default_branch when provided", async () => {
    const root = makeTmpDir();
    const loom = new Loom(root);
    const project = await loom.createProject("p2", {
      title: "P2",
      repo: "https://example.com/repo",
      defaultBranch: "main",
    });
    expect(project.repo).toBe("https://example.com/repo");
    expect(project.defaultBranch).toBe("main");
  });
});

// ---------------------------------------------------------------------------
// get / get_or_none
// ---------------------------------------------------------------------------

describe("Loom.get / get_or_none", () => {
  test("get returns the item by qid", async () => {
    const root = makeTmpDir();
    const { loom } = await buildLoomWithProject(root);
    const item = loom.get("p");
    expect(item).toBeInstanceOf(Project);
    expect(item.qualifiedId).toBe("p");
  });

  test("get throws NotFound for unknown qid", () => {
    const root = makeTmpDir();
    const loom = new Loom(root);
    expect(() => loom.get("p:backlog:1:99")).toThrow(NotFound);
  });

  test("get_or_none returns null for unknown qid", () => {
    const root = makeTmpDir();
    const loom = new Loom(root);
    expect(loom.getOrNone("p:backlog:1:99")).toBeNull();
  });

  test("get_or_none returns item when it exists", async () => {
    const root = makeTmpDir();
    const { loom } = await buildLoomWithProject(root);
    expect(loom.getOrNone("p")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// find
// ---------------------------------------------------------------------------

describe("Loom.find", () => {
  test("find by type=project returns projects", async () => {
    const root = makeTmpDir();
    const { loom } = await buildLoomWithProject(root);
    const results = loom.find({ type: "project" });
    expect(results.some((i) => i.qualifiedId === "p")).toBe(true);
  });

  test("find by status filters correctly", async () => {
    const root = makeTmpDir();
    const { loom, project } = await buildLoomWithProject(root);
    const epic = await project.createEpic({ title: "E" });
    const story = await epic.createStory({ title: "S" });
    const task = await story.createTask({ title: "T" });
    task.complete();
    const doneTasks = loom.find({ type: "task", status: "done" });
    expect(doneTasks.some((i) => i.qualifiedId === task.qualifiedId)).toBe(true);
    const readyTasks = loom.find({ type: "task", status: "ready" });
    expect(readyTasks.every((i) => i.qualifiedId !== task.qualifiedId)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// projects
// ---------------------------------------------------------------------------

describe("Loom.projects", () => {
  test("returns list of Project instances", async () => {
    const root = makeTmpDir();
    const { loom } = await buildLoomWithProject(root);
    const ps = loom.projects();
    expect(ps.length).toBeGreaterThanOrEqual(1);
    expect(ps.every((p) => p instanceof Project)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// tree
// ---------------------------------------------------------------------------

describe("Loom.tree", () => {
  test("returns tree rooted at given qid", async () => {
    const root = makeTmpDir();
    const { loom, project } = await buildLoomWithProject(root);
    const epic = await project.createEpic({ title: "E", epicId: "aaaaaaa" });
    const tree = loom.tree("p");
    expect(tree.root).toBe("p");
    expect(tree.items).toBeDefined();
    expect(Array.isArray(tree.items)).toBe(true);
  });

  test("depth=1 limits to root + direct children", async () => {
    const root = makeTmpDir();
    const { loom, project } = await buildLoomWithProject(root);
    const epic = await project.createEpic({ title: "E", epicId: "aaaaaaa" });
    const story = await epic.createStory({ title: "S" });
    const tree = loom.tree("p", { depth: 1 });
    // Should have project + epics, but not stories
    const qids = tree.items.map((i: any) => i.qid);
    expect(qids).toContain("p");
    expect(qids.some((q: string) => q.includes(":backlog") || q.includes(":aaaaaaa"))).toBe(true);
    expect(qids).not.toContain(story.qualifiedId);
  });

  test("throws NotFound for unknown qid", () => {
    const root = makeTmpDir();
    const loom = new Loom(root);
    expect(() => loom.tree("nonexistent")).toThrow(NotFound);
  });
});

// ---------------------------------------------------------------------------
// order
// ---------------------------------------------------------------------------

describe("Loom.order", () => {
  test("returns direct children in topological order by default", async () => {
    const root = makeTmpDir();
    const { loom, project } = await buildLoomWithProject(root);
    const epic = await project.createEpic({ title: "E" });
    const story = await epic.createStory({ title: "S" });
    const t1 = await story.createTask({ title: "T1" });
    const t2 = await story.createTask({ title: "T2" });
    await t2.dependsOn(t1.qualifiedId);
    const ordered = await loom.order(story.qualifiedId);
    const qids = ordered.map((i) => i.qualifiedId);
    expect(qids.indexOf(t1.qualifiedId)).toBeLessThan(qids.indexOf(t2.qualifiedId));
  });

  test("excludes done items by default", async () => {
    const root = makeTmpDir();
    const { loom, project } = await buildLoomWithProject(root);
    const epic = await project.createEpic({ title: "E" });
    const story = await epic.createStory({ title: "S" });
    const t1 = await story.createTask({ title: "T1" });
    t1.complete();
    const ordered = await loom.order(story.qualifiedId);
    expect(ordered.map((i) => i.qualifiedId)).not.toContain(t1.qualifiedId);
  });

  test("include_done=true includes done items", async () => {
    const root = makeTmpDir();
    const { loom, project } = await buildLoomWithProject(root);
    const epic = await project.createEpic({ title: "E" });
    const story = await epic.createStory({ title: "S" });
    const t1 = await story.createTask({ title: "T1" });
    t1.complete();
    const ordered = await loom.order(story.qualifiedId, { includeDone: true });
    expect(ordered.map((i) => i.qualifiedId)).toContain(t1.qualifiedId);
  });

  test("throws NotFound for unknown qid", async () => {
    const root = makeTmpDir();
    const loom = new Loom(root);
    await expect(loom.order("nonexistent")).rejects.toThrow(NotFound);
  });
});

// ---------------------------------------------------------------------------
// statuses
// ---------------------------------------------------------------------------

describe("Loom.statuses", () => {
  test("returns array of strings", async () => {
    const root = makeTmpDir();
    const { loom, project } = await buildLoomWithProject(root);
    const epic = await project.createEpic({ title: "E" });
    const results = loom.statuses();
    expect(Array.isArray(results)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// project_status
// ---------------------------------------------------------------------------

describe("Loom.project_status", () => {
  test("returns open/closed counts per type", async () => {
    const root = makeTmpDir();
    const { loom, project } = await buildLoomWithProject(root);
    const epic = await project.createEpic({ title: "E" });
    const story = await epic.createStory({ title: "S" });
    const t1 = await story.createTask({ title: "T1" });
    const t2 = await story.createTask({ title: "T2" });
    t1.complete();
    const status = loom.projectStatus("p");
    expect(status.project).toBe("p");
    expect(status.tasks.closed).toBe(1);
    expect(status.tasks.open).toBe(1);
  });

  test("throws NotFound for unknown project", () => {
    const root = makeTmpDir();
    const loom = new Loom(root);
    expect(() => loom.projectStatus("nonexistent")).toThrow(NotFound);
  });
});

// ---------------------------------------------------------------------------
// ready
// ---------------------------------------------------------------------------

describe("Loom.ready", () => {
  test("returns pickable items (status=ready, all deps done)", async () => {
    const root = makeTmpDir();
    const { loom, project } = await buildLoomWithProject(root);
    const epic = await project.createEpic({ title: "E" });
    const story = await epic.createStory({ title: "S" });
    const t1 = await story.createTask({ title: "T1" });
    const t2 = await story.createTask({ title: "T2" });
    await t2.dependsOn(t1.qualifiedId);
    const readyItems = loom.ready({ type: "task" });
    const qids = readyItems.map((i) => i.qualifiedId);
    expect(qids).toContain(t1.qualifiedId);
    expect(qids).not.toContain(t2.qualifiedId);
  });
});

// ---------------------------------------------------------------------------
// reopen
// ---------------------------------------------------------------------------

describe("Loom.reopen", () => {
  test("resets status to ready and clears assignee on item and descendants", async () => {
    const root = makeTmpDir();
    const { loom, project } = await buildLoomWithProject(root);
    const epic = await project.createEpic({ title: "E" });
    const story = await epic.createStory({ title: "S" });
    story.complete();
    story.setAssignee("me");
    const task = await story.createTask({ title: "T" });
    task.complete();
    loom.reopen(story.qualifiedId);
    story.refresh();
    task.refresh();
    expect(story.status).toBe("ready");
    expect(story.assignee).toBeNull();
    expect(task.status).toBe("ready");
  });

  test("throws NotFound for unknown qid", () => {
    const root = makeTmpDir();
    const loom = new Loom(root);
    expect(() => loom.reopen("p:backlog:99")).toThrow(NotFound);
  });
});

// ---------------------------------------------------------------------------
// close_if_children_done
// ---------------------------------------------------------------------------

describe("Loom.close_if_children_done", () => {
  test("closes story if all tasks are done", async () => {
    const root = makeTmpDir();
    const { loom, project } = await buildLoomWithProject(root);
    const epic = await project.createEpic({ title: "E" });
    const story = await epic.createStory({ title: "S" });
    const task = await story.createTask({ title: "T" });
    task.complete();
    const closed = loom.closeIfChildrenDone(story.qualifiedId);
    expect(closed).toBe(true);
    story.refresh();
    expect(story.status).toBe("done");
  });

  test("returns false if any child is not done", async () => {
    const root = makeTmpDir();
    const { loom, project } = await buildLoomWithProject(root);
    const epic = await project.createEpic({ title: "E" });
    const story = await epic.createStory({ title: "S" });
    await story.createTask({ title: "T" });
    expect(loom.closeIfChildrenDone(story.qualifiedId)).toBe(false);
  });

  test("returns false for empty container (non-vacuous)", async () => {
    const root = makeTmpDir();
    const { loom, project } = await buildLoomWithProject(root);
    const epic = await project.createEpic({ title: "E" });
    const story = await epic.createStory({ title: "S" });
    expect(loom.closeIfChildrenDone(story.qualifiedId)).toBe(false);
  });

  test("throws LoomError for project", async () => {
    const root = makeTmpDir();
    const { loom } = await buildLoomWithProject(root);
    expect(() => loom.closeIfChildrenDone("p")).toThrow(LoomError);
  });

  test("throws LoomError for task", async () => {
    const root = makeTmpDir();
    const { loom, project } = await buildLoomWithProject(root);
    const epic = await project.createEpic({ title: "E" });
    const story = await epic.createStory({ title: "S" });
    const task = await story.createTask({ title: "T" });
    expect(() => loom.closeIfChildrenDone(task.qualifiedId)).toThrow(LoomError);
  });
});

// ---------------------------------------------------------------------------
// sync / rebuild / validate
// ---------------------------------------------------------------------------

describe("Loom maintenance", () => {
  test("sync re-reads a single item", async () => {
    const root = makeTmpDir();
    const { loom, project } = await buildLoomWithProject(root);
    const epic = await project.createEpic({ title: "E" });
    const story = await epic.createStory({ title: "S" });
    const task = await story.createTask({ title: "T" });
    // Manually edit the file and sync
    const filePath = task.filePath;
    const content = fs.readFileSync(filePath, "utf-8").replace(/title: .*/, 'title: "T Updated"');
    fs.writeFileSync(filePath, content, "utf-8");
    await loom.sync(task.qualifiedId);
    expect(loom.get(task.qualifiedId).title).toBe("T Updated");
  });

  test("rebuild returns indexed_count > 0", async () => {
    const root = makeTmpDir();
    const { loom, project } = await buildLoomWithProject(root);
    const result = await loom.rebuild();
    expect(result.indexed_count).toBeGreaterThan(0);
  });

  test("validate returns empty array for clean tree", async () => {
    const root = makeTmpDir();
    const { loom, project } = await buildLoomWithProject(root);
    await loom.rebuild();
    const issues = await loom.validate();
    expect(issues).toEqual([]);
  });
});
