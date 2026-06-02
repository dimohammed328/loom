/**
 * Tests for WS integration helpers.
 *
 * shouldRefetchModal(openQid, payload) — pure predicate that returns true
 * when an open modal should re-fetch its detail because the incoming WS
 * payload touches the same qid.
 *
 * These tests drive the integration between the WS client and the app store
 * without mounting React or touching the browser WS API.
 */

import { describe, expect, test } from "bun:test";
import { shouldRefetchModal } from "./wsIntegration";
import type { WsPayload } from "../ws/client";

// ---------------------------------------------------------------------------
// shouldRefetchModal
// ---------------------------------------------------------------------------

describe("shouldRefetchModal", () => {
  test("returns false when no modal is open (openQid is null)", () => {
    const payload: WsPayload = { qid: "p:abc23:1", status: "done" };
    expect(shouldRefetchModal(null, payload)).toBe(false);
  });

  test("returns false when payload qid does not match open modal", () => {
    const payload: WsPayload = { qid: "p:abc23:2", status: "done" };
    expect(shouldRefetchModal("p:abc23:1", payload)).toBe(false);
  });

  test("returns true when payload qid matches the open modal", () => {
    const payload: WsPayload = {
      qid: "p:abc23:1",
      type: "task",
      title: "Fixed",
      status: "done",
      assignee: null,
      branch: null,
      pr_url: null,
      tags: [],
      archived: false,
    };
    expect(shouldRefetchModal("p:abc23:1", payload)).toBe(true);
  });

  test("returns false for a tombstone on the open modal (deleted items close gracefully — no refetch)", () => {
    const tombstone: WsPayload = { qid: "p:abc23:1", deleted: true };
    expect(shouldRefetchModal("p:abc23:1", tombstone)).toBe(false);
  });

  test("returns true for task-level qids matching the open modal", () => {
    const payload: WsPayload = { qid: "proj:xyz23:3:2", status: "ready" };
    expect(shouldRefetchModal("proj:xyz23:3:2", payload)).toBe(true);
  });
});
