/**
 * Unit tests for dagLayout — pure DAG layout function.
 */

import { describe, test, expect } from "bun:test";
import { dagLayout } from "./dagLayout";
import type { ItemNode } from "./api/client";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStory(qid: string, deps: string[] = [], status: string | null = "ready"): ItemNode {
  return {
    qid,
    type: "story",
    title: `Story ${qid}`,
    status,
    assignee: null,
    branch: null,
    pr_url: null,
    deps,
    children: [],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("dagLayout", () => {
  test("empty input produces empty output", () => {
    const { nodes, edges } = dagLayout([]);
    expect(nodes).toEqual([]);
    expect(edges).toEqual([]);
  });

  test("single story produces one node and no edges", () => {
    const story = makeStory("p:abc:1");
    const { nodes, edges } = dagLayout([story]);
    expect(nodes).toHaveLength(1);
    expect(edges).toHaveLength(0);

    const node = nodes[0];
    expect(node.id).toBe("p:abc:1");
    expect(node.type).toBe("storyNode");
    expect(node.data.qid).toBe("p:abc:1");
    expect(node.data.title).toBe("Story p:abc:1");
    expect(node.data.status).toBe("ready");
    expect(typeof node.position.x).toBe("number");
    expect(typeof node.position.y).toBe("number");
  });

  test("two stories with dependency produce one edge", () => {
    const s1 = makeStory("p:abc:1");
    const s2 = makeStory("p:abc:2", ["p:abc:1"]);
    const { nodes, edges } = dagLayout([s1, s2]);

    expect(nodes).toHaveLength(2);
    expect(edges).toHaveLength(1);

    const edge = edges[0];
    // s1 must be done before s2 → edge goes s1 → s2
    expect(edge.source).toBe("p:abc:1");
    expect(edge.target).toBe("p:abc:2");
    expect(edge.id).toBe("p:abc:1-->p:abc:2");
    expect(edge.animated).toBe(false);
  });

  test("dependency ordering: s1 is left of s2 (LR layout)", () => {
    const s1 = makeStory("p:abc:1");
    const s2 = makeStory("p:abc:2", ["p:abc:1"]);
    const { nodes } = dagLayout([s1, s2]);

    const n1 = nodes.find((n) => n.id === "p:abc:1")!;
    const n2 = nodes.find((n) => n.id === "p:abc:2")!;

    // In a left-to-right layout, the dependency (s1) should be to the left.
    expect(n1.position.x).toBeLessThan(n2.position.x);
  });

  test("cross-epic deps are silently dropped", () => {
    // s1 depends on something outside the current epic scope
    const s1 = makeStory("p:abc:1", ["p:other:5"]);
    const { nodes, edges } = dagLayout([s1]);
    expect(nodes).toHaveLength(1);
    expect(edges).toHaveLength(0);
  });

  test("three-node chain produces correct edge order", () => {
    const s1 = makeStory("p:abc:1");
    const s2 = makeStory("p:abc:2", ["p:abc:1"]);
    const s3 = makeStory("p:abc:3", ["p:abc:2"]);
    const { nodes, edges } = dagLayout([s1, s2, s3]);

    expect(nodes).toHaveLength(3);
    expect(edges).toHaveLength(2);

    const edgeSources = edges.map((e) => e.source);
    expect(edgeSources).toContain("p:abc:1");
    expect(edgeSources).toContain("p:abc:2");
  });

  test("diamond deps produce 4 edges from 4 nodes", () => {
    // s1 → s2, s1 → s3, s2 → s4, s3 → s4
    const s1 = makeStory("p:abc:1");
    const s2 = makeStory("p:abc:2", ["p:abc:1"]);
    const s3 = makeStory("p:abc:3", ["p:abc:1"]);
    const s4 = makeStory("p:abc:4", ["p:abc:2", "p:abc:3"]);
    const { nodes, edges } = dagLayout([s1, s2, s3, s4]);

    expect(nodes).toHaveLength(4);
    expect(edges).toHaveLength(4);
  });

  test("all nodes have finite numeric positions", () => {
    const stories = [
      makeStory("p:abc:1"),
      makeStory("p:abc:2", ["p:abc:1"]),
      makeStory("p:abc:3", ["p:abc:1"]),
    ];
    const { nodes } = dagLayout(stories);
    for (const n of nodes) {
      expect(Number.isFinite(n.position.x)).toBe(true);
      expect(Number.isFinite(n.position.y)).toBe(true);
    }
  });
});
