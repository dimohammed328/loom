/**
 * Parity tests for the Bun HTTP server — ported from tests/test_web_api.py.
 *
 * Each test maps 1:1 to a test in the Python file so the two servers can be
 * verified to produce identical JSON shapes.  The fixture mirrors
 * populated_loom_dir / client in conftest.py + test_web_api.py.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Loom } from "../lib/loom";
import { initDb, DB_FILENAME } from "../lib/index";
import { createApp } from "./app";

// ---------------------------------------------------------------------------
// Fixture — mirrors populated_loom_dir in test_web_api.py
// ---------------------------------------------------------------------------

let loomDir: string;
let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;

beforeAll(async () => {
  loomDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-parity-test-"));
  initDb(path.join(loomDir, DB_FILENAME));

  const loom = new Loom(loomDir);

  // Create project
  const project = await loom.createProject("acme", {
    title: "Acme Corp",
    repo: "https://github.com/acme/acme",
    defaultBranch: "main",
  });

  // Create epic with fixed id to match Python fixture "abcdefg"
  const epic = await project.createEpic({ title: "Sprint 1", epicId: "abcdefg" });

  // Create story
  const story = await epic.createStory({
    title: "Auth story",
    body: "Implement authentication.",
  });
  story.setStatus("in_progress");
  story.refresh().setAssignee("alice");

  // Create tasks
  const task1 = await story.createTask({
    title: "Write login endpoint",
    body: "POST /auth/login",
  });
  const task2 = await story.createTask({
    title: "Write logout endpoint",
    body: "POST /auth/logout",
  });
  await task2.dependsOn(task1.qualifiedId);

  await loom.rebuild();

  server = createApp(loomDir);
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(async () => {
  await server.stop();
  fs.rmSync(loomDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// GET /api/projects
// ---------------------------------------------------------------------------

describe("GET /api/projects", () => {
  // mirrors test_list_projects_returns_all_projects
  test("returns all projects", async () => {
    const resp = await fetch(`${baseUrl}/api/projects`);
    expect(resp.status).toBe(200);
    const data = await resp.json() as { qid: string }[];
    expect(Array.isArray(data)).toBe(true);
    const qids = data.map((p) => p.qid);
    expect(qids).toContain("acme");
  });

  // mirrors test_list_projects_shape
  test("project has correct shape", async () => {
    const resp = await fetch(`${baseUrl}/api/projects`);
    expect(resp.status).toBe(200);
    const data = await resp.json() as { qid: string; title: string; repo: string; default_branch: string; archived: boolean }[];
    const project = data.find((p) => p.qid === "acme");
    expect(project).toBeDefined();
    expect(project!.title).toBe("Acme Corp");
    expect(project!.repo).toBe("https://github.com/acme/acme");
    expect(project!.default_branch).toBe("main");
    expect(project!.archived).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GET /api/projects/{project}/tree
// ---------------------------------------------------------------------------

describe("GET /api/projects/{project}/tree", () => {
  // mirrors test_tree_returns_root_and_items
  test("returns root and items", async () => {
    const resp = await fetch(`${baseUrl}/api/projects/acme/tree`);
    expect(resp.status).toBe(200);
    const data = await resp.json() as { root: string; items: { qid: string }[] };
    expect(data.root).toBe("acme");
    expect(Array.isArray(data.items)).toBe(true);
    const qids = data.items.map((i) => i.qid);
    expect(qids).toContain("acme");
    expect(qids).toContain("acme:abcdefg");
    expect(qids).toContain("acme:abcdefg:1");
    expect(qids).toContain("acme:abcdefg:1:1");
    expect(qids).toContain("acme:abcdefg:1:2");
  });

  // mirrors test_tree_item_has_correct_fields
  test("tree item has correct fields", async () => {
    const resp = await fetch(`${baseUrl}/api/projects/acme/tree`);
    expect(resp.status).toBe(200);
    const data = await resp.json() as { items: { qid: string; type: string; status: string; children: string[]; deps: string[] }[] };
    const items = Object.fromEntries(data.items.map((i) => [i.qid, i]));
    const story = items["acme:abcdefg:1"]!;
    expect(story.type).toBe("story");
    expect(story.status).toBe("in_progress");
    expect(Array.isArray(story.children)).toBe(true);
    expect(Array.isArray(story.deps)).toBe(true);
  });

  // mirrors test_tree_dep_edge_present
  test("dep edge is present (task2 depends on task1)", async () => {
    const resp = await fetch(`${baseUrl}/api/projects/acme/tree`);
    expect(resp.status).toBe(200);
    const data = await resp.json() as { items: { qid: string; deps: string[] }[] };
    const items = Object.fromEntries(data.items.map((i) => [i.qid, i]));
    const task2 = items["acme:abcdefg:1:2"]!;
    expect(task2.deps).toContain("acme:abcdefg:1:1");
  });

  // mirrors test_tree_unknown_project_returns_404
  test("unknown project returns 404", async () => {
    const resp = await fetch(`${baseUrl}/api/projects/nonexistent/tree`);
    expect(resp.status).toBe(404);
    const data = await resp.json() as { detail: string };
    expect("detail" in data).toBe(true);
  });

  // mirrors test_tree_nodes_have_title_and_updated_at
  test("every tree node has a non-empty title and ISO updated_at", async () => {
    const resp = await fetch(`${baseUrl}/api/projects/acme/tree`);
    expect(resp.status).toBe(200);
    const data = await resp.json() as { items: { qid: string; title: string; updated_at: string }[] };
    expect(data.items.length).toBeGreaterThan(0);
    for (const node of data.items) {
      expect(node.title).toBeTruthy();
      expect(node.updated_at).toBeTruthy();
      expect(node.updated_at).toContain("T");
    }
  });
});

// ---------------------------------------------------------------------------
// GET /api/items/{qid}
// ---------------------------------------------------------------------------

describe("GET /api/items/{qid}", () => {
  // mirrors test_item_detail_project
  test("project item detail", async () => {
    const resp = await fetch(`${baseUrl}/api/items/acme`);
    expect(resp.status).toBe(200);
    const data = await resp.json() as Record<string, unknown>;
    expect(data["qid"]).toBe("acme");
    expect(data["type"]).toBe("project");
    expect(data["title"]).toBe("Acme Corp");
    expect("body" in data).toBe(true);
    expect(Array.isArray(data["dependencies"])).toBe(true);
    expect(Array.isArray(data["dependents"])).toBe(true);
    expect(Array.isArray(data["children"])).toBe(true);
  });

  // mirrors test_item_detail_story_has_body
  test("story item detail has body", async () => {
    const resp = await fetch(`${baseUrl}/api/items/acme:abcdefg:1`);
    expect(resp.status).toBe(200);
    const data = await resp.json() as { body: string };
    expect(data.body).toContain("Implement authentication.");
  });

  // mirrors test_item_detail_task_with_dep
  test("task2 dependencies list includes task1", async () => {
    const resp = await fetch(`${baseUrl}/api/items/acme:abcdefg:1:2`);
    expect(resp.status).toBe(200);
    const data = await resp.json() as { dependencies: { qid: string }[] };
    const depQids = data.dependencies.map((d) => d.qid);
    expect(depQids).toContain("acme:abcdefg:1:1");
  });

  // mirrors test_item_detail_task_dependents
  test("task1 dependents list includes task2", async () => {
    const resp = await fetch(`${baseUrl}/api/items/acme:abcdefg:1:1`);
    expect(resp.status).toBe(200);
    const data = await resp.json() as { dependents: { qid: string }[] };
    const dependentQids = data.dependents.map((d) => d.qid);
    expect(dependentQids).toContain("acme:abcdefg:1:2");
  });

  // mirrors test_item_detail_story_children
  test("story children list includes its two tasks", async () => {
    const resp = await fetch(`${baseUrl}/api/items/acme:abcdefg:1`);
    expect(resp.status).toBe(200);
    const data = await resp.json() as { children: string[] };
    expect(data.children).toContain("acme:abcdefg:1:1");
    expect(data.children).toContain("acme:abcdefg:1:2");
  });

  // mirrors test_item_detail_unknown_qid_returns_404
  test("unknown qid returns 404", async () => {
    const resp = await fetch(`${baseUrl}/api/items/acme:abcdefg:1:999`);
    expect(resp.status).toBe(404);
    const data = await resp.json() as { detail: string };
    expect("detail" in data).toBe(true);
  });

  // mirrors test_item_detail_completely_unknown_project_returns_404
  test("completely unknown project qid returns 404", async () => {
    const resp = await fetch(`${baseUrl}/api/items/ghost`);
    expect(resp.status).toBe(404);
    const data = await resp.json() as { detail: string };
    expect("detail" in data).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GET /api/health
// ---------------------------------------------------------------------------

describe("GET /api/health", () => {
  // mirrors test_health_returns_ok
  test("returns {status: 'ok'}", async () => {
    const resp = await fetch(`${baseUrl}/api/health`);
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ status: "ok" });
  });
});
