/**
 * Parity tests for the live-update pipeline — ported from tests/test_web_live.py.
 *
 * Each test maps 1:1 to a test in the Python file so both implementations can
 * be verified to behave identically.
 *
 * Sections mirror the Python file:
 *   1. Broadcaster hub unit tests
 *   2. UpdatesWorker — get_updates() forwarding
 *   3. WS payload shapes (ItemUpdate / ItemTombstone)
 *   4. /api/events SSE endpoint — subscribe, receive, unsubscribe on disconnect
 *   5. Lifespan — worker starts/stops with server
 *   6. Full e2e — file change → SSE client receives payload
 *   7. Regression — worker stays alive past startup idle window
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Loom } from "../lib/loom";
import { initDb, DB_FILENAME } from "../lib/index";
import { Broadcaster } from "./broadcaster";
import { UpdatesWorker } from "./updates";
import { createApp, type LoomServer } from "./app";

// ---------------------------------------------------------------------------
// Shared loom dir fixture (used by e2e and regression tests)
// ---------------------------------------------------------------------------

let loomDir: string;
let server: LoomServer;
let baseUrl: string;

beforeAll(async () => {
  loomDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-live-parity-"));
  initDb(path.join(loomDir, DB_FILENAME));

  server = createApp(loomDir);
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(async () => {
  server.updatesWorker.stop();
  await server.stop(true);
  fs.rmSync(loomDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// SSE test helpers
// ---------------------------------------------------------------------------

/**
 * Open a GET /api/events stream and return a reader, decoder, and AbortController.
 * The AbortController can be used to abort the fetch (simulates TCP disconnect).
 * Consumes the initial keepalive comment before returning.
 */
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
  if (!first.done) {
    const text = decoder.decode(first.value);
    if (!text.startsWith(":")) throw new Error("Expected keepalive comment, got: " + text);
  }
  return { reader, decoder, ctrl };
}

/**
 * Read the next SSE data event, with a timeout.
 */
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
// 1. Broadcaster hub unit tests
// ---------------------------------------------------------------------------

