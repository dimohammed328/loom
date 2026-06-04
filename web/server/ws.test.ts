/**
 * Tests for the /ws WebSocket endpoint and server lifecycle in web/server/app.ts.
 *
 * Mirrors tests/test_web_live.py WS + lifespan sections.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { initDb, DB_FILENAME } from "../lib/index";
import { createApp } from "./app";

// ---------------------------------------------------------------------------
// Fixture — shared server instance
// ---------------------------------------------------------------------------

let loomDir: string;
let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;
let wsUrl: string;

beforeAll(async () => {
  loomDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-ws-test-"));
  initDb(path.join(loomDir, DB_FILENAME));

  server = createApp(loomDir);
  baseUrl = `http://localhost:${server.port}`;
  wsUrl = `ws://localhost:${server.port}/ws`;
});

afterAll(async () => {
  await server.stop(true);
  fs.rmSync(loomDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// /ws endpoint — subscribe, receive, disconnect
// ---------------------------------------------------------------------------

describe("/ws endpoint", () => {
  test("accepts a WebSocket connection", async () => {
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = (e) => reject(new Error(`WebSocket error: ${e}`));
      setTimeout(() => reject(new Error("timeout")), 2000);
    });
    ws.close();
  });

  test("delivers a published message to connected client", async () => {
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

    // Publish via the broadcaster exposed on the server
    const broadcaster = (server as unknown as { broadcaster: import("./broadcaster").Broadcaster }).broadcaster;
    broadcaster.publish({ qid: "proj:abc:1", type: "task", deleted: false });

    await msgPromise;
    ws.close();

    expect(received).toHaveLength(1);
    expect((received[0] as Record<string, unknown>)["qid"]).toBe("proj:abc:1");
  });

  test("client is unsubscribed after disconnect", async () => {
    const broadcaster = (server as unknown as { broadcaster: import("./broadcaster").Broadcaster }).broadcaster;

    // Wait for any lingering close handlers from previous tests to fire.
    await new Promise((r) => setTimeout(r, 150));
    const countBefore = (broadcaster as unknown as { _subscribers: Set<unknown> })._subscribers.size;

    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve) => { ws.onopen = () => resolve(); });

    // Give the open handler time to subscribe.
    await new Promise((r) => setTimeout(r, 50));
    const countDuring = (broadcaster as unknown as { _subscribers: Set<unknown> })._subscribers.size;
    expect(countDuring).toBe(countBefore + 1);

    ws.close();
    // Give close handler time to run
    await new Promise((r) => setTimeout(r, 150));

    const countAfter = (broadcaster as unknown as { _subscribers: Set<unknown> })._subscribers.size;
    expect(countAfter).toBe(countBefore);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle — UpdatesWorker starts with the server
// ---------------------------------------------------------------------------

describe("server lifecycle", () => {
  test("createApp exposes a broadcaster property", () => {
    const broadcaster = (server as unknown as { broadcaster: unknown }).broadcaster;
    expect(broadcaster).toBeDefined();
  });

  test("createApp exposes an updatesWorker property", () => {
    const worker = (server as unknown as { updatesWorker: unknown }).updatesWorker;
    expect(worker).toBeDefined();
  });
});
