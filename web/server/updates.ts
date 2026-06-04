/**
 * UpdatesWorker: consumes loom.getUpdates() and publishes each changed qid
 * to the Broadcaster.
 *
 * Mirrors src/loom_web/updates.py but uses async/await instead of threads,
 * since Bun is single-threaded.
 *
 * Usage:
 *   const worker = new UpdatesWorker({ loom, broadcaster });
 *   worker.run(); // fire-and-forget; or await to wait for stop
 *   worker.stop(); // signals the worker to exit
 */

import { Broadcaster } from "./broadcaster";
import type { IndexRecord } from "../lib/index";

// ---------------------------------------------------------------------------
// Minimal Loom interface needed by UpdatesWorker
// ---------------------------------------------------------------------------

interface LoomLike {
  getUpdates(opts: { stopSignal?: { stopped: boolean } }): AsyncGenerator<string, void, unknown>;
  get(qualifiedId: string): { record: IndexRecord } | Promise<{ record: IndexRecord }>;
}

// ---------------------------------------------------------------------------
// UpdatesWorker
// ---------------------------------------------------------------------------

export class UpdatesWorker {
  private _loom: LoomLike;
  private _broadcaster: Broadcaster;
  private _onNotFound: "tombstone" | "skip";
  private _stopSignal: { stopped: boolean };

  constructor(opts: {
    loom: LoomLike;
    broadcaster: Broadcaster;
    onNotFound?: "tombstone" | "skip";
  }) {
    this._loom = opts.loom;
    this._broadcaster = opts.broadcaster;
    this._onNotFound = opts.onNotFound ?? "tombstone";
    this._stopSignal = { stopped: false };
  }

  /** Signal the worker to stop after the current iteration. */
  stop(): void {
    this._stopSignal.stopped = true;
  }

  /**
   * Async entry point — await this or fire-and-forget.
   * Drives the getUpdates() generator until the stop signal is set or the
   * generator is exhausted.
   */
  async run(): Promise<void> {
    try {
      for await (const qid of this._loom.getUpdates({ stopSignal: this._stopSignal })) {
        if (this._stopSignal.stopped) break;
        const payload = await this._buildPayload(qid);
        if (payload !== null) {
          this._broadcaster.publish(payload);
        }
      }
    } catch {
      // Generator stopped unexpectedly; exit cleanly.
    }
  }

  // -------------------------------------------------------------------------

  private async _buildPayload(qid: string): Promise<Record<string, unknown> | null> {
    try {
      const item = await this._loom.get(qid);
      const r = item.record;
      return {
        qid: r["qualified_id"],
        type: r["type"],
        title: r["title"],
        status: r["status"],
        assignee: r["assignee"] ?? null,
        branch: r["branch"] ?? null,
        pr_url: r["pr_url"] ?? null,
        tags: Array.isArray(r["tags"]) ? r["tags"] : [],
        archived: r["archived"] ?? false,
      };
    } catch {
      if (this._onNotFound === "tombstone") {
        return { qid, deleted: true };
      }
      return null; // skip
    }
  }
}
