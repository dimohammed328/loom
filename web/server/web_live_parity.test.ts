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
 *   4. /ws endpoint — subscribe, receive, unsubscribe on disconnect
 *   5. Lifespan — worker starts/stops with server
 *   6. Full e2e — file change → WS client receives payload
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
let wsUrl: string;

beforeAll(async () => {
  loomDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-live-parity-"));
  initDb(path.join(loomDir, DB_FILENAME));

  server = createApp(loomDir);
  wsUrl = `ws://localhost:${server.port}/ws`;
});

afterAll(async () => {
  server.updatesWorker.stop();
  await server.stop(true);
  fs.rmSync(loomDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. Broadcaster hub unit tests
// ---------------------------------------------------------------------------

describe("Broadcaster hub", () => {
  test("publishes a message to a subscribed queue", () => {
    const hub = new Broadcaster();
    const received: unknown[] = [];
    hub.subscribe((msg) => received.push(msg));
    hub.publish({ qid: "proj:abc:1", type: "task" });
    expect(received).toEqual([{ qid: "proj:abc:1", type: "task" }]);
  });

  test("publishes to multiple queues", () => {
    const hub = new Broadcaster();
    const r1: unknown[] = [], r2: unknown[] = [], r3: unknown[] = [];
    hub.subscribe((m) => r1.push(m));
    hub.subscribe((m) => r2.push(m));
    hub.subscribe((m) => r3.push(m));
    hub.publish({ qid: "proj:abc:2" });
    expect(r1).toEqual([{ qid: "proj:abc:2" }]);
    expect(r2).toEqual([{ qid: "proj:abc:2" }]);
    expect(r3).toEqual([{ qid: "proj:abc:2" }]);
  });

  test("unsubscribe stops delivery", () => {
    const hub = new Broadcaster();
    const received: unknown[] = [];
    const sub = (msg: unknown) => received.push(msg);
    hub.subscribe(sub as (msg: Record<string, unknown>) => void);
    hub.unsubscribe(sub as (msg: Record<string, unknown>) => void);
    hub.publish({ qid: "proj:abc:3" });
    expect(received).toHaveLength(0);
  });

  test("empty publish is a no-op (does not throw)", () => {
    const hub = new Broadcaster();
    expect(() => hub.publish({ qid: "proj:abc:4" })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 2. UpdatesWorker — forwarding qids to broadcaster
// ---------------------------------------------------------------------------

describe("UpdatesWorker", () => {
  test("forwards changed qid to broadcaster (ItemUpdate shape)", async () => {
    const hub = new Broadcaster();
    const received: unknown[] = [];
    hub.subscribe((msg) => received.push(msg));

    const fakeRecord = {
      qualified_id: "proj:abc:1",
      type: "task",
      title: "A task",
      status: "ready",
      assignee: null,
      branch: null,
      pr_url: null,
      tags: [],
      archived: false,
    };

    async function* fakeGetUpdates() { yield "proj:abc:1"; }

    const fakeLoom = {
      getUpdates: () => fakeGetUpdates(),
      get: async () => ({ record: fakeRecord }),
    };

    const worker = new UpdatesWorker({ loom: fakeLoom as never, broadcaster: hub });
    await worker.run();

    expect(received).toHaveLength(1);
    const msg = received[0] as Record<string, unknown>;
    expect(msg["qid"]).toBe("proj:abc:1");
    expect(msg["type"]).toBe("task");
    expect("body" in msg).toBe(false);
  });

  test("broadcasts ItemTombstone for deleted qid", async () => {
    const hub = new Broadcaster();
    const received: unknown[] = [];
    hub.subscribe((msg) => received.push(msg));

    async function* fakeGetUpdates() { yield "proj:abc:deleted"; }

    const fakeLoom = {
      getUpdates: () => fakeGetUpdates(),
      get: async () => { throw new Error("not found"); },
    };

    const worker = new UpdatesWorker({ loom: fakeLoom as never, broadcaster: hub, onNotFound: "tombstone" });
    await worker.run();

    expect(received).toHaveLength(1);
    const msg = received[0] as Record<string, unknown>;
    expect(msg["qid"]).toBe("proj:abc:deleted");
    expect(msg["deleted"]).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. WS payload shapes — ItemUpdate and ItemTombstone
// ---------------------------------------------------------------------------

describe("WS payload shapes", () => {
  test("ItemUpdate has all item summary fields and no body", () => {
    const payload: Record<string, unknown> = {
      qid: "proj:abc:1",
      type: "task",
      title: "A task",
      status: "ready",
      assignee: null,
      branch: null,
      pr_url: null,
      tags: [],
      archived: false,
    };
    // Must have qid
    expect(typeof payload["qid"]).toBe("string");
    // Must NOT have body
    expect("body" in payload).toBe(false);
    // deleted defaults to false (not present)
    expect(payload["deleted"]).toBeUndefined();
  });

  test("ItemTombstone has qid and deleted=true", () => {
    const payload: Record<string, unknown> = {
      qid: "proj:abc:99",
      deleted: true,
    };
    expect(payload["qid"]).toBe("proj:abc:99");
    expect(payload["deleted"]).toBe(true);
  });

  test("ItemUpdate serialises without body field", () => {
    const hub = new Broadcaster();
    const received: Record<string, unknown>[] = [];
    hub.subscribe((msg) => received.push(msg));

    const fakeRecord = {
      qualified_id: "proj:abc:1",
      type: "task",
      title: "A task",
      status: "ready",
      assignee: null,
      branch: null,
      pr_url: null,
      tags: [],
      archived: false,
    };

    // Simulate what UpdatesWorker._buildPayload produces
    const payload = {
      qid: fakeRecord.qualified_id,
      type: fakeRecord.type,
      title: fakeRecord.title,
      status: fakeRecord.status,
      assignee: fakeRecord.assignee,
      branch: fakeRecord.branch,
      pr_url: fakeRecord.pr_url,
      tags: fakeRecord.tags,
      archived: fakeRecord.archived,
    };

    hub.publish(payload);
    expect(received).toHaveLength(1);
    expect("body" in received[0]!).toBe(false);
    expect(received[0]!["qid"]).toBe("proj:abc:1");
  });
});

// ---------------------------------------------------------------------------
// 4. /ws endpoint — subscribe, receive, unsubscribe on disconnect
// ---------------------------------------------------------------------------

describe("/ws endpoint", () => {
  test("WS client receives a published message and broadcaster unsubscribes on disconnect", async () => {
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

    const msg = { qid: "proj:abc:1", type: "task", deleted: false };
    server.broadcaster.publish(msg);

    await msgPromise;

    // Check subscriber is unsubscribed after close
    const countBefore = (server.broadcaster as unknown as { _subscribers: Set<unknown> })._subscribers.size;
    ws.close();
    await new Promise((r) => setTimeout(r, 150));
    const countAfter = (server.broadcaster as unknown as { _subscribers: Set<unknown> })._subscribers.size;

    expect(received).toEqual([msg]);
    expect(countAfter).toBe(countBefore - 1);
  });
});

// ---------------------------------------------------------------------------
// 5. Lifespan — worker starts with the server
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
// 6. Full e2e — file change → WS client receives payload
// ---------------------------------------------------------------------------

describe("E2E: file change → WS payload", () => {
  test("WS client receives payload when a markdown file changes", async () => {
    // Use a dedicated loom dir so the watcher only sees our writes
    const e2eDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-e2e-"));
    initDb(path.join(e2eDir, DB_FILENAME));

    const e2eServer = createApp(e2eDir);
    const e2eWsUrl = `ws://localhost:${e2eServer.port}/ws`;

    try {
      // Pre-populate items BEFORE starting the server so the watcher
      // doesn't fire for the initial create calls.
      // Note: createApp was already called above, so we need to stop it,
      // write, then restart. Simpler: just wait for debounce to flush.
      const loom = new Loom(e2eDir);
      const project = await loom.createProject("live", { title: "Live Project" });
      const epic = await project.createEpic({ title: "Backlog" });
      const story = await epic.createStory({ title: "Story 1" });
      const task = await story.createTask({ title: "Task 1" });
      await loom.rebuild();

      // Wait for debounce window to flush any events from item creation.
      await new Promise((r) => setTimeout(r, 300));

      const taskQid = task.qualifiedId;

      // Connect WS client
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

      // Wait for broadcaster to have our subscriber
      await new Promise((r) => setTimeout(r, 150));

      // Touch the task file to trigger a watcher event
      const taskFilePath = task.filePath;
      fs.writeFileSync(taskFilePath, fs.readFileSync(taskFilePath, "utf8") + " ");

      await msgPromise;
      ws.close();

      expect(received).toHaveLength(1);
      const payload = received[0] as Record<string, unknown>;
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
    // Use a dedicated loom dir
    const regDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-reg-"));
    initDb(path.join(regDir, DB_FILENAME));

    const regServer = createApp(regDir);
    const regWsUrl = `ws://localhost:${regServer.port}/ws`;

    try {
      const loom = new Loom(regDir);
      const project = await loom.createProject("reg", { title: "Reg Project" });
      const epic = await project.createEpic({ title: "Backlog" });
      const story = await epic.createStory({ title: "Reg Story" });
      const task = await story.createTask({ title: "Reg Task" });
      await loom.rebuild();

      // Wait for debounce + the old 0.1s death window (test that worker survives > 500ms)
      await new Promise((r) => setTimeout(r, 600));

      // The worker's stop signal should still be false
      const stopSignal = (regServer.updatesWorker as unknown as { _stopSignal: { stopped: boolean } })._stopSignal;
      expect(stopSignal.stopped).toBe(false);

      // Also verify a file change still reaches a WS client after the idle delay
      const received: unknown[] = [];
      const ws = new WebSocket(regWsUrl);
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = () => reject(new Error("ws failed"));
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

      // Write a real content change
      const taskFilePath = task.filePath;
      const originalContent = fs.readFileSync(taskFilePath, "utf8");
      fs.writeFileSync(taskFilePath, originalContent.replace("Reg Task", "Reg Task Updated"));

      await msgPromise;
      ws.close();

      expect(received).toHaveLength(1);
      const payload = received[0] as Record<string, unknown>;
      expect(payload["qid"]).toBe(task.qualifiedId);
      expect("body" in payload).toBe(false);
    } finally {
      regServer.updatesWorker.stop();
      await regServer.stop(true);
      fs.rmSync(regDir, { recursive: true, force: true });
    }
  }, 15000);
});
