/**
 * Bulk-load (rebuild) and per-item resync (syncOne).
 *
 * rebuild() is destructive on the DB (drop + repopulate) and may rewrite
 * a file's frontmatter when its qualified_id / id disagree with the
 * filesystem path — the path always wins.
 *
 * syncOne() is the single-file equivalent.
 *
 * Mirrors src/loom/rebuild.py.
 */

import * as fs from "fs";
import * as path from "path";
import { load, dump } from "./storage";
import { qid_from_path, parse_qid, path_from_qid } from "./ids";
import { Index, initDb, DB_FILENAME } from "./index";
import { buildRecord, walkMdFiles } from "./scan";
import { InvalidQualifiedId, NotFound, ValidationError } from "./errors";
import { KIND_BROKEN_DEP, KIND_PARSE_ERROR, KIND_STRAY_FILE, ValidationIssue } from "./validation";

// ---------------------------------------------------------------------------
// RebuildResult
// ---------------------------------------------------------------------------

export interface RebuildResult {
  indexed_count: number;
  rewrites: string[];
  issues: ValidationIssue[];
}

// ---------------------------------------------------------------------------
// rebuild
// ---------------------------------------------------------------------------

/**
 * Walk root and rebuild the index from scratch.
 *
 * Returns the count of indexed items, the list of file paths whose
 * frontmatter was rewritten (id mismatch), and the list of validation
 * issues encountered. Best-effort: parse errors and stray files become
 * issues but do not abort the rebuild.
 */
export async function rebuild(
  root: string,
  options?: { log?: (msg: string) => void }
): Promise<RebuildResult> {
  const log = options?.log;
  const issues: ValidationIssue[] = [];
  const rewrites: string[] = [];
  const records = [];

  // Ensure DB exists.
  const dbPath = path.join(root, DB_FILENAME);
  if (!fs.existsSync(dbPath)) {
    initDb(dbPath);
  }

  for (const filePath of walkMdFiles(root)) {
    const rel = path.relative(root, filePath);
    let qid: ReturnType<typeof qid_from_path>[0];
    try {
      [qid] = qid_from_path(filePath, root);
    } catch (e) {
      issues.push({
        kind: KIND_STRAY_FILE,
        qualified_id: null,
        file_path: rel,
        message: String(e),
      });
      continue;
    }

    let fm: Record<string, unknown>;
    let body: string;
    try {
      [fm, body] = load(filePath);
    } catch (e) {
      issues.push({
        kind: KIND_PARSE_ERROR,
        qualified_id: qid.toString(),
        file_path: rel,
        message: String(e),
      });
      continue;
    }

    if (rewriteIdFieldsIfNeeded(fm, qid)) {
      dump(filePath, fm, body);
      rewrites.push(rel);
      if (log) log(`rewrote: ${rel} (id mismatch)`);
    }

    let record;
    try {
      record = await buildRecord(filePath, root);
    } catch (e) {
      issues.push({
        kind: KIND_PARSE_ERROR,
        qualified_id: qid.toString(),
        file_path: rel,
        message: String(e),
      });
      continue;
    }

    records.push(record);
  }

  const idx = new Index(root);
  const brokenDeps = idx.replaceAll(records);
  const recordById = new Map(records.map((r) => [r.qualified_id, r]));
  for (const [sourceId, targetId] of brokenDeps) {
    const rec = recordById.get(sourceId);
    issues.push({
      kind: KIND_BROKEN_DEP,
      qualified_id: sourceId,
      file_path: rec ? rec.file_path : null,
      message: `depends on missing item ${targetId}`,
    });
  }

  return {
    indexed_count: records.length,
    rewrites,
    issues,
  };
}

// ---------------------------------------------------------------------------
// syncOne
// ---------------------------------------------------------------------------

/**
 * Re-read the file backing qualifiedId and apply it to the index.
 *
 * If the file no longer exists in either projects/ or _archive/projects/,
 * the index entry is dropped. Throws NotFound if the item is unknown and
 * the file doesn't exist either.
 */
export async function syncOne(root: string, qualifiedId: string): Promise<void> {
  const qid = parse_qid(qualifiedId);
  const livePath = path_from_qid(qid, root, false);
  const archivedPath = path_from_qid(qid, root, true);

  let filePath: string | null = null;
  if (fs.existsSync(livePath)) {
    filePath = livePath;
  } else if (fs.existsSync(archivedPath)) {
    filePath = archivedPath;
  }

  const idx = new Index(root);
  if (filePath === null) {
    if (!idx.has(qualifiedId)) {
      throw new NotFound(qualifiedId);
    }
    idx.delete(qualifiedId);
    return;
  }

  const record = await buildRecord(filePath, root);
  idx.applyRecord(record);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Mutate fm in place to align id/qualified_id with the path-derived qid.
 * Returns true if any change was made.
 */
function rewriteIdFieldsIfNeeded(
  fm: Record<string, unknown>,
  qid: ReturnType<typeof qid_from_path>[0]
): boolean {
  const expectedQid = qid.toString();
  const expectedLocal = qid.localId;
  let changed = false;
  if (String(fm["qualified_id"] ?? "") !== expectedQid) {
    fm["qualified_id"] = expectedQid;
    changed = true;
  }
  if (String(fm["id"] ?? "") !== expectedLocal) {
    fm["id"] = expectedLocal;
    changed = true;
  }
  return changed;
}
