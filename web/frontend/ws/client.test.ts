/**
 * Tests for the WS client reconnect logic.
 *
 * We test the pure state-machine / backoff logic directly, not the
 * browser WebSocket API, so no DOM is required.
 */

import { describe, expect, test } from "bun:test";
import {
  computeBackoffMs,
  type WsClientConfig,
  parseWsPayload,
} from "./client";

// ---------------------------------------------------------------------------
// computeBackoffMs
// ---------------------------------------------------------------------------

describe("computeBackoffMs", () => {
  test("first attempt has base delay", () => {
    expect(computeBackoffMs(0, { baseMs: 500, maxMs: 30_000 })).toBe(500);
  });

  test("each attempt doubles the delay", () => {
    expect(computeBackoffMs(1, { baseMs: 500, maxMs: 30_000 })).toBe(1000);
    expect(computeBackoffMs(2, { baseMs: 500, maxMs: 30_000 })).toBe(2000);
    expect(computeBackoffMs(3, { baseMs: 500, maxMs: 30_000 })).toBe(4000);
  });

  test("delay is capped at maxMs", () => {
    expect(computeBackoffMs(10, { baseMs: 500, maxMs: 30_000 })).toBe(30_000);
  });

  test("maxMs itself is respected exactly", () => {
    // 2^0 * 500 = 500 <= 500 → 500
    expect(computeBackoffMs(0, { baseMs: 500, maxMs: 500 })).toBe(500);
    // 2^1 * 500 = 1000 > 500 → 500
    expect(computeBackoffMs(1, { baseMs: 500, maxMs: 500 })).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// parseWsPayload
// ---------------------------------------------------------------------------

describe("parseWsPayload", () => {
  test("returns null for non-object JSON", () => {
    expect(parseWsPayload('"hello"')).toBeNull();
    expect(parseWsPayload("42")).toBeNull();
    expect(parseWsPayload("null")).toBeNull();
  });

  test("returns null when qid is missing", () => {
    expect(parseWsPayload('{"type":"task","status":"ready"}')).toBeNull();
  });

  test("parses a tombstone payload", () => {
    const result = parseWsPayload('{"qid":"proj:abc23:1","deleted":true}');
    expect(result).not.toBeNull();
    expect(result!.qid).toBe("proj:abc23:1");
    expect(result!.deleted).toBe(true);
  });

  test("parses an item update payload", () => {
    const raw = JSON.stringify({
      qid: "proj:abc23:1",
      type: "task",
      title: "Fix bug",
      status: "in_progress",
      assignee: null,
      branch: null,
      pr_url: null,
      tags: ["backend"],
      archived: false,
    });
    const result = parseWsPayload(raw);
    expect(result).not.toBeNull();
    expect(result!.qid).toBe("proj:abc23:1");
    expect(result!.deleted).toBeUndefined();
  });

  test("returns null for invalid JSON", () => {
    expect(parseWsPayload("{bad json")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// WsClientConfig defaults
// ---------------------------------------------------------------------------

describe("WsClientConfig defaults", () => {
  test("config type accepts all required fields", () => {
    const cfg: WsClientConfig = {
      url: "/ws",
      onMessage: () => { /* no-op */ },
      baseMs: 500,
      maxMs: 30_000,
    };
    expect(cfg.url).toBe("/ws");
  });
});
