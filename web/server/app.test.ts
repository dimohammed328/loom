/**
 * Tests for the Bun.serve GET router in web/server/app.ts.
 *
 * Uses a real loom directory so all reads go through the actual TS library.
 * Verifies the four GET endpoints and 404 behaviour.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Loom } from "../lib/loom";
import { initDb, DB_FILENAME } from "../lib/index";
import { createApp } from "./app";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

let loomDir: string;
let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;

beforeAll(async () => {
  loomDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-app-test-"));
  initDb(path.join(loomDir, DB_FILENAME));
  const loom = new Loom(loomDir);
  const project = await loom.createProject("acme", {
    title: "Acme Corp",
    repo: "https://github.com/acme/acme",
    defaultBranch: "main",
  });
  const epic = await project.createEpic({ title: "Sprint 1" });
  const story = await epic.createStory({
    title: "Auth story",
    body: "Implement authentication.",
  });
  story.setStatus("in_progress");
  story.refresh().setAssignee("alice");
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
// GET /api/health
// ---------------------------------------------------------------------------

describe("GET /api/health", () => {
  test("returns 200 with {status: 'ok'}", async () => {
    const resp = await fetch(`${baseUrl}/api/health`);
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data).toEqual({ status: "ok" });
  });
});

// ---------------------------------------------------------------------------
// GET /api/projects
// ---------------------------------------------------------------------------

describe("GET /api/projects", () => {
  test("returns 200 with array of projects", async () => {
    const resp = await fetch(`${baseUrl}/api/projects`);
    expect(resp.status).toBe(200);
    const data = await resp.json() as unknown[];
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
  });

  test("project has correct fields", async () => {
    const resp = await fetch(`${baseUrl}/api/projects`);
    const data = await resp.json() as { qid: string; title: string; repo: string; default_branch: string; archived: boolean }[];
    const acme = data.find((p) => p.qid === "acme");
    expect(acme).toBeDefined();
    expect(acme!.title).toBe("Acme Corp");
    expect(acme!.repo).toBe("https://github.com/acme/acme");
    expect(acme!.default_branch).toBe("main");
    expect(acme!.archived).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GET /api/projects/{project}/tree
// ---------------------------------------------------------------------------

describe("GET /api/projects/{project}/tree", () => {
  test("returns 200 with root and items", async () => {
    const resp = await fetch(`${baseUrl}/api/projects/acme/tree`);
    expect(resp.status).toBe(200);
    const data = await resp.json() as { root: string; items: unknown[] };
    expect(data.root).toBe("acme");
    expect(Array.isArray(data.items)).toBe(true);
  });

  test("items include all levels", async () => {
    const resp = await fetch(`${baseUrl}/api/projects/acme/tree`);
    const data = await resp.json() as { root: string; items: { qid: string }[] };
    const qids = data.items.map((i) => i.qid);
    expect(qids).toContain("acme");
  });

  test("tree nodes have required fields", async () => {
    const resp = await fetch(`${baseUrl}/api/projects/acme/tree`);
    const data = await resp.json() as { items: Record<string, unknown>[] };
    for (const node of data.items) {
      expect(typeof node["qid"]).toBe("string");
      expect(typeof node["type"]).toBe("string");
      expect(typeof node["title"]).toBe("string");
      expect(Array.isArray(node["deps"])).toBe(true);
      expect(Array.isArray(node["children"])).toBe(true);
      expect(typeof node["updated_at"]).toBe("string");
    }
  });

  test("returns 404 for unknown project", async () => {
    const resp = await fetch(`${baseUrl}/api/projects/nonexistent/tree`);
    expect(resp.status).toBe(404);
    const data = await resp.json() as { detail: string };
    expect(typeof data.detail).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// GET /api/items/{qid:path}
// ---------------------------------------------------------------------------

describe("GET /api/items/{qid}", () => {
  test("returns 200 for known project qid", async () => {
    const resp = await fetch(`${baseUrl}/api/items/acme`);
    expect(resp.status).toBe(200);
    const data = await resp.json() as Record<string, unknown>;
    expect(data["qid"]).toBe("acme");
    expect(data["type"]).toBe("project");
    expect(data["title"]).toBe("Acme Corp");
    expect(typeof data["body"]).toBe("string");
    expect(Array.isArray(data["dependencies"])).toBe(true);
    expect(Array.isArray(data["dependents"])).toBe(true);
    expect(Array.isArray(data["children"])).toBe(true);
  });

  test("qid with colons works (task route)", async () => {
    // Get a task qid from the tree
    const treeResp = await fetch(`${baseUrl}/api/projects/acme/tree`);
    const tree = await treeResp.json() as { items: { qid: string; type: string }[] };
    const task = tree.items.find((i) => i.type === "task");
    expect(task).toBeDefined();
    const resp = await fetch(`${baseUrl}/api/items/${task!.qid}`);
    expect(resp.status).toBe(200);
    const data = await resp.json() as { qid: string; type: string };
    expect(data.qid).toBe(task!.qid);
    expect(data.type).toBe("task");
  });

  test("story has body with content", async () => {
    const treeResp = await fetch(`${baseUrl}/api/projects/acme/tree`);
    const tree = await treeResp.json() as { items: { qid: string; type: string }[] };
    const story = tree.items.find((i) => i.type === "story");
    expect(story).toBeDefined();
    const resp = await fetch(`${baseUrl}/api/items/${story!.qid}`);
    const data = await resp.json() as { body: string };
    expect(data.body).toContain("Implement authentication");
  });

  test("task2 has task1 in dependencies", async () => {
    const treeResp = await fetch(`${baseUrl}/api/projects/acme/tree`);
    const tree = await treeResp.json() as { items: { qid: string; type: string; deps: string[] }[] };
    const task2 = tree.items.find((i) => i.type === "task" && i.deps.length > 0);
    expect(task2).toBeDefined();
    const resp = await fetch(`${baseUrl}/api/items/${task2!.qid}`);
    const data = await resp.json() as { dependencies: { qid: string }[] };
    expect(data.dependencies.length).toBeGreaterThan(0);
  });

  test("task1 appears in task2 dependents", async () => {
    const treeResp = await fetch(`${baseUrl}/api/projects/acme/tree`);
    const tree = await treeResp.json() as { items: { qid: string; type: string; deps: string[] }[] };
    // task1 has no deps; task2 depends on task1
    const task2 = tree.items.find((i) => i.type === "task" && i.deps.length > 0);
    expect(task2).toBeDefined();
    const task1Qid = task2!.deps[0];
    const resp = await fetch(`${baseUrl}/api/items/${task1Qid}`);
    const data = await resp.json() as { dependents: { qid: string }[] };
    const depQids = data.dependents.map((d) => d.qid);
    expect(depQids).toContain(task2!.qid);
  });

  test("story children include its tasks", async () => {
    const treeResp = await fetch(`${baseUrl}/api/projects/acme/tree`);
    const tree = await treeResp.json() as { items: { qid: string; type: string; children: string[] }[] };
    const story = tree.items.find((i) => i.type === "story");
    expect(story).toBeDefined();
    const resp = await fetch(`${baseUrl}/api/items/${story!.qid}`);
    const data = await resp.json() as { children: string[] };
    expect(data.children.length).toBeGreaterThan(0);
  });

  test("returns 404 for unknown qid", async () => {
    const resp = await fetch(`${baseUrl}/api/items/acme:zzzzzzz:999:999`);
    expect(resp.status).toBe(404);
    const data = await resp.json() as { detail: string };
    expect(typeof data.detail).toBe("string");
  });

  test("returns 404 for completely unknown project", async () => {
    const resp = await fetch(`${baseUrl}/api/items/ghost`);
    expect(resp.status).toBe(404);
  });
});
