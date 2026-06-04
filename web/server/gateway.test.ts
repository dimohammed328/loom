/**
 * Tests for LoomGateway.
 *
 * Uses a real loom directory created with bootstrap + rebuild,
 * so every call goes through the actual TS Loom library.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { LoomGateway } from "./gateway";
import { Loom } from "../lib/loom";
import { initDb, DB_FILENAME } from "../lib/index";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "loom-gw-test-"));
}

async function setupLoomDir(loomDir: string): Promise<void> {
  initDb(path.join(loomDir, DB_FILENAME));
  const loom = new Loom(loomDir);
  const project = await loom.createProject("acme", {
    title: "Acme Corp",
    repo: "https://github.com/acme/acme",
    defaultBranch: "main",
  });
  const epic = await project.createEpic({ title: "Sprint 1" });
  const story = await epic.createStory({ title: "Auth story", body: "Implement authentication." });
  story.setStatus("in_progress");
  story.refresh().setAssignee("alice");
  const task1 = await story.createTask({ title: "Write login endpoint", body: "POST /auth/login" });
  const task2 = await story.createTask({ title: "Write logout endpoint", body: "POST /auth/logout" });
  await task2.dependsOn(task1.qualifiedId);
  await loom.rebuild();
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

let loomDir: string;
let gateway: LoomGateway;

beforeAll(async () => {
  loomDir = makeTmpDir();
  await setupLoomDir(loomDir);
  gateway = new LoomGateway(loomDir);
});

afterAll(() => {
  fs.rmSync(loomDir, { recursive: true, force: true });
});

// --- list_projects ---

describe("LoomGateway.listProjects", () => {
  test("returns all projects", async () => {
    const projects = await gateway.listProjects();
    expect(projects.length).toBeGreaterThan(0);
    const qids = projects.map((p) => p.qualifiedId);
    expect(qids).toContain("acme");
  });
});

// --- get_tree ---

describe("LoomGateway.getTree", () => {
  test("returns root and items for a known project", async () => {
    const tree = await gateway.getTree("acme");
    expect(tree.root).toBe("acme");
    expect(Array.isArray(tree.items)).toBe(true);
    const qids = (tree.items as { qid: string }[]).map((i) => i.qid);
    expect(qids).toContain("acme");
  });

  test("throws NotFound for unknown project", async () => {
    await expect(gateway.getTree("nonexistent")).rejects.toThrow();
  });
});

// --- get_item_detail ---

describe("LoomGateway.getItemDetail", () => {
  test("returns item for known qid", async () => {
    const item = await gateway.getItemDetail("acme");
    expect(item.qualifiedId).toBe("acme");
    expect(item.type).toBe("project");
  });

  test("throws NotFound for unknown qid", async () => {
    await expect(gateway.getItemDetail("acme:zzzzzzz:999:999")).rejects.toThrow();
  });
});

// --- get_children ---

describe("LoomGateway.getChildren", () => {
  test("returns child qids for a story", async () => {
    // Find the story qid dynamically
    const tree = await gateway.getTree("acme");
    type TreeItem = { qid: string; type: string };
    const story = (tree.items as TreeItem[]).find((i) => i.type === "story");
    expect(story).toBeDefined();
    const children = await gateway.getChildren(story!.qid);
    expect(children.length).toBeGreaterThan(0);
    // All children should start with the story qid
    for (const c of children) {
      expect(c.startsWith(story!.qid + ":")).toBe(true);
    }
  });

  test("returns empty array for a task (no children)", async () => {
    type TreeItem = { qid: string; type: string };
    const tree = await gateway.getTree("acme");
    const task = (tree.items as TreeItem[]).find((i) => i.type === "task");
    expect(task).toBeDefined();
    const children = await gateway.getChildren(task!.qid);
    expect(children).toEqual([]);
  });
});
