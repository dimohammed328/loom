/**
 * Tests for UpdatesWorker in web/server/updates.ts.
 *
 * Mirrors tests/test_web_live.py updates worker section.
 */

import { describe, test, expect } from "bun:test";
import { Broadcaster } from "./broadcaster";
import { UpdatesWorker } from "./updates";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal fake Loom-like object for worker tests. */
function fakeLoomItem(qid: string) {
  return {
    qualifiedId: qid,
    type: "task",
    title: "A task",
    status: "ready",
    assignee: null,
    branch: null,
    prUrl: null,
    tags: [],
    archived: false,
    record: {
      qualified_id: qid,
      type: "task",
      title: "A task",
      status: "ready",
      assignee: null,
      branch: null,
      pr_url: null,
      tags: [],
      archived: false,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("UpdatesWorker", () => {
  test("forwards a changed qid to the broadcaster", async () => {
    const hub = new Broadcaster();
    const received: unknown[] = [];
    hub.subscribe((msg) => received.push(msg));

    const item = fakeLoomItem("proj:abc:1");

    // Fake async generator that yields one qid then stops
    async function* fakeGetUpdates() {
      yield "proj:abc:1";
    }

    const fakeLoom = {
      getUpdates: () => fakeGetUpdates(),
      get: async (_qid: string) => item,
    };

    const worker = new UpdatesWorker({ loom: fakeLoom as never, broadcaster: hub });
    await worker.run();

    expect(received).toHaveLength(1);
    const msg = received[0] as Record<string, unknown>;
    expect(msg["qid"]).toBe("proj:abc:1");
    expect(msg["type"]).toBe("task");
    expect("body" in msg).toBe(false);
  });

  test("emits tombstone when item not found after change", async () => {
    const hub = new Broadcaster();
    const received: unknown[] = [];
    hub.subscribe((msg) => received.push(msg));

    async function* fakeGetUpdates() {
      yield "proj:abc:deleted";
    }

    const fakeLoom = {
      getUpdates: () => fakeGetUpdates(),
      get: async (_qid: string) => { throw new Error("not found"); },
    };

    const worker = new UpdatesWorker({ loom: fakeLoom as never, broadcaster: hub, onNotFound: "tombstone" });
    await worker.run();

    expect(received).toHaveLength(1);
    const msg = received[0] as Record<string, unknown>;
    expect(msg["qid"]).toBe("proj:abc:deleted");
    expect(msg["deleted"]).toBe(true);
  });

  test("skips when onNotFound is skip", async () => {
    const hub = new Broadcaster();
    const received: unknown[] = [];
    hub.subscribe((msg) => received.push(msg));

    async function* fakeGetUpdates() {
      yield "proj:abc:gone";
    }

    const fakeLoom = {
      getUpdates: () => fakeGetUpdates(),
      get: async (_qid: string) => { throw new Error("not found"); },
    };

    const worker = new UpdatesWorker({ loom: fakeLoom as never, broadcaster: hub, onNotFound: "skip" });
    await worker.run();

    expect(received).toHaveLength(0);
  });

  test("stop() halts the worker loop", async () => {
    const hub = new Broadcaster();
    const received: unknown[] = [];
    hub.subscribe((msg) => received.push(msg));

    const stopSignal = { stopped: false };

    async function* fakeGetUpdates(opts: { stopSignal?: { stopped: boolean } }) {
      // Will loop forever unless stopped
      let i = 0;
      while (true) {
        if (opts.stopSignal?.stopped) return;
        yield `proj:abc:${i++}`;
        await new Promise((r) => setTimeout(r, 10));
      }
    }

    const item = fakeLoomItem("proj:abc:0");
    const fakeLoom = {
      getUpdates: (opts: object) => fakeGetUpdates(opts as { stopSignal?: { stopped: boolean } }),
      get: async (_qid: string) => ({ ...item, record: { ...item.record } }),
    };

    const worker = new UpdatesWorker({ loom: fakeLoom as never, broadcaster: hub });

    // Run worker, stop after first message
    let runDone = false;
    const runPromise = worker.run().then(() => { runDone = true; });

    // Wait for first message
    await new Promise<void>((resolve) => {
      const check = () => received.length > 0 ? resolve() : setTimeout(check, 5);
      check();
    });

    worker.stop();
    await runPromise;
    expect(runDone).toBe(true);
  });
});
