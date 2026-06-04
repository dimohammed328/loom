/**
 * Tests for the Broadcaster pub/sub hub in web/server/broadcaster.ts.
 *
 * Mirrors tests/test_web_live.py broadcaster section.
 */

import { describe, test, expect } from "bun:test";
import { Broadcaster } from "./broadcaster";

describe("Broadcaster", () => {
  test("publishes a message to a subscribed queue", async () => {
    const hub = new Broadcaster();
    const received: unknown[] = [];
    const sub = (msg: unknown) => received.push(msg);

    hub.subscribe(sub);
    hub.publish({ qid: "proj:abc:1", type: "task" });

    expect(received).toEqual([{ qid: "proj:abc:1", type: "task" }]);
  });

  test("fans out to multiple subscribers", async () => {
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
