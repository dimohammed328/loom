import { describe, expect, test } from "bun:test";
import { storyFooterKind } from "./StoryCard";
import type { StoryCell } from "../boardModel";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCell(
  status: string,
  taskCount: number = 0,
  depCount: number = 0,
): StoryCell {
  return {
    qid: "p:aaa23:1",
    title: "Story",
    status,
    deps: Array.from({ length: depCount }, (_, i) => `p:aaa23:${i + 2}`),
    taskNodes: Array.from({ length: taskCount }, (_, i) => ({
      qid: `p:aaa23:1:${i + 1}`,
      title: `Task ${i + 1}`,
      status: i === 0 ? "done" : "ready",
    })),
  };
}

// ---------------------------------------------------------------------------
// storyFooterKind
// ---------------------------------------------------------------------------

describe("storyFooterKind", () => {
  test("returns 'tasks' when story has tasks (regardless of deps)", () => {
    expect(storyFooterKind(makeCell("ready", 3, 2))).toBe("tasks");
  });

  test("returns 'tasks' when story has tasks and is not blocked", () => {
    expect(storyFooterKind(makeCell("in progress", 1, 0))).toBe("tasks");
  });

  test("returns 'blocked' when story is blocked and has no tasks", () => {
    expect(storyFooterKind(makeCell("blocked", 0, 0))).toBe("blocked");
  });

  test("returns 'deps' when story has deps but is not blocked and has no tasks", () => {
    expect(storyFooterKind(makeCell("ready", 0, 2))).toBe("deps");
  });

  test("returns null when story has no tasks, no deps, and is not blocked", () => {
    expect(storyFooterKind(makeCell("ready", 0, 0))).toBeNull();
    expect(storyFooterKind(makeCell("done", 0, 0))).toBeNull();
  });

  test("tasks take precedence over blocked status", () => {
    // A story can technically have tasks and be blocked — tasks wins in footer display
    expect(storyFooterKind(makeCell("blocked", 2, 0))).toBe("tasks");
  });

  test("tasks take precedence over deps", () => {
    expect(storyFooterKind(makeCell("ready", 1, 3))).toBe("tasks");
  });
});
