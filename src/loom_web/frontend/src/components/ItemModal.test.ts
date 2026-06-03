import { describe, expect, test } from "bun:test";
import {
  breadcrumbSegments,
  childListLabel,
  typePillLabel,
} from "./itemModalHelpers";
import type { ItemDetail } from "../api/client";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDetail(overrides: Partial<ItemDetail> = {}): ItemDetail {
  return {
    qid: "proj:ab2cd:1",
    type: "story",
    title: "My Story",
    status: "ready",
    assignee: null,
    branch: null,
    pr_url: null,
    tags: [],
    archived: false,
    body: "",
    dependencies: [],
    dependents: [],
    children: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// breadcrumbSegments
// ---------------------------------------------------------------------------

describe("breadcrumbSegments", () => {
  test("returns single segment for a project-level qid", () => {
    expect(breadcrumbSegments("myproject")).toEqual(["myproject"]);
  });

  test("returns two segments for an epic qid", () => {
    expect(breadcrumbSegments("proj:ab2cd")).toEqual(["proj", "ab2cd"]);
  });

  test("returns three segments for a story qid", () => {
    expect(breadcrumbSegments("proj:ab2cd:1")).toEqual(["proj", "ab2cd", "1"]);
  });

  test("returns four segments for a task qid", () => {
    expect(breadcrumbSegments("proj:ab2cd:1:2")).toEqual([
      "proj",
      "ab2cd",
      "1",
      "2",
    ]);
  });
});

// ---------------------------------------------------------------------------
// childListLabel
// ---------------------------------------------------------------------------

describe("childListLabel", () => {
  test("returns 'Stories' for an epic", () => {
    expect(childListLabel(makeDetail({ type: "epic", qid: "proj:ab2cd" }))).toBe("Stories");
  });

  test("returns 'Tasks' for a story", () => {
    expect(childListLabel(makeDetail({ type: "story", qid: "proj:ab2cd:1" }))).toBe("Tasks");
  });

  test("returns null for a task (tasks have no children)", () => {
    expect(childListLabel(makeDetail({ type: "task", qid: "proj:ab2cd:1:1" }))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// typePillLabel
// ---------------------------------------------------------------------------

describe("typePillLabel", () => {
  test("capitalises 'epic'", () => {
    expect(typePillLabel("epic")).toBe("Epic");
  });

  test("capitalises 'story'", () => {
    expect(typePillLabel("story")).toBe("Story");
  });

  test("capitalises 'task'", () => {
    expect(typePillLabel("task")).toBe("Task");
  });

  test("capitalises unknown type gracefully", () => {
    expect(typePillLabel("project")).toBe("Project");
  });
});
