/**
 * Dependency operations — read-side and write-side.
 *
 * Mirrors src/loom/deps.py.
 *
 * Rules:
 * - Only the literal string 'done' satisfies a dependency.
 * - computeBlockers reads deps from stored frontmatter (source of truth),
 *   not the dependencies table, so broken deps are still surfaced.
 * - A missing dep target counts as a blocker (a broken dep can never
 *   be satisfied).
 * - Depending on a project is forbidden.
 * - Cycles are rejected at add time.
 */

import * as path from "path";
import { Index, IndexRecord } from "./index";
import { NotFound, LoomError, CycleError } from "./errors";
import { load, dump } from "./storage";
import { buildRecord } from "./scan";
import { syncOne } from "./rebuild";
import { parse_qid } from "./ids";

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

// ---------------------------------------------------------------------------
// Write-side helpers
// ---------------------------------------------------------------------------

/** Now-ISO string for updated_at bumps. */
function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

/**
 * Apply transform to the source's depends_on list, rewrite the file,
 * and re-sync the index.
 */
async function rewriteDependsOn(
  root: string,
  source: IndexRecord,
  transform: (existing: string[]) => string[]
): Promise<void> {
  const filePath = path.join(root, source.file_path);
  const [fm, body] = load(filePath);
  const existing = Array.isArray(fm["depends_on"])
    ? (fm["depends_on"] as unknown[]).map(String)
    : [];
  const newList = transform(existing);
  if (newList.length > 0) {
    fm["depends_on"] = newList;
  } else {
    delete fm["depends_on"];
  }
  fm["updated_at"] = nowIso();
  dump(filePath, fm, body);
  const record = await buildRecord(filePath, root);
  new Index(root).applyRecord(record);
}

// ---------------------------------------------------------------------------
// Write-side API
// ---------------------------------------------------------------------------

/**
 * Add a dependency edge: source depends on target.
 *
 * Validates: both exist; neither is a project; they are distinct;
 * no cycle would form. Idempotent if edge already exists.
 */
export async function addDependency(
  root: string,
  sourceQid: string,
  targetQid: string
): Promise<void> {
  parse_qid(sourceQid);
  parse_qid(targetQid);
  const idx = new Index(root);

  const source = idx.get(sourceQid);
  if (source === null) throw new NotFound(sourceQid);
  const target = idx.get(targetQid);
  if (target === null) throw new NotFound(targetQid);

  if (source.type === "project") {
    throw new LoomError(`projects cannot have dependencies (source: ${sourceQid})`);
  }
  if (target.type === "project") {
    throw new LoomError(`depending on a project is forbidden (target: ${targetQid})`);
  }
  if (sourceQid === targetQid) {
    throw new LoomError(`an item cannot depend on itself: ${sourceQid}`);
  }

  // Idempotent: already present
  if (source.depends_on.includes(targetQid)) return;

  const cycle = wouldCreateCycle(idx, sourceQid, targetQid);
  if (cycle !== null) {
    throw new CycleError(sourceQid, targetQid, cycle);
  }

  await rewriteDependsOn(root, source, (existing) => [...existing, targetQid]);
}

/**
 * Remove a dependency edge from source's depends_on list.
 *
 * Raises NotFound if the source doesn't exist or the edge is absent.
 */
export async function removeDependency(
  root: string,
  sourceQid: string,
  targetQid: string
): Promise<void> {
  parse_qid(sourceQid);
  parse_qid(targetQid);
  const idx = new Index(root);

  const source = idx.get(sourceQid);
  if (source === null) throw new NotFound(sourceQid);
  if (!source.depends_on.includes(targetQid)) {
    throw new NotFound(`${sourceQid} -> ${targetQid}`);
  }

  await rewriteDependsOn(root, source, (existing) =>
    existing.filter((t) => t !== targetQid)
  );
}

// ---------------------------------------------------------------------------
// Topological sort + descendants
// ---------------------------------------------------------------------------

/**
 * Return records in topological dep-order (dependencies first).
 *
 * Records at the same dep-rank are sorted by qualified_id for determinism.
 * Deps on items outside the input set are ignored.
 * If a cycle exists among the input set, remaining items are appended sorted.
 *
 * Mirrors deps.py topological_sort.
 */
export function topologicalSort(
  records: IndexRecord[],
  idx: Index
): IndexRecord[] {
  if (records.length === 0) return [];

  const qidSet = new Set(records.map((r) => r.qualified_id));
  const byQid = new Map(records.map((r) => [r.qualified_id, r]));

  // Build in-degree and adjacency restricted to input set.
  const inDegree = new Map<string, number>();
  const depsMap = new Map<string, string[]>(); // qid -> list of dependents

  for (const qid of qidSet) {
    inDegree.set(qid, 0);
    depsMap.set(qid, []);
  }
  for (const qid of qidSet) {
    for (const dep of idx.dependenciesOf(qid)) {
      if (qidSet.has(dep)) {
        inDegree.set(qid, (inDegree.get(qid) ?? 0) + 1);
        depsMap.get(dep)!.push(qid);
      }
    }
  }

  // Kahn's algorithm with deterministic ordering at each rank.
  let ready = [...qidSet]
    .filter((qid) => (inDegree.get(qid) ?? 0) === 0)
    .sort();
  const out: IndexRecord[] = [];

  while (ready.length > 0) {
    const nextReady: string[] = [];
    for (const qid of ready) {
      out.push(byQid.get(qid)!);
      for (const dependent of depsMap.get(qid) ?? []) {
        const newDeg = (inDegree.get(dependent) ?? 0) - 1;
        inDegree.set(dependent, newDeg);
        if (newDeg === 0) nextReady.push(dependent);
      }
    }
    ready = nextReady.sort();
  }

  // Fallback for cyclic remainder (sorted by qid for determinism).
  if (out.length !== records.length) {
    const emitted = new Set(out.map((r) => r.qualified_id));
    const remaining = records
      .filter((r) => !emitted.has(r.qualified_id))
      .sort((a, b) => a.qualified_id.localeCompare(b.qualified_id));
    out.push(...remaining);
  }

  return out;
}

/**
 * Return every item below parentQid in the hierarchy.
 *
 * Uses prefix matching: any item whose qualified_id starts with
 * parentQid + ":" is a descendant.
 *
 * Mirrors deps.py descendants.
 */
export function descendants(idx: Index, parentQid: string): IndexRecord[] {
  const project = parentQid.split(":")[0]!;
  const prefix = parentQid + ":";
  const all = idx.find({ project });
  return all.filter((r) => r.qualified_id.startsWith(prefix));
}
