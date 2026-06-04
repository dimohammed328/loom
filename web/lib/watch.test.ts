/**
 * Tests for web/lib/watch.ts — get_updates generator.
 *
 * Tests the WatchDebouncer and the getUpdates async generator,
 * verifying: yielded qids on file modification, debounce dedup,
 * stop signal, and Loom.getUpdates facade wiring.
 */

import { describe, test, expect } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { initDb, DB_FILENAME } from "./index";
import { rebuild } from "./rebuild";
import { WatchDebouncer, getUpdates } from "./watch";
import { Loom } from "./loom";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "loom-watch-test-"));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeTask(root: string, taskN = 1, overrides: Record<string, unknown> = {}): string {
  const filePath = path.join(
    root,
    `projects/p/epics/backlog/stories/1/tasks/${taskN}.md`
  );
  const fm: Record<string, unknown> = {
    schema_version: 3,
    id: String(taskN),
    qualified_id: `p:backlog:1:${taskN}`,
    type: "task",
    title: `Task ${taskN}`,
    status: "ready",
    created_at: "2024-01-01T00:00:00+00:00",
    updated_at: "2024-01-01T00:00:00+00:00",
    ...overrides,
  };
  const lines = Object.entries(fm).map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
  const content = `---\n${lines.join("\n")}\n---\n`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
  return filePath;
}

// ---------------------------------------------------------------------------
// WatchDebouncer
// ---------------------------------------------------------------------------

describe("WatchDebouncer", () => {
  test("acquire returns true on first call for a path", () => {
    const d = new WatchDebouncer({ delay: 0.5 });
    expect(d.acquire("foo")).toBe(true);
    d.cancel();
  });

  test("acquire returns false on second call within window", () => {
    const d = new WatchDebouncer({ delay: 0.5 });
    d.acquire("foo");
    expect(d.acquire("foo")).toBe(false);
    d.cancel();
  });

  test("cancel clears active set so subsequent acquire returns true", async () => {
    const d = new WatchDebouncer({ delay: 5 });
    d.acquire("foo");
    d.cancel();
    // After cancel, path is cleared — new acquire should work
    expect(d.acquire("foo")).toBe(true);
    d.cancel();
  });

  test("different paths are independent", () => {
    const d = new WatchDebouncer({ delay: 0.5 });
    expect(d.acquire("foo")).toBe(true);
    expect(d.acquire("bar")).toBe(true);
    d.cancel();
  });

  test("after delay path is released (acquire returns true again)", async () => {
    const d = new WatchDebouncer({ delay: 0.05 });
    d.acquire("foo");
    await sleep(100);
    expect(d.acquire("foo")).toBe(true);
    d.cancel();
  });
});

// ---------------------------------------------------------------------------
// getUpdates
// ---------------------------------------------------------------------------

describe("getUpdates", () => {
  test("yields qid when a watched .md file is modified", async () => {
    const root = makeTmpDir();
    initDb(path.join(root, DB_FILENAME));
    const filePath = writeTask(root, 1);
    await rebuild(root);

    const collected: string[] = [];
    const stopSignal = { stopped: false };

    const gen = getUpdates(root, {
      debounceDelay: 0.02,
      stopSignal,
    });

    // Start consuming in background
    const consumePromise = (async () => {
      for await (const qid of gen) {
        collected.push(qid);
        stopSignal.stopped = true; // stop after first event
        break;
      }
    })();

    // Wait a tick then trigger a modification
    await sleep(50);
    fs.appendFileSync(filePath, "\n# changed\n");
    await sleep(200);
    stopSignal.stopped = true;

    await consumePromise;
    expect(collected).toContain("p:backlog:1:1");
  }, 5000);

  test("does not yield for non-.md file changes", async () => {
    const root = makeTmpDir();
    initDb(path.join(root, DB_FILENAME));

    const collected: string[] = [];
    const stopSignal = { stopped: false };

    const gen = getUpdates(root, {
      debounceDelay: 0.02,
      stopSignal,
      timeout: 200,
    });

    const consumePromise = (async () => {
      for await (const qid of gen) {
        collected.push(qid);
      }
    })();

    await sleep(50);
    // Write a non-.md file
    const txtPath = path.join(root, "notes.txt");
    fs.writeFileSync(txtPath, "hello");
    await sleep(300);
    stopSignal.stopped = true;
    await consumePromise;

    expect(collected).toHaveLength(0);
  }, 5000);

  test("stop signal terminates the generator", async () => {
    const root = makeTmpDir();
    initDb(path.join(root, DB_FILENAME));

    const stopSignal = { stopped: false };
    const gen = getUpdates(root, { debounceDelay: 0.02, stopSignal });

    const startMs = Date.now();
    setTimeout(() => { stopSignal.stopped = true; }, 100);

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of gen) {
      // shouldn't get here
    }

    expect(Date.now() - startMs).toBeLessThan(2000);
  }, 5000);
});

// ---------------------------------------------------------------------------
// Loom.getUpdates facade
// ---------------------------------------------------------------------------

describe("Loom.getUpdates", () => {
  test("yields qid via Loom facade when file is modified", async () => {
    const root = makeTmpDir();
    initDb(path.join(root, DB_FILENAME));
    const filePath = writeTask(root, 1);
    await rebuild(root);

    const loom = new Loom(root);
    const collected: string[] = [];

    const gen = loom.getUpdates({ debounceDelay: 0.02 });

    const consumePromise = (async () => {
      for await (const qid of gen) {
        collected.push(qid);
        break;
      }
    })();

    await sleep(50);
    fs.appendFileSync(filePath, "\n# facade change\n");
    await sleep(300);
    await gen.return(undefined);

    await consumePromise;
    expect(collected).toContain("p:backlog:1:1");
  }, 5000);
});