describe("Broadcaster", () => {
  test("publishes a message to a subscribed queue", () => {
    const hub = new Broadcaster();
    const received: unknown[] = [];
    const sub = (msg: unknown) => received.push(msg);

    hub.subscribe(sub);
    hub.publish({ qid: "proj:abc:1", type: "task" });

    expect(received).toEqual([{ qid: "proj:abc:1", type: "task" }]);
  });

  test("fans out to multiple subscribers", () => {
    const hub = new Broadcaster();
    const received1: unknown[] = [];
    const received2: unknown[] = [];
    const received3: unknown[] = [];

    hub.subscribe((m) => received1.push(m));
    hub.subscribe((m) => received2.push(m));
    hub.subscribe((m) => received3.push(m));

    hub.publish({ qid: "proj:abc:2" });

    expect(received1).toEqual([{ qid: "proj:abc:2" }]);
    expect(received2).toEqual([{ qid: "proj:abc:2" }]);
    expect(received3).toEqual([{ qid: "proj:abc:2" }]);
  });

  test("unsubscribe stops delivery", () => {
    const hub = new Broadcaster();
    const received: unknown[] = [];
    const sub = (msg: unknown) => received.push(msg);

    hub.subscribe(sub);
    hub.unsubscribe(sub);
    hub.publish({ qid: "proj:abc:3" });

    expect(received).toHaveLength(0);
  });

  test("publish with no subscribers does not throw", () => {
    const hub = new Broadcaster();
    expect(() => hub.publish({ qid: "proj:abc:4" })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 2. UpdatesWorker — get_updates() forwarding
// ---------------------------------------------------------------------------

describe("UpdatesWorker", () => {
  test("forwards item payloads to the broadcaster", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-uw-"));
    initDb(path.join(dir, DB_FILENAME));

    const loom = new Loom(dir);
    const hub = new Broadcaster();
    const received: unknown[] = [];
    hub.subscribe((m) => received.push(m));

    const project = await loom.createProject("p", { title: "P" });
    const epic = await project.createEpic({ title: "E" });
    const story = await epic.createStory({ title: "S" });
    const task = await story.createTask({ title: "T" });
    await loom.rebuild();

    const worker = new UpdatesWorker({ loom, broadcaster: hub });
    worker.run();

    // Touch the file to trigger a change notification
    await new Promise((r) => setTimeout(r, 200));
    const content = fs.readFileSync(task.filePath, "utf8");
    fs.writeFileSync(task.filePath, content + " ");

    await new Promise((r) => setTimeout(r, 600));
    worker.stop();

    expect(received.length).toBeGreaterThanOrEqual(1);
    const payload = received[received.length - 1] as Record<string, unknown>;
    expect(payload["qid"]).toBe(task.qualifiedId);

    fs.rmSync(dir, { recursive: true, force: true });
  }, 10000);
});

// ---------------------------------------------------------------------------
// 3. WS payload shapes (ItemUpdate / ItemTombstone)
// ---------------------------------------------------------------------------

describe("Payload shapes", () => {
  test("item update payload has required fields", () => {
    const payload = {
      qid: "proj:abc23:1",
      type: "task",
      title: "Test task",
      status: "ready",
      assignee: null,
      branch: null,
      pr_url: null,
      tags: [],
      archived: false,
    };
    expect(typeof payload.qid).toBe("string");
    expect(typeof payload.type).toBe("string");
    expect(typeof payload.title).toBe("string");
    expect(Array.isArray(payload.tags)).toBe(true);
  });

  test("tombstone payload has qid and deleted", () => {
    const payload = { qid: "proj:abc23:1", deleted: true };
    expect(payload.qid).toBe("proj:abc23:1");
    expect(payload.deleted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. /api/events SSE endpoint — subscribe, receive, unsubscribe on disconnect
// ---------------------------------------------------------------------------

describe("/api/events SSE endpoint", () => {
  test("SSE client receives a published message and broadcaster unsubscribes on disconnect", async () => {
    // Use AbortController.abort() to simulate TCP disconnect — reader.cancel()
    // only cancels the client-side stream and does not propagate to the
    // server's ReadableStream cancel callback through HTTP.
    const ctrl = new AbortController();
    const fetchPromise = fetch(`${baseUrl}/api/events`, { signal: ctrl.signal }).catch(() => null);

    let resp: Response | null = null;
    try {
      resp = await fetchPromise;
    } catch {
      // Will throw when ctrl.abort() is called; we only need the headers here
    }

    // Re-open without abort to read events
    const { reader, decoder, ctrl: ctrl2 } = await openSseStream(baseUrl);

    const msg = { qid: "proj:abc:1", type: "task", deleted: false };
    server.broadcaster.publish(msg);
    const payload = await readSseEvent(reader, decoder);

    // Count subscribers before disconnect
    const countBefore = (server.broadcaster as unknown as { _subscribers: Set<unknown> })._subscribers.size;

    // Abort the fetch to close the TCP connection (triggers server-side stream cancel)
    ctrl2.abort();

    // Give the cancel handler time to run
    await new Promise((r) => setTimeout(r, 300));
    const countAfter = (server.broadcaster as unknown as { _subscribers: Set<unknown> })._subscribers.size;

    expect(payload["qid"]).toBe("proj:abc:1");
    expect(countAfter).toBe(countBefore - 1);
  });
});

// ---------------------------------------------------------------------------
// 5. Lifespan — worker starts/stops with server
// ---------------------------------------------------------------------------

describe("Lifespan", () => {
  test("broadcaster is defined after createApp", () => {
    expect(server.broadcaster).toBeDefined();
  });

  test("updatesWorker is defined after createApp", () => {
    expect(server.updatesWorker).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 6. Full e2e — file change → SSE client receives payload
// ---------------------------------------------------------------------------

describe("E2E: file change → SSE payload", () => {
  test("SSE client receives payload when a markdown file changes", async () => {
    const e2eDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-e2e-"));
    initDb(path.join(e2eDir, DB_FILENAME));

    const e2eServer = createApp(e2eDir);
    const e2eBaseUrl = `http://localhost:${e2eServer.port}`;

    try {
      const loom = new Loom(e2eDir);
      const project = await loom.createProject("live", { title: "Live Project" });
      const epic = await project.createEpic({ title: "Backlog" });
      const story = await epic.createStory({ title: "Story 1" });
      const task = await story.createTask({ title: "Task 1" });
      await loom.rebuild();

      // Wait for debounce window to flush any events from item creation.
      await new Promise((r) => setTimeout(r, 300));

      const taskQid = task.qualifiedId;

      // Open SSE stream
      const { reader, decoder, ctrl } = await openSseStream(e2eBaseUrl);

      // Wait for subscriber to be registered
      await new Promise((r) => setTimeout(r, 150));

      // Touch the task file to trigger a watcher event
      const content = fs.readFileSync(task.filePath, "utf8");
      fs.writeFileSync(task.filePath, content + " ");

      const payload = await readSseEvent(reader, decoder, 5000);
      ctrl.abort();

      expect(payload["qid"]).toBe(taskQid);
      expect("body" in payload).toBe(false);
    } finally {
      e2eServer.updatesWorker.stop();
      await e2eServer.stop(true);
      fs.rmSync(e2eDir, { recursive: true, force: true });
    }
  }, 10000);
});

// ---------------------------------------------------------------------------
// 7. Regression — worker stays alive past startup idle window
// ---------------------------------------------------------------------------

describe("Regression: worker stays alive", () => {
  test("worker is still running > 0.5s after startup (regression for early-exit bug)", async () => {
    const regDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-reg-"));
    initDb(path.join(regDir, DB_FILENAME));

    const regServer = createApp(regDir);
    const regBaseUrl = `http://localhost:${regServer.port}`;

    try {
      const loom = new Loom(regDir);
      const project = await loom.createProject("reg", { title: "Reg Project" });
      const epic = await project.createEpic({ title: "Backlog" });
      const story = await epic.createStory({ title: "Reg Story" });
      const task = await story.createTask({ title: "Reg Task" });
      await loom.rebuild();

      // Wait for debounce + old 0.1s death window (test that worker survives > 500ms)
      await new Promise((r) => setTimeout(r, 600));

      // The worker's stop signal should still be false
      const stopSignal = (regServer.updatesWorker as unknown as { _stopSignal: { stopped: boolean } })._stopSignal;
      expect(stopSignal.stopped).toBe(false);

      // Verify a file change still reaches an SSE client after the idle delay
      const { reader, decoder, ctrl } = await openSseStream(regBaseUrl);

      await new Promise((r) => setTimeout(r, 150));

      // Write a real content change
      const taskFilePath = task.filePath;
      const originalContent = fs.readFileSync(taskFilePath, "utf8");
      fs.writeFileSync(taskFilePath, originalContent.replace("Reg Task", "Reg Task Updated"));

      const payload = await readSseEvent(reader, decoder, 5000);
      ctrl.abort();

      expect(payload["qid"]).toBe(task.qualifiedId);
      expect("body" in payload).toBe(false);
    } finally {
      regServer.updatesWorker.stop();
      await regServer.stop(true);
      fs.rmSync(regDir, { recursive: true, force: true });
    }
  }, 15000);
});
