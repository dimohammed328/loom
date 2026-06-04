/**
 * Filesystem watch: emit qids as .md files change under $LOOM_DIR.
 *
 * Mirrors src/loom/watch.py but uses Node's fs.watch (available in Bun)
 * instead of watchdog. Debouncing collapses burst events for the same path
 * into a single queue entry.
 *
 * Usage via the Loom facade:
 *   const gen = loom.getUpdates();
 *   for await (const qid of gen) { ... }
 *   gen.return(undefined); // stops the watcher
 */

import * as fs from "fs";
import * as path from "path";
import { qid_from_path } from "./ids";
import { syncOne } from "./rebuild";

// ---------------------------------------------------------------------------
// Stop signal type
// ---------------------------------------------------------------------------

export interface StopSignal {
  stopped: boolean;
}

// ---------------------------------------------------------------------------
// WatchDebouncer
// ---------------------------------------------------------------------------

/**
 * Thread-safe (single-threaded in JS) per-path debouncer.
 *
 * acquire(path) returns true the first time a path is seen within a
 * delay-second window and schedules its release. Subsequent calls within
 * the same window return false, suppressing burst duplicates.
 *
 * cancel() cancels all pending timers.
 */
export class WatchDebouncer {
  private _delay: number; // milliseconds
  private _active: Set<string> = new Set();
  private _timers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  constructor(opts: { delay?: number } = {}) {
    // delay is in seconds (matching Python API), convert to ms
    this._delay = (opts.delay ?? 0.05) * 1000;
  }

  acquire(filePath: string): boolean {
    if (this._active.has(filePath)) return false;
    this._active.add(filePath);
    const timer = setTimeout(() => {
      this._active.delete(filePath);
      this._timers.delete(filePath);
    }, this._delay);
    this._timers.set(filePath, timer);
    return true;
  }

  cancel(): void {
    for (const timer of this._timers.values()) {
      clearTimeout(timer);
    }
    this._timers.clear();
    this._active.clear();
  }
}

// ---------------------------------------------------------------------------
// getUpdates async generator
// ---------------------------------------------------------------------------

/**
 * Async generator that yields the qualified id of each item whose .md
 * file changes under root.
 *
 * Uses Node's fs.watch (recursive mode) to watch the entire root tree.
 * For each .md file event:
 *  1. Debounce: collapse burst events for the same path.
 *  2. Map the path to a qid via qid_from_path; skip non-canonical paths.
 *  3. Call syncOne to keep the SQLite index consistent (errors suppressed).
 *  4. Yield the qid string.
 *
 * The generator stops when:
 *  - stopSignal.stopped becomes true (checked each iteration).
 *  - timeout milliseconds pass with no events (if timeout is set).
 *  - The caller calls gen.return() or breaks out of the loop.
 *
 * @param root    LOOM_DIR root path.
 * @param opts.debounceDelay  Seconds to collapse burst events (default 0.05).
 * @param opts.stopSignal     Object with a .stopped boolean field.
 * @param opts.timeout        Max milliseconds to wait for an event. If set,
 *                            the generator exits after this interval with no event.
 */
export async function* getUpdates(
  root: string,
  opts: {
    debounceDelay?: number;
    stopSignal?: StopSignal;
    timeout?: number;
  } = {}
): AsyncGenerator<string, void, unknown> {
  const debounce = new WatchDebouncer({ delay: opts.debounceDelay ?? 0.05 });
  const stopSignal = opts.stopSignal;
  const timeoutMs = opts.timeout;

  // Internal event queue: null signals shutdown.
  const queue: Array<string | null> = [];
  let resolve: (() => void) | null = null;

  function enqueue(value: string | null): void {
    queue.push(value);
    if (resolve) {
      const r = resolve;
      resolve = null;
      r();
    }
  }

  // Wait for the next item in the queue (or timeout).
  function waitForItem(maxWaitMs?: number): Promise<void> {
    if (queue.length > 0) return Promise.resolve();
    return new Promise<void>((res) => {
      resolve = res;
      if (maxWaitMs !== undefined) {
        setTimeout(() => {
          if (resolve === res) {
            resolve = null;
            res();
          }
        }, maxWaitMs);
      }
    });
  }

  // Start the fs.watch watcher.
  let watcher: fs.FSWatcher | null = null;
  try {
    watcher = fs.watch(root, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      if (!filename.endsWith(".md")) return;

      const fullPath = path.join(root, filename);
      if (!debounce.acquire(fullPath)) return;

      // Map to qid
      let qidStr: string;
      try {
        const [qid] = qid_from_path(fullPath, root);
        qidStr = qid.toString();
      } catch {
        return; // not a canonical loom path
      }

      // Sync index (best-effort; file may have been deleted)
      syncOne(root, qidStr).catch(() => {});

      enqueue(qidStr);
    });

    watcher.on("error", () => enqueue(null));
  } catch {
    // root might not exist or watch fails — just return immediately
    debounce.cancel();
    return;
  }

  try {
    const POLL_MS = 50;

    while (true) {
      if (stopSignal?.stopped) break;

      await waitForItem(timeoutMs !== undefined ? Math.min(POLL_MS, timeoutMs) : POLL_MS);

      // Check stop signal after each wait
      if (stopSignal?.stopped) break;

      if (queue.length === 0) {
        // Timed out with no event
        if (timeoutMs !== undefined) break;
        continue;
      }

      const item = queue.shift()!;
      if (item === null) break; // watcher error or shutdown

      yield item;
    }
  } finally {
    debounce.cancel();
    try {
      watcher?.close();
    } catch {
      // ignore
    }
  }
}
