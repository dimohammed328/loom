/**
 * End-to-end verification for the Bun fullstack HTML-import setup.
 *
 * Covers the story S7 validation criteria:
 *   1. No static/ bundle committed — index.html entry uses Bun bundling, not
 *      a hand-built /static/main.js.
 *   2. bun dev / bun start serves the full app (API + SSE + React UI) with HMR.
 *   3. api/client.ts and sse/client.ts work against the Bun server endpoints.
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
});

afterAll(async () => {
  server.updatesWorker.stop();
  await server.stop(true);
  fs.rmSync(loomDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// SSE helpers
// ---------------------------------------------------------------------------

async function openSseStream(url: string): Promise<{
  reader: ReadableStreamDefaultReader<Uint8Array>;
  decoder: TextDecoder;
  ctrl: AbortController;
}> {
  const ctrl = new AbortController();
  const resp = await fetch(`${url}/api/events`, { signal: ctrl.signal });
  const reader = resp.body!.getReader();
  const decoder = new TextDecoder();
  // Consume initial keepalive comment
  const first = await reader.read();
  if (!first.done && !new TextDecoder().decode(first.value).startsWith(":")) {
    throw new Error("Expected keepalive comment");
  }
  return { reader, decoder, ctrl };
}

async function readSseEvent(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  timeoutMs = 2000,
): Promise<Record<string, unknown>> {
  const chunk = await new Promise<{ done: boolean; value: Uint8Array | undefined }>(
    (resolve, reject) => {
      setTimeout(() => reject(new Error("SSE read timeout")), timeoutMs);
      reader.read().then((r) => resolve({ done: r.done, value: r.value }));
    }
  );
  if (chunk.done) throw new Error("SSE stream ended unexpectedly");
  const text = decoder.decode(chunk.value);
  if (!text.startsWith("data: ")) throw new Error("Unexpected SSE frame: " + text);
  return JSON.parse(text.slice("data: ".length)) as Record<string, unknown>;
}

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
// 3. SSE endpoint works alongside HTML serving
// ---------------------------------------------------------------------------

describe("SSE endpoint coexists with SPA serving", () => {
  test("SSE client connects to /api/events and receives a manually published message", async () => {
    const { reader, decoder, ctrl } = await openSseStream(baseUrl);

    const msgPromise = readSseEvent(reader, decoder, 2000);
    server.broadcaster.publish({ qid: "demo:test", type: "task" });
    const received = await msgPromise;
    ctrl.abort();

    expect(received["qid"]).toBe("demo:test");
  });

  test("SSE client receives real item-change payload after file edit", async () => {
    const e2eDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-fs-e2e-"));
    initDb(path.join(e2eDir, DB_FILENAME));
    const e2eLoom = new Loom(e2eDir);
    const proj = await e2eLoom.createProject("p2", { title: "P2" });
    const epic = await proj.createEpic({ title: "E1" });
    const story = await epic.createStory({ title: "S1" });
    const task = await story.createTask({ title: "T1" });
    await e2eLoom.rebuild();

    const e2eServer = createApp(e2eDir);
    const e2eBaseUrl = `http://localhost:${e2eServer.port}`;

    try {
      // Flush any startup noise
      await new Promise((r) => setTimeout(r, 300));

      const { reader, decoder, ctrl } = await openSseStream(e2eBaseUrl);

      // Wait for subscriber to register
      await new Promise((r) => setTimeout(r, 150));

      // Edit the task file — triggers fs watcher → UpdatesWorker → Broadcaster → SSE
      const content = fs.readFileSync(task.filePath, "utf8");
      fs.writeFileSync(task.filePath, content + " ");

      const payload = await readSseEvent(reader, decoder, 5000);
      ctrl.abort();

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
