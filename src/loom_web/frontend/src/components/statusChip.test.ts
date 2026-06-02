/**
 * Tests for statusChip helper.
 *
 * statusChip(base) returns the base class with " loom-status-chip" appended.
 * Used on status pills, dots, and node status labels so CSS transitions fire
 * when the status color changes via a WS store update.
 */

import { describe, expect, test } from "bun:test";
import { statusChip } from "./statusChip";

describe("statusChip", () => {
  test("appends loom-status-chip to the base class", () => {
    expect(statusChip("status-pill")).toBe("status-pill loom-status-chip");
  });

  test("works with dot class", () => {
    expect(statusChip("dot")).toBe("dot loom-status-chip");
  });

  test("works with snode-dot", () => {
    expect(statusChip("snode-dot")).toBe("snode-dot loom-status-chip");
  });

  test("works with snode-status", () => {
    expect(statusChip("snode-status")).toBe("snode-status loom-status-chip");
  });

  test("works with empty string (edge case)", () => {
    expect(statusChip("")).toBe(" loom-status-chip");
  });
});
