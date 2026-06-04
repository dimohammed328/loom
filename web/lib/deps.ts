/**
 * Dependency operations — read-side: ItemRef, computeDependencies,
 * computeDependents, computeBlockers, isPickable, wouldCreateCycle.
 *
 * Mirrors src/loom/deps.py (read-side portion).
 *
 * Rules:
 * - Only the literal string 'done' satisfies a dependency.
 * - computeBlockers reads deps from stored frontmatter (source of truth),
 *   not the dependencies table, so broken deps are still surfaced.
 * - A missing dep target counts as a blocker (a broken dep can never
 *   be satisfied).
 */

import { Index, IndexRecord } from "./index";
import { NotFound } from "./errors";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DONE_STATUS = "done";
export const MISSING_TYPE = "missing";

// ---------------------------------------------------------------------------
// ItemRef
// ---------------------------------------------------------------------------

/**
 * Lightweight summary of an item for list returns.
 * Mirrors deps.py ItemRef dataclass.
 */
export class ItemRef {
  readonly qualifiedId: string;
  readonly type: string;
  readonly title: string;
  readonly status: string | null;

  constructor(qualifiedId: string, type: string, title: string, status: string | null) {
    this.qualifiedId = qualifiedId;
    this.type = type;
    this.title = title;
    this.status = status;
  }

  static fromRecord(record: IndexRecord): ItemRef {
    return new ItemRef(record.qualified_id, record.type, record.title, record.status);
  }
}

// ---------------------------------------------------------------------------
// Read-side helpers
// ---------------------------------------------------------------------------

/** Read the declared depends_on list from a record's stored frontmatter. */
function declaredDeps(record: IndexRecord): string[] {
  try {
    const fm = JSON.parse(record.frontmatter_json) as Record<string, unknown>;
    const deps = fm["depends_on"];
    if (!Array.isArray(deps)) return [];
    return deps.map(String);
  } catch {
    return [];
  }
}

/** Materialize index records for qids, dropping any that are missing. */
function refsFor(idx: Index, qids: readonly string[]): ItemRef[] {
  const out: ItemRef[] = [];
  for (const qid of qids) {
    const rec = idx.get(qid);
    if (rec !== null) {
      out.push(ItemRef.fromRecord(rec));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public read-side API
// ---------------------------------------------------------------------------

/**
 * Return refs for every target that qualifiedId depends on.
 * Uses the DB dependencies table (index-derived; may be empty for broken deps).
 */
export function computeDependencies(idx: Index, qualifiedId: string): ItemRef[] {
  return refsFor(idx, idx.dependenciesOf(qualifiedId));
}

/**
 * Return refs for every source that depends on qualifiedId.
 */
export function computeDependents(idx: Index, qualifiedId: string): ItemRef[] {
  return refsFor(idx, idx.dependentsOf(qualifiedId));
}

/**
 * Return refs for the not-yet-satisfied dependencies of qualifiedId.
 *
 * Reads declared deps from frontmatter (the source of truth), so a broken
 * dep (target deleted) is still surfaced as a blocker with type='missing'.
 * Missing targets are returned as placeholder ItemRefs.
 */
export function computeBlockers(idx: Index, qualifiedId: string): ItemRef[] {
  const record = idx.get(qualifiedId);
  if (record === null) {
    throw new NotFound(qualifiedId);
  }
  const out: ItemRef[] = [];
  for (const depQid of declaredDeps(record)) {
    const target = idx.get(depQid);
    if (target === null) {
      out.push(new ItemRef(depQid, MISSING_TYPE, "(missing target)", null));
    } else if (target.status !== DONE_STATUS) {
      out.push(ItemRef.fromRecord(target));
    }
  }
  return out;
}

/**
 * True iff status=='ready', not archived, and every declared dep is done.
 *
 * A missing dep target counts as a blocker — a broken dep can never
 * be satisfied, so the source isn't safe to pick up.
 */
export function isPickable(idx: Index, qualifiedId: string): boolean {
  const record = idx.get(qualifiedId);
  if (record === null) {
    throw new NotFound(qualifiedId);
  }
  if (record.archived) return false;
  if (record.status !== "ready") return false;
  return computeBlockers(idx, qualifiedId).length === 0;
}

// ---------------------------------------------------------------------------
// Cycle detection
// ---------------------------------------------------------------------------

/**
 * If adding source -> target would close a cycle, return the cycle path.
 *
 * The path lists nodes in traversal order, starting and ending at source.
 * Returns null if no cycle would form.
 *
 * Self-loops are handled defensively: source == target returns a 2-element path.
 */
export function wouldCreateCycle(
  idx: Index,
  sourceQid: string,
  targetQid: string
): string[] | null {
  if (sourceQid === targetQid) {
    return [sourceQid, sourceQid];
  }

  // BFS forward from target through existing dep edges.
  // If we reach source, the new edge source->target would close a cycle.
  const visited = new Set<string>();
  const queue: Array<{ node: string; path: string[] }> = [
    { node: targetQid, path: [targetQid] },
  ];

  while (queue.length > 0) {
    const entry = queue.shift()!;
    const { node, path } = entry;
    if (visited.has(node)) continue;
    visited.add(node);

    for (const nxt of idx.dependenciesOf(node)) {
      if (nxt === sourceQid) {
        // Cycle found: source -> target -> ... -> nxt(=source)
        return [sourceQid, ...path, nxt];
      }
      queue.push({ node: nxt, path: [...path, nxt] });
    }
  }

  return null;
}
