/**
 * Tests for the _Statused mixin — mirrors Python items.py _Statused class.
 *
 * Covers: status getter, setStatus/complete/block/markReady,
 * setAssignee/setBranch/setPrUrl, dependsOn/removeDependency/dependencies/
 * dependents/blockers/isPickable.
 */

import { describe, test, expect } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { rebuild } from "./rebuild";
import { Index } from "./index";
import { itemFromRecord, Task } from "./items";
import { LoomError } from "./errors";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "loom-statused-test-"));
}

function writeTaskFile(
  root: string,
  storyN: number,
  taskN: number,
  overrides: Record<string, unknown> = {}
): void {
  const filePath = path.join(
    root,
    `projects/p/epics/backlog/stories/${storyN}/tasks/${taskN}.md`
  );
  const fm: Record<string, unknown> = {
    schema_version: 3,
    id: String(taskN),
    qualified_id: `p:backlog:${storyN}:${taskN}`,
    type: "task",
    title: `Task ${taskN}`,
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
  const content = `---\n${lines.join("\n")}\n---\n`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
}

async function getTask(root: string, qid: string): Promise<Task> {
  const idx = new Index(root);
  const rec = idx.get(qid);
  if (!rec) throw new Error(`task not found: ${qid}`);
  const item = itemFromRecord(root, rec);
  if (!(item instanceof Task)) throw new Error("not a Task");
  return item;
}

// ---------------------------------------------------------------------------
// status getter + setters
// ---------------------------------------------------------------------------

describe("_Statused.status / setStatus", () => {
  test("status getter returns current status", async () => {
    const root = makeTmpDir();
    writeTaskFile(root, 1, 1, { status: "blocked" });
    await rebuild(root);
    const task = await getTask(root, "p:backlog:1:1");
    expect(task.status).toBe("blocked");
  });

  test("setStatus changes status on disk and in record", async () => {
    const root = makeTmpDir();
    writeTaskFile(root, 1, 1);
    await rebuild(root);
    const task = await getTask(root, "p:backlog:1:1");
    task.setStatus("in_progress");
    expect(task.status).toBe("in_progress");
    const idx = new Index(root);
    expect(idx.get("p:backlog:1:1")!.status).toBe("in_progress");
  });

  test("setStatus rejects empty string", async () => {
    const root = makeTmpDir();
    writeTaskFile(root, 1, 1);
    await rebuild(root);
    const task = await getTask(root, "p:backlog:1:1");
    expect(() => task.setStatus("")).toThrow();
  });

  test("complete() sets status to done", async () => {
    const root = makeTmpDir();
    writeTaskFile(root, 1, 1);
    await rebuild(root);
    const task = await getTask(root, "p:backlog:1:1");
    task.complete();
    expect(task.status).toBe("done");
  });

  test("block() sets status to blocked", async () => {
    const root = makeTmpDir();
    writeTaskFile(root, 1, 1);
    await rebuild(root);
    const task = await getTask(root, "p:backlog:1:1");
    task.block();
    expect(task.status).toBe("blocked");
  });

  test("markReady() sets status to ready", async () => {
    const root = makeTmpDir();
    writeTaskFile(root, 1, 1, { status: "blocked" });
    await rebuild(root);
    const task = await getTask(root, "p:backlog:1:1");
    task.markReady();
    expect(task.status).toBe("ready");
  });
});

// ---------------------------------------------------------------------------
// setAssignee / setBranch / setPrUrl
// ---------------------------------------------------------------------------

describe("_Statused assignee/branch/prUrl setters", () => {
  test("setAssignee sets and clears assignee", async () => {
    const root = makeTmpDir();
    writeTaskFile(root, 1, 1);
    await rebuild(root);
    const task = await getTask(root, "p:backlog:1:1");
    task.setAssignee("session:agent");
    expect(task.assignee).toBe("session:agent");
    task.setAssignee(null);
    expect(task.assignee).toBeNull();
  });

  test("setBranch sets and clears branch", async () => {
    const root = makeTmpDir();
    writeTaskFile(root, 1, 1);
    await rebuild(root);
    const task = await getTask(root, "p:backlog:1:1");
    task.setBranch("feature/my-branch");
    expect(task.branch).toBe("feature/my-branch");
    task.setBranch(null);
    expect(task.branch).toBeNull();
  });

  test("setPrUrl sets and clears prUrl", async () => {
    const root = makeTmpDir();
    writeTaskFile(root, 1, 1);
    await rebuild(root);
    const task = await getTask(root, "p:backlog:1:1");
    task.setPrUrl("https://github.com/org/repo/pull/42");
    expect(task.prUrl).toBe("https://github.com/org/repo/pull/42");
    task.setPrUrl(null);
    expect(task.prUrl).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// dependsOn / removeDependency / dependencies / dependents / blockers / isPickable
// ---------------------------------------------------------------------------

describe("_Statused dep methods", () => {
  test("dependsOn adds dep, dependencies() returns it", async () => {
    const root = makeTmpDir();
    writeTaskFile(root, 1, 1);
    writeTaskFile(root, 1, 2);
    await rebuild(root);
    const task2 = await getTask(root, "p:backlog:1:2");
    await task2.dependsOn("p:backlog:1:1");
    const deps = task2.dependencies();
    expect(deps.map((d) => d.qualifiedId)).toContain("p:backlog:1:1");
  });

  test("dependents() returns items that depend on this one", async () => {
    const root = makeTmpDir();
    writeTaskFile(root, 1, 1);
    writeTaskFile(root, 1, 2);
    await rebuild(root);
    const task2 = await getTask(root, "p:backlog:1:2");
    await task2.dependsOn("p:backlog:1:1");
    const task1 = await getTask(root, "p:backlog:1:1");
    const deps = task1.dependents();
    expect(deps.map((d) => d.qualifiedId)).toContain("p:backlog:1:2");
  });

  test("blockers() returns non-done deps", async () => {
    const root = makeTmpDir();
    writeTaskFile(root, 1, 1, { status: "ready" });
    writeTaskFile(root, 1, 2, { status: "ready" });
    await rebuild(root);
    const task2 = await getTask(root, "p:backlog:1:2");
    await task2.dependsOn("p:backlog:1:1");
    expect(task2.blockers().map((b) => b.qualifiedId)).toContain("p:backlog:1:1");
  });

  test("blockers() empty when all deps done", async () => {
    const root = makeTmpDir();
    writeTaskFile(root, 1, 1, { status: "done" });
    writeTaskFile(root, 1, 2, { status: "ready" });
    await rebuild(root);
    const task2 = await getTask(root, "p:backlog:1:2");
    await task2.dependsOn("p:backlog:1:1");
    expect(task2.blockers()).toHaveLength(0);
  });

  test("isPickable() true when ready and no blockers", async () => {
    const root = makeTmpDir();
    writeTaskFile(root, 1, 1);
    await rebuild(root);
    const task = await getTask(root, "p:backlog:1:1");
    expect(task.isPickable()).toBe(true);
  });

  test("isPickable() false when dep not done", async () => {
    const root = makeTmpDir();
    writeTaskFile(root, 1, 1, { status: "ready" });
    writeTaskFile(root, 1, 2, { status: "ready" });
    await rebuild(root);
    const task2 = await getTask(root, "p:backlog:1:2");
    await task2.dependsOn("p:backlog:1:1");
    expect(task2.isPickable()).toBe(false);
  });

  test("removeDependency removes the dep", async () => {
    const root = makeTmpDir();
    writeTaskFile(root, 1, 1);
    writeTaskFile(root, 1, 2);
    await rebuild(root);
    const task2 = await getTask(root, "p:backlog:1:2");
    await task2.dependsOn("p:backlog:1:1");
    await task2.removeDependency("p:backlog:1:1");
    expect(task2.dependencies()).toHaveLength(0);
  });

  test("only 'done' satisfies a dependency — custom status does not", async () => {
    const root = makeTmpDir();
    writeTaskFile(root, 1, 1, { status: "completed" });
    writeTaskFile(root, 1, 2, { status: "ready" });
    await rebuild(root);
    const task2 = await getTask(root, "p:backlog:1:2");
    await task2.dependsOn("p:backlog:1:1");
    // 'completed' is not 'done', so still a blocker
    expect(task2.blockers()).toHaveLength(1);
    expect(task2.isPickable()).toBe(false);
  });
});
