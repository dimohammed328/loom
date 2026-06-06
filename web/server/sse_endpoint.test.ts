/**
 * Tests for the GET /api/events SSE endpoint in web/server/app.ts.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { initDb, DB_FILENAME } from "../lib/index";
import { createApp, type LoomServer } from "./app";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

let loomDir: string;
let server: LoomServer;
let baseUrl: string;

beforeAll(async () => {
  loomDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-sse-test-"));
  initDb(path.join(loomDir, DB_FILENAME));

  server = createApp(loomDir);
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(async () => {
  await server.stop(true);
  fs.rmSync(loomDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// GET /api/events
// ---------------------------------------------------------------------------

describe("GET /api/events", () => {
  test("returns Content-Type: text/event-stream", async () => {
    const resp = await fetch(`${baseUrl}/api/events`);
    const ct = resp.headers.get("Content-Type") ?? "";
    expect(ct).toBe("text/event-stream");
    await resp.body!.cancel();
  });

  test("streams a published payload as data: <json>\\n\\n", async () => {
    const resp = await fetch(`${baseUrl}/api/events`);
    expect(resp.body).not.toBeNull();

    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();

    // Consume the initial keepalive comment so response headers have flushed
    const { value: keepalive } = await reader.read();
    const keepaliveText = decoder.decode(keepalive);
    expect(keepaliveText).toStartWith(":");

    // Publish a message
    server.broadcaster.publish({ qid: "proj:abc:1", type: "task" });

    const { value: eventChunk } = await new Promise<ReadableStreamReadResult<Uint8Array>>(
      (resolve, reject) => {
        setTimeout(() => reject(new Error("read timeout")), 2000);
        reader.read().then(resolve);
      }
    );
    await reader.cancel();

    const eventText = decoder.decode(eventChunk);
    expect(eventText).toStartWith("data: ");
    expect(eventText).toEndWith("\n\n");
    // The data field should be valid JSON containing our qid
    const jsonPart = eventText.slice("data: ".length).trim();
    const parsed = JSON.parse(jsonPart) as Record<string, unknown>;
    expect(parsed["qid"]).toBe("proj:abc:1");
    expect(parsed["type"]).toBe("task");
  });
});
