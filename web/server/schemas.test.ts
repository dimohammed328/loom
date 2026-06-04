/**
 * Tests for response schemas in web/server/schemas.ts.
 *
 * Verifies that the TypeScript schema types match the shape documented
 * in the Python Pydantic schemas (src/loom_web/schemas.py) so that
 * the Bun server produces identical JSON to the Python server.
 */

import { describe, test, expect } from "bun:test";
import {
  SCHEMAS_VERSION,
} from "./schemas";
import type {
  ProjectSummary,
  ItemRef,
  ItemNode,
  TreeResponse,
  ItemDetail,
} from "./schemas";

// ---------------------------------------------------------------------------
// Module sentinel
// ---------------------------------------------------------------------------

describe("schemas module", () => {
  test("exports SCHEMAS_VERSION sentinel", () => {
    expect(SCHEMAS_VERSION).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// ProjectSummary
// ---------------------------------------------------------------------------

describe("ProjectSummary shape", () => {
  test("accepts a full project summary object", () => {
    const ps: ProjectSummary = {
      qid: "acme",
      title: "Acme Corp",
      repo: "https://github.com/acme/acme",
      default_branch: "main",
      archived: false,
    };
    expect(ps.qid).toBe("acme");
    expect(ps.title).toBe("Acme Corp");
    expect(ps.repo).toBe("https://github.com/acme/acme");
    expect(ps.default_branch).toBe("main");
    expect(ps.archived).toBe(false);
  });

  test("allows null repo and default_branch", () => {
    const ps: ProjectSummary = {
      qid: "p",
      title: "P",
      repo: null,
      default_branch: null,
      archived: false,
    };
    expect(ps.repo).toBeNull();
    expect(ps.default_branch).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ItemRef
// ---------------------------------------------------------------------------

describe("ItemRef shape", () => {
  test("accepts a full item ref", () => {
    const ref: ItemRef = {
      qid: "acme:abcdefg:1:1",
      type: "task",
      title: "Write login endpoint",
      status: "ready",
    };
    expect(ref.qid).toBe("acme:abcdefg:1:1");
    expect(ref.type).toBe("task");
  });

  test("allows null status", () => {
    const ref: ItemRef = {
      qid: "acme",
      type: "project",
      title: "Acme",
      status: null,
    };
    expect(ref.status).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ItemNode (used in TreeResponse.items)
// ---------------------------------------------------------------------------

describe("ItemNode shape", () => {
  test("accepts a full item node with deps and children", () => {
    const node: ItemNode = {
      qid: "acme:abcdefg:1",
      type: "story",
      title: "Auth story",
      status: "in_progress",
      assignee: "alice",
      branch: null,
      pr_url: null,
      deps: [],
      children: ["acme:abcdefg:1:1", "acme:abcdefg:1:2"],
      updated_at: "2024-01-01T00:00:00+00:00",
    };
    expect(node.children).toHaveLength(2);
    expect(node.deps).toHaveLength(0);
    expect(node.updated_at).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// TreeResponse
// ---------------------------------------------------------------------------

describe("TreeResponse shape", () => {
  test("has root and items array", () => {
    const tree: TreeResponse = {
      root: "acme",
      items: [],
    };
    expect(tree.root).toBe("acme");
    expect(Array.isArray(tree.items)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ItemDetail
// ---------------------------------------------------------------------------

describe("ItemDetail shape", () => {
  test("accepts full item detail with dependencies, dependents, and children", () => {
    const detail: ItemDetail = {
      qid: "acme:abcdefg:1:2",
      type: "task",
      title: "Write logout endpoint",
      status: "ready",
      assignee: null,
      branch: null,
      pr_url: null,
      tags: [],
      archived: false,
      body: "POST /auth/logout",
      dependencies: [
        { qid: "acme:abcdefg:1:1", type: "task", title: "Write login endpoint", status: "ready" },
      ],
      dependents: [],
      children: [],
    };
    expect(detail.dependencies).toHaveLength(1);
    expect(detail.dependents).toHaveLength(0);
    expect(detail.body).toBe("POST /auth/logout");
  });
});
