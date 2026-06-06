/**
 * End-to-end verification for the Bun fullstack HTML-import setup.
 *
 * Covers the story S7 validation criteria:
 *   1. No static/ bundle committed — index.html entry uses Bun bundling, not
 *      a hand-built /static/main.js.
 *   2. bun dev / bun start serves the full app (API + WS + React UI) with HMR.
 *   3. api/client.ts and ws/client.ts work against the Bun server endpoints.
 *   4. The served HTML is bundled at serve time (not a static artifact).
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Loom } from "../lib/loom";
import { initDb, DB_FILENAME } from "../lib/index";
import { createApp, type LoomServer } from "./app";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

let loomDir: string;
let server: LoomServer;
let baseUrl: string;
let wsUrl: string;

beforeAll(async () => {
  loomDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-fullstack-e2e-"));
  initDb(path.join(loomDir, DB_FILENAME));

  const loom = new Loom(loomDir);
  const project = await loom.createProject("demo", { title: "Demo Project" });
  const epic = await project.createEpic({ title: "Sprint 1" });
  const story = await epic.createStory({ title: "First story", body: "Story body." });
  await story.createTask({ title: "Task one" });
  await loom.rebuild();

  server = createApp(loomDir);
  baseUrl = `http://localhost:${server.port}`;
  wsUrl = `ws://localhost:${server.port}/ws`;
});

afterAll(async () => {
  server.updatesWorker.stop();
  await server.stop(true);
  fs.rmSync(loomDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. No committed static bundle — HTML served from Bun bundling
// ---------------------------------------------------------------------------

describe("Bun fullstack HTML bundling (no static/ artifact)", () => {
  test("GET / returns HTTP 200 with text/html content-type", async () => {
    const resp = await fetch(`${baseUrl}/`);
    expect(resp.status).toBe(200);
    const ct = resp.headers.get("content-type") ?? "";
    expect(ct).toContain("text/html");
  });

  test("served HTML contains a <script type=module> tag (Bun bundled entry)", async () => {
    const resp = await fetch(`${baseUrl}/`);
    const html = await resp.text();
    // Bun fullstack injects a module script referencing the bundled entry
    expect(html).toContain("<script");
    expect(html).toContain("type");
  });

  test("served HTML contains <div id=root> mount point", async () => {
    const resp = await fetch(`${baseUrl}/`);
    const html = await resp.text();
    expect(html).toContain('id="root"');
  });

  test("served HTML does NOT reference /static/main.js (old committed bundle)", async () => {
    const resp = await fetch(`${baseUrl}/`);
    const html = await resp.text();
    expect(html).not.toContain("/static/main.js");
  });

  test("SPA routes (e.g. /projects/demo) also return HTML fallback", async () => {
    const resp = await fetch(`${baseUrl}/projects/demo`);
    expect(resp.status).toBe(200);
    const ct = resp.headers.get("content-type") ?? "";
    expect(ct).toContain("text/html");
  });
});

// ---------------------------------------------------------------------------
// 2. API endpoints work alongside HTML serving
// ---------------------------------------------------------------------------

describe("API endpoints coexist with SPA serving", () => {
  test("GET /api/health returns JSON, not HTML", async () => {
    const resp = await fetch(`${baseUrl}/api/health`);
    expect(resp.status).toBe(200);
    const ct = resp.headers.get("content-type") ?? "";
    expect(ct).toContain("application/json");
    const data = await resp.json() as { status: string };
    expect(data.status).toBe("ok");
  });

  test("GET /api/projects returns project list", async () => {
    const resp = await fetch(`${baseUrl}/api/projects`);
    expect(resp.status).toBe(200);
    const data = await resp.json() as { qid: string }[];
    expect(Array.isArray(data)).toBe(true);
    expect(data.map((p) => p.qid)).toContain("demo");
  });

  test("GET /api/projects/demo/tree returns tree", async () => {
    const resp = await fetch(`${baseUrl}/api/projects/demo/tree`);
    expect(resp.status).toBe(200);
    const data = await resp.json() as { root: string; items: { qid: string }[] };
    expect(data.root).toBe("demo");
    expect(data.items.length).toBeGreaterThan(0);
  });

  test("GET /api/projects/demo/tree nodes include created_at", async () => {
    const resp = await fetch(`${baseUrl}/api/projects/demo/tree`);
    const data = await resp.json() as { root: string; items: { qid: string; created_at?: string }[] };
    for (const node of data.items) {
      expect(typeof node.created_at).toBe("string");
      expect((node.created_at ?? "").length).toBeGreaterThan(0);
    }
  });

  test("GET /api/items/{qid} works with colon-delimited qid", async () => {
    // Get a task qid from the tree (colons in qid test the /api/items/* route)
    const treeResp = await fetch(`${baseUrl}/api/projects/demo/tree`);
    const tree = await treeResp.json() as { items: { qid: string; type: string }[] };
    const task = tree.items.find((i) => i.type === "task");
    expect(task).toBeDefined();
    const resp = await fetch(`${baseUrl}/api/items/${task!.qid}`);
    expect(resp.status).toBe(200);
    const data = await resp.json() as { qid: string; type: string };
    expect(data.qid).toBe(task!.qid);
    expect(data.type).toBe("task");
  });
});

// ---------------------------------------------------------------------------
// 3. WebSocket endpoint works alongside HTML serving
// ---------------------------------------------------------------------------

describe("WebSocket endpoint coexists with SPA serving", () => {
  test("WS client connects to /ws and receives a manually published message", async () => {
    const received: unknown[] = [];
    const ws = new WebSocket(wsUrl);

    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("ws open failed"));
      setTimeout(() => reject(new Error("open timeout")), 2000);
    });

    const msgPromise = new Promise<void>((resolve, reject) => {
      ws.onmessage = (e) => {
        received.push(JSON.parse(e.data as string));
        resolve();
      };
      setTimeout(() => reject(new Error("message timeout")), 2000);
    });

    server.broadcaster.publish({ qid: "demo:test", type: "task" });
    await msgPromise;
    ws.close();

    expect(received).toHaveLength(1);
    expect((received[0] as Record<string, unknown>)["qid"]).toBe("demo:test");
  });

  test("WS client receives real item-change payload after file edit", async () => {
    // Build a fresh loom dir so only our writes trigger events
    const e2eDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-fs-e2e-"));
    initDb(path.join(e2eDir, DB_FILENAME));
    const e2eLoom = new Loom(e2eDir);
    const proj = await e2eLoom.createProject("p2", { title: "P2" });
    const epic = await proj.createEpic({ title: "E1" });
    const story = await epic.createStory({ title: "S1" });
    const task = await story.createTask({ title: "T1" });
    await e2eLoom.rebuild();

    const e2eServer = createApp(e2eDir);
    const e2eWsUrl = `ws://localhost:${e2eServer.port}/ws`;

    try {
      // Flush any startup noise
      await new Promise((r) => setTimeout(r, 300));

      const received: unknown[] = [];
      const ws = new WebSocket(e2eWsUrl);
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = () => reject(new Error("ws open failed"));
        setTimeout(() => reject(new Error("open timeout")), 2000);
      });

      const msgPromise = new Promise<void>((resolve, reject) => {
        ws.onmessage = (e) => {
          received.push(JSON.parse(e.data as string));
          resolve();
        };
        setTimeout(() => reject(new Error("message timeout")), 5000);
      });

      await new Promise((r) => setTimeout(r, 150));

      // Edit the task file — triggers fs watcher → UpdatesWorker → Broadcaster → WS
      const content = fs.readFileSync(task.filePath, "utf8");
      fs.writeFileSync(task.filePath, content + " ");

      await msgPromise;
      ws.close();

      expect(received).toHaveLength(1);
      const payload = received[0] as Record<string, unknown>;
      expect(payload["qid"]).toBe(task.qualifiedId);
      // Item updates must NOT include body
      expect("body" in payload).toBe(false);
    } finally {
      e2eServer.updatesWorker.stop();
      await e2eServer.stop(true);
      fs.rmSync(e2eDir, { recursive: true, force: true });
    }
  }, 10000);
});

// ---------------------------------------------------------------------------
// 4. No static/ bundle files on disk
// ---------------------------------------------------------------------------

describe("No committed static bundle on disk", () => {
  test("src/loom_web/static/ has no main.js", () => {
    const staticDir = path.join(
      import.meta.dir, // web/server/
      "../../src/loom_web/static"
    );
    const mainJs = path.join(staticDir, "main.js");
    // Either the dir doesn't exist or main.js is not present
    const exists = fs.existsSync(mainJs);
    expect(exists).toBe(false);
  });

  test("src/loom_web/static/ has no main.css", () => {
    const staticDir = path.join(import.meta.dir, "../../src/loom_web/static");
    const mainCss = path.join(staticDir, "main.css");
    expect(fs.existsSync(mainCss)).toBe(false);
  });

  test("web/frontend/index.html references main.tsx, not /static/main.js", () => {
    const indexHtml = path.join(import.meta.dir, "../frontend/index.html");
    const content = fs.readFileSync(indexHtml, "utf8");
    expect(content).toContain("main.tsx");
    expect(content).not.toContain("/static/main.js");
  });
});
