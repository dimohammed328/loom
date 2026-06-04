import { describe, expect, test } from "bun:test";
import { epicProgress, storyProgress } from "./progress";
import type { EpicRow, StoryCell } from "./boardModel";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStoryCell(status: string, taskStatuses: (string | null)[] = []): StoryCell {
  return {
    qid: "p:aaa23:1",
    title: "Story",
    status,
    deps: [],
    taskNodes: taskStatuses.map((s, i) => ({ qid: `p:aaa23:1:${i + 1}`, title: `Task ${i + 1}`, status: s })),
  };
}

function makeEpicRow(stories: StoryCell[]): EpicRow {
  const cols: Record<string, StoryCell[]> = {
    ready: [],
    "in progress": [],
    blocked: [],
    done: [],
  };
  for (const s of stories) {
    const key = s.status ?? "ready";
    if (!(key in cols)) cols[key] = [];
    cols[key].push(s);
  }
  return {
    epicQid: "p:aaa23",
    epicTitle: "Epic A",
    epicStatus: null,
    statusColumns: cols,
  };
}

// ---------------------------------------------------------------------------
// epicProgress tests
// ---------------------------------------------------------------------------

describe("epicProgress", () => {
  test("done and total count stories across all status columns", () => {
    const row = makeEpicRow([
      makeStoryCell("done"),
      makeStoryCell("done"),
      makeStoryCell("ready"),
      makeStoryCell("in progress"),
    ]);
    const p = epicProgress(row);
    expect(p.total).toBe(4);
    expect(p.done).toBe(2);
  });

  test("blocked count includes only stories with status 'blocked'", () => {
    const row = makeEpicRow([
      makeStoryCell("blocked"),
      makeStoryCell("blocked"),
      makeStoryCell("done"),
    ]);
    const p = epicProgress(row);
    expect(p.blocked).toBe(2);
    expect(p.total).toBe(3);
    expect(p.done).toBe(1);
  });

  test("all done yields done === total", () => {
    const row = makeEpicRow([makeStoryCell("done"), makeStoryCell("done")]);
    const p = epicProgress(row);
    expect(p.done).toBe(2);
    expect(p.total).toBe(2);
    expect(p.blocked).toBe(0);
  });

  test("empty epic yields zeros", () => {
    const row = makeEpicRow([]);
    const p = epicProgress(row);
    expect(p.total).toBe(0);
    expect(p.done).toBe(0);
    expect(p.blocked).toBe(0);
  });

  test("custom-status stories are counted in total but not done or blocked", () => {
    const row = makeEpicRow([makeStoryCell("custom"), makeStoryCell("done")]);
    const p = epicProgress(row);
    expect(p.total).toBe(2);
    expect(p.done).toBe(1);
    expect(p.blocked).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// storyProgress tests
// ---------------------------------------------------------------------------

describe("storyProgress", () => {
  test("returns done and total task counts", () => {
    const story = makeStoryCell("in progress", ["done", "done", "ready"]);
    const p = storyProgress(story);
    expect(p.total).toBe(3);
    expect(p.done).toBe(2);
  });

  test("no tasks yields zeros", () => {
    const story = makeStoryCell("ready", []);
    const p = storyProgress(story);
    expect(p.total).toBe(0);
    expect(p.done).toBe(0);
  });

  test("all tasks done yields done === total", () => {
    const story = makeStoryCell("done", ["done", "done"]);
    const p = storyProgress(story);
    expect(p.done).toBe(2);
    expect(p.total).toBe(2);
  });

  test("null task status counts as not done", () => {
    const story = makeStoryCell("in progress", [null, "done"]);
    const p = storyProgress(story);
    expect(p.total).toBe(2);
    expect(p.done).toBe(1);
  });
});
