/**
 * Serializers: map TS Loom library objects to loom-app response schemas.
 *
 * Mirrors src/loom_web/serializers.py — function signatures and output shapes
 * are identical so the Bun server produces JSON parity with the Python server.
 */

import type { Item, Project } from "../lib/items";
import { _Statused } from "../lib/items";
import { computeDependencies, computeDependents } from "../lib/deps";
import type { ItemRef as LoomItemRef } from "../lib/deps";
import { Index } from "../lib/index";
import type {
  ProjectSummary,
  ItemRef,
  ItemNode,
  TreeResponse,
  ItemDetail,
} from "./schemas";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeStatus(status: string | null | undefined): string | null {
  // Currently a passthrough — all statuses are valid as-is in the schema.
  return status ?? null;
}

// ---------------------------------------------------------------------------
// Public serializers
// ---------------------------------------------------------------------------

/** Map a loom Project item to a ProjectSummary schema. */
export function serializeProject(project: Project): ProjectSummary {
  return {
    qid: project.qualifiedId,
    title: project.title,
    repo: project.repo,
    default_branch: project.defaultBranch,
    archived: project.archived,
  };
}

/** Map a loom ItemRef (from deps) to an ItemRef schema. */
export function serializeItemRef(ref: LoomItemRef): ItemRef {
  return {
    qid: ref.qualifiedId,
    type: ref.type,
    title: ref.title,
    status: normalizeStatus(ref.status),
  };
}

/**
 * Map the dict returned by Loom.tree() to a TreeResponse schema.
 *
 * The incoming shape from loom.tree() is:
 *   { root: string, items: Array<{ qid, type, title, status, branch, pr_url,
 *     assignee, updated_at, deps, children }> }
 */
export function serializeTree(treeDict: { root: string; items: unknown[] }): TreeResponse {
  const nodes: ItemNode[] = (treeDict.items as Record<string, unknown>[]).map(
    (raw) =>
      ({
        qid: raw["qid"] as string,
        type: raw["type"] as string,
        title: (raw["title"] as string | undefined) ?? "",
        status: normalizeStatus(raw["status"] as string | null | undefined),
        assignee: (raw["assignee"] as string | null | undefined) ?? null,
        branch: (raw["branch"] as string | null | undefined) ?? null,
        pr_url: (raw["pr_url"] as string | null | undefined) ?? null,
        deps: (raw["deps"] as string[] | undefined) ?? [],
        children: (raw["children"] as string[] | undefined) ?? [],
        updated_at: (raw["updated_at"] as string | undefined) ?? "",
        created_at: (raw["created_at"] as string | undefined) ?? "",
      }) satisfies ItemNode
  );
  return { root: treeDict.root, items: nodes };
}

/**
 * Map a loom Item to an ItemDetail schema.
 *
 * The *children* list is passed in from outside (the router queries it
 * from the gateway) rather than being computed here, matching the pattern
 * from the Python router.
 */
export function serializeItemDetail(item: Item, children: string[]): ItemDetail {
  const r = item.record;
  let deps: ItemRef[] = [];
  let dependents: ItemRef[] = [];

  if (item instanceof _Statused) {
    const idx = new Index(item.root);
    deps = computeDependencies(idx, item.qualifiedId).map(serializeItemRef);
    dependents = computeDependents(idx, item.qualifiedId).map(serializeItemRef);
  }

  return {
    qid: r.qualified_id,
    type: r.type,
    title: r.title,
    status: normalizeStatus(r.status),
    assignee: r.assignee,
    branch: r.branch,
    pr_url: r.pr_url,
    tags: [...r.tags],
    archived: r.archived,
    body: item.body,
    dependencies: deps,
    dependents: dependents,
    children,
  };
}
