/**
 * Tests for web/server/serializers.ts.
 *
 * Uses a real loom directory so every call goes through the actual TS library.
 * Verifies that serialized JSON shapes match the Python server's schemas.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Loom } from "../lib/loom";
import { initDb, DB_FILENAME } from "../lib/index";
import {
  serializeProject,
  serializeItemRef,
  serializeTree,
  serializeItemDetail,
} from "./serializers";
import { ItemRef as LoomItemRef } from "../lib/deps";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

let loomDir: string;
let loom: Loom;

beforeAll(async () => {
  loomDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-ser-test-"));
  initDb(path.join(loomDir, DB_FILENAME));
  loom = new Loom(loomDir);
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
});

afterAll(() => {
  fs.rmSync(loomDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// serializeProject
// ---------------------------------------------------------------------------

describe("serializeProject", () => {
  test("maps Project to ProjectSummary with correct fields", () => {
    const projects = loom.projects();
    const acme = projects.find((p) => p.qualifiedId === "acme");
    expect(acme).toBeDefined();
    const summary = serializeProject(acme!);
    expect(summary.qid).toBe("acme");
    expect(summary.title).toBe("Acme Corp");
    expect(summary.repo).toBe("https://github.com/acme/acme");
    expect(summary.default_branch).toBe("main");
    expect(summary.archived).toBe(false);
  });

  test("uses snake_case field names (default_branch not defaultBranch)", () => {
    const projects = loom.projects();
    const acme = projects.find((p) => p.qualifiedId === "acme")!;
    const summary = serializeProject(acme);
    expect("default_branch" in summary).toBe(true);
    expect("defaultBranch" in summary).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// serializeItemRef
// ---------------------------------------------------------------------------

describe("serializeItemRef", () => {
  test("maps LoomItemRef to ItemRef schema shape", () => {
    const ref = new LoomItemRef("acme:backlog:1:1", "task", "Task 1", "ready");
    const out = serializeItemRef(ref);
    expect(out.qid).toBe("acme:backlog:1:1");
    expect(out.type).toBe("task");
    expect(out.title).toBe("Task 1");
    expect(out.status).toBe("ready");
  });

  test("passes null status through", () => {
    const ref = new LoomItemRef("acme", "project", "Acme", null);
    const out = serializeItemRef(ref);
    expect(out.status).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// serializeTree
// ---------------------------------------------------------------------------

describe("serializeTree", () => {
  test("maps Loom.tree() dict to TreeResponse shape", () => {
    const treeDict = loom.tree("acme");
    const response = serializeTree(treeDict);
    expect(response.root).toBe("acme");
    expect(Array.isArray(response.items)).toBe(true);
    expect(response.items.length).toBeGreaterThan(0);
  });

  test("each ItemNode has required fields", () => {
    const treeDict = loom.tree("acme");
    const response = serializeTree(treeDict);
    for (const node of response.items) {
      expect(typeof node.qid).toBe("string");
      expect(typeof node.type).toBe("string");
      expect(typeof node.title).toBe("string");
      expect(Array.isArray(node.deps)).toBe(true);
      expect(Array.isArray(node.children)).toBe(true);
      expect(typeof node.updated_at).toBe("string");
    }
  });

  test("dep edge appears in tree node", () => {
    const treeDict = loom.tree("acme");
    const response = serializeTree(treeDict);
    // Find story to get its qid, then tasks
    const story = response.items.find((n) => n.type === "story");
    expect(story).toBeDefined();
    // tasks
    const tasks = response.items.filter((n) => n.type === "task");
    expect(tasks.length).toBe(2);
    // one task must have a dep
    const taskWithDep = tasks.find((t) => t.deps.length > 0);
    expect(taskWithDep).toBeDefined();
  });

  test("each serialized node includes created_at", () => {
    const treeDict = loom.tree("acme");
    const response = serializeTree(treeDict);
    for (const node of response.items) {
      expect(typeof node.created_at).toBe("string");
      expect(node.created_at.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// serializeItemDetail
// ---------------------------------------------------------------------------

describe("serializeItemDetail", () => {
  test("maps story Item to ItemDetail with body", () => {
    // Find the story qid from the tree
    const tree = loom.tree("acme");
    const storyNode = (tree.items as { qid: string; type: string }[]).find(
      (i) => i.type === "story"
    )!;
    const item = loom.get(storyNode.qid);
    const detail = serializeItemDetail(item, []);
    expect(detail.qid).toBe(storyNode.qid);
    expect(detail.body).toContain("Implement authentication");
    expect(Array.isArray(detail.dependencies)).toBe(true);
    expect(Array.isArray(detail.dependents)).toBe(true);
    expect(Array.isArray(detail.children)).toBe(true);
  });

  test("uses snake_case field names (pr_url not prUrl)", () => {
    const item = loom.get("acme");
    const detail = serializeItemDetail(item, []);
    expect("pr_url" in detail).toBe(true);
    expect("prUrl" in detail).toBe(false);
  });

  test("children parameter is passed through", () => {
    const item = loom.get("acme");
    const children = ["acme:backlog", "acme:sprint1"];
    const detail = serializeItemDetail(item, children);
    expect(detail.children).toEqual(children);
  });

  test("project item has empty deps and dependents", () => {
    const item = loom.get("acme");
    const detail = serializeItemDetail(item, []);
    expect(detail.dependencies).toEqual([]);
    expect(detail.dependents).toEqual([]);
  });
});
