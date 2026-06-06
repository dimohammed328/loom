/**
 * Type-level tests for frontend/api/client.ts ItemNode.
 *
 * These tests fail at typecheck time if the ItemNode type is missing fields.
 */
import { describe, test, expect } from "bun:test";
import type { ItemNode } from "./client";

describe("ItemNode type", () => {
  test("accepts created_at as a string field", () => {
    // If ItemNode doesn't have created_at, this will cause a TypeScript error.
    const node: ItemNode = {
      qid: "proj:abc23:1",
      type: "story",
      title: "My Story",
      status: "ready",
      assignee: null,
      branch: null,
      pr_url: null,
      deps: [],
      children: [],
      updated_at: "2024-01-01T00:00:00Z",
      created_at: "2024-01-01T00:00:00Z",
    };
    expect(node.created_at).toBe("2024-01-01T00:00:00Z");
  });
});
