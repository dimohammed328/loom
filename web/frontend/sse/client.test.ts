/**
 * Tests for the SSE client.
 *
 * We test the pure helpers (parseSsePayload) directly.
 * The createSseClient factory wraps EventSource which is a browser API;
 * we verify the config type and function signature without invoking EventSource.
 */

import { describe, expect, test } from "bun:test";
import {
  parseSsePayload,
  type SsePayload,
  type SseClientConfig,
} from "./client";

// ---------------------------------------------------------------------------
// parseSsePayload
// ---------------------------------------------------------------------------

describe("parseSsePayload", () => {
  test("returns null for non-object JSON", () => {
    expect(parseSsePayload('"hello"')).toBeNull();
    expect(parseSsePayload("42")).toBeNull();
    expect(parseSsePayload("null")).toBeNull();
  });

  test("returns null when qid is missing", () => {
    expect(parseSsePayload('{"type":"task","status":"ready"}')).toBeNull();
  });

  test("parses a tombstone payload", () => {
    const result = parseSsePayload('{"qid":"proj:abc23:1","deleted":true}');
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
    const result = parseSsePayload(raw);
    expect(result).not.toBeNull();
    expect(result!.qid).toBe("proj:abc23:1");
    expect(result!.deleted).toBeUndefined();
  });

  test("returns null for invalid JSON", () => {
    expect(parseSsePayload("{bad json")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// SseClientConfig shape
// ---------------------------------------------------------------------------

describe("SseClientConfig", () => {
  test("config type accepts all required fields", () => {
    const cfg: SseClientConfig = {
      url: "/api/events",
      onMessage: (_payload: SsePayload) => { /* no-op */ },
    };
    expect(cfg.url).toBe("/api/events");
  });
});
