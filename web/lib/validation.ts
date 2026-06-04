/**
 * Read-only validation: report inconsistencies between DB and filesystem.
 *
 * validate() never mutates anything (not the DB, not the markdown).
 * For fixes, use rebuild() or syncOne() from rebuild.ts.
 *
 * Mirrors src/loom/validation.py.
 */

import { load } from "./storage";
import { qid_from_path } from "./ids";
import { Index, initDb, DB_FILENAME } from "./index";
import { walkMdFiles, hashFileBytes } from "./scan";
import { InvalidQualifiedId, ValidationError } from "./errors";
import * as path from "path";
import * as fs from "fs";

// ---------------------------------------------------------------------------
// Stable KIND constants — part of the JSON consumer contract.
// ---------------------------------------------------------------------------

export const KIND_BROKEN_DEP = "broken_dep";
export const KIND_DRIFT = "drift";
export const KIND_PATH_ID_MISMATCH = "path_id_mismatch";
export const KIND_TYPE_MISMATCH = "type_mismatch";
export const KIND_PARSE_ERROR = "parse_error";
export const KIND_STRAY_FILE = "stray_file";
export const KIND_MISSING_FIELD = "missing_field";
export const KIND_NOT_INDEXED = "not_indexed";
export const KIND_ORPHAN_INDEX = "orphan_index";

// ---------------------------------------------------------------------------
// ValidationIssue
// ---------------------------------------------------------------------------

export interface ValidationIssue {
  kind: string;
  qualified_id: string | null;
  file_path: string | null;
  message: string;
}

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

/**
 * Walk the filesystem and the index, returning every inconsistency found.
 * Never mutates the DB or any file.
 */
export async function validate(root: string): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];

  // Ensure DB exists so Index can open it.
  const dbPath = path.join(root, DB_FILENAME);
  if (!fs.existsSync(dbPath)) {
    initDb(dbPath);
  }

  const idx = new Index(root);
  const indexedQids = new Set(idx.allQualifiedIds());
  const indexedRecords = new Map<string, ReturnType<typeof idx.get>>();
  for (const qid of indexedQids) {
    indexedRecords.set(qid, idx.get(qid));
  }

  const seenQids = new Set<string>();

  for (const filePath of walkMdFiles(root)) {
    const rel = path.relative(root, filePath);
    let qid: ReturnType<typeof qid_from_path>[0];
    try {
      [qid] = qid_from_path(filePath, root);
    } catch (e) {
      if (e instanceof InvalidQualifiedId) {
        issues.push({ kind: KIND_STRAY_FILE, qualified_id: null, file_path: rel, message: String(e) });
      } else {
        issues.push({ kind: KIND_STRAY_FILE, qualified_id: null, file_path: rel, message: String(e) });
      }
      continue;
    }

    let fm: Record<string, unknown>;
    try {
      [fm] = load(filePath);
    } catch (e) {
      if (e instanceof ValidationError) {
        issues.push({ kind: KIND_PARSE_ERROR, qualified_id: qid.toString(), file_path: rel, message: String(e) });
      } else {
        issues.push({ kind: KIND_PARSE_ERROR, qualified_id: qid.toString(), file_path: rel, message: String(e) });
      }
      continue;
    }

    seenQids.add(qid.toString());

    // Frontmatter qualified_id / id mismatches with path.
    const fmQid = fm["qualified_id"];
    if (fmQid !== undefined && fmQid !== null && String(fmQid) !== qid.toString()) {
      issues.push({
        kind: KIND_PATH_ID_MISMATCH,
        qualified_id: qid.toString(),
        file_path: rel,
        message: `frontmatter qualified_id ${JSON.stringify(String(fmQid))} != path-derived ${JSON.stringify(qid.toString())}`,
      });
    }
    const fmLocal = fm["id"];
    if (fmLocal !== undefined && fmLocal !== null && String(fmLocal) !== qid.localId) {
      issues.push({
        kind: KIND_PATH_ID_MISMATCH,
        qualified_id: qid.toString(),
        file_path: rel,
        message: `frontmatter id ${JSON.stringify(String(fmLocal))} != path-derived ${JSON.stringify(qid.localId)}`,
      });
    }

    // Type mismatch.
    const fmType = fm["type"];
    if (fmType !== undefined && fmType !== null && String(fmType) !== qid.type) {
      issues.push({
        kind: KIND_TYPE_MISMATCH,
        qualified_id: qid.toString(),
        file_path: rel,
        message: `frontmatter type ${JSON.stringify(String(fmType))} != path-derived ${JSON.stringify(qid.type)}`,
      });
    }

    // Missing required fields.
    for (const fieldName of ["title", "created_at", "updated_at"]) {
      if (fm[fieldName] === undefined || fm[fieldName] === null) {
        issues.push({
          kind: KIND_MISSING_FIELD,
          qualified_id: qid.toString(),
          file_path: rel,
          message: `missing required field ${JSON.stringify(fieldName)}`,
        });
      }
    }
    if (qid.type !== "project" && (fm["status"] === undefined || fm["status"] === null)) {
      issues.push({
        kind: KIND_MISSING_FIELD,
        qualified_id: qid.toString(),
        file_path: rel,
        message: "missing required field 'status'",
      });
    }

    // Drift / not-indexed.
    const rec = indexedRecords.get(qid.toString()) ?? null;
    if (rec === null) {
      issues.push({
        kind: KIND_NOT_INDEXED,
        qualified_id: qid.toString(),
        file_path: rel,
        message: "file exists on disk but is not in the index; run `loom rebuild`",
      });
    } else {
      const onDisk = await hashFileBytes(filePath);
      if (rec.body_hash !== onDisk) {
        issues.push({
          kind: KIND_DRIFT,
          qualified_id: qid.toString(),
          file_path: rel,
          message: "on-disk content differs from indexed body_hash",
        });
      }
    }

    // Broken deps: read from frontmatter (source of truth) so we still
    // surface deps whose targets were missing at index time.
    const rawDeps = fm["depends_on"];
    const deps = Array.isArray(rawDeps) ? rawDeps.map(String) : [];
    for (const dep of deps) {
      if (!indexedQids.has(dep)) {
        issues.push({
          kind: KIND_BROKEN_DEP,
          qualified_id: qid.toString(),
          file_path: rel,
          message: `depends on missing item ${dep}`,
        });
      }
    }
  }

  // Index entries with no corresponding file.
  for (const qid of [...indexedQids].sort()) {
    if (!seenQids.has(qid)) {
      const rec = indexedRecords.get(qid) ?? null;
      issues.push({
        kind: KIND_ORPHAN_INDEX,
        qualified_id: qid,
        file_path: rec ? rec.file_path : null,
        message: "indexed but no matching file on disk; run `loom rebuild`",
      });
    }
  }

  return issues;
}
