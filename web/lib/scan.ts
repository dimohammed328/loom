/**
 * Filesystem scan: walk markdown files and turn them into IndexRecords.
 *
 * Mirrors src/loom/scan.py.
 * Used by rebuild.ts and validation.ts.
 */

import * as fs from "fs";
import * as path from "path";
import { load } from "./storage";
import { qid_from_path, ItemType, ARCHIVE_DIRNAME, PROJECTS_DIRNAME } from "./ids";
import { IndexRecord, frontmatterToJson } from "./index";

// ---------------------------------------------------------------------------
// walkMdFiles
// ---------------------------------------------------------------------------

/**
 * Return every .md file path under projects/ and _archive/projects/ in sorted
 * order. Files outside those subtrees are ignored.
 */
export function walkMdFiles(root: string): string[] {
  const candidates = [
    path.join(root, PROJECTS_DIRNAME),
    path.join(root, ARCHIVE_DIRNAME, PROJECTS_DIRNAME),
  ];
  const result: string[] = [];
  for (const base of candidates) {
    if (fs.existsSync(base)) {
      result.push(...collectMdFiles(base));
    }
  }
  return result;
}

function collectMdFiles(dir: string): string[] {
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  // Sort for deterministic ordering (mirrors Python's sorted() on rglob)
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectMdFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      results.push(full);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// hashFileBytes
// ---------------------------------------------------------------------------

/**
 * Return the sha256 hex digest of the raw on-disk bytes of filePath.
 *
 * Hashing the raw bytes (never the parsed-and-rerendered form) keeps
 * drift detection honest: an idempotent re-render would be spurious drift.
 */
export async function hashFileBytes(filePath: string): Promise<string> {
  const bytes = fs.readFileSync(filePath);
  const hashBuf = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ---------------------------------------------------------------------------
// buildRecord
// ---------------------------------------------------------------------------

/**
 * Construct an IndexRecord from a markdown file.
 *
 * Path wins over frontmatter: the qid is always derived from the path.
 * Missing optional fields fall back to sensible defaults:
 *   - missing status on a non-project defaults to "ready"
 *   - missing timestamps fall back to the file's mtime
 * repo / default_branch are only read for project items.
 */
export async function buildRecord(
  filePath: string,
  root: string
): Promise<IndexRecord> {
  const [qid, archived] = qid_from_path(filePath, root);
  const [fm] = load(filePath);

  const relPath = path.relative(root, filePath);
  const bodyHash = await hashFileBytes(filePath);

  const mtimeIso = pathMtimeIso(filePath);
  const created_at = optStr(fm["created_at"]) ?? mtimeIso;
  const updated_at = optStr(fm["updated_at"]) ?? mtimeIso;

  const title = optStr(fm["title"]) ?? `(untitled) ${qid.toString()}`;

  let status: string | null = null;
  if (qid.type !== ItemType.PROJECT) {
    status = optStr(fm["status"]) ?? "ready";
  }

  const parent = qid.parent;
  const parent_id = parent ? parent.toString() : null;

  const isProject = qid.type === ItemType.PROJECT;
  const repo = isProject ? optStr(fm["repo"]) ?? null : null;
  const default_branch = isProject ? optStr(fm["default_branch"]) ?? null : null;

  const rawDeps = fm["depends_on"];
  const depends_on = Array.isArray(rawDeps) ? rawDeps.map((x) => String(x)) : [];

  const rawTags = fm["tags"];
  const tags = Array.isArray(rawTags) ? rawTags.map((x) => String(x)) : [];

  return {
    qualified_id: qid.toString(),
    type: qid.type,
    project: qid.project,
    epic: qid.epic,
    story: qid.story,
    task: qid.task,
    parent_id,
    title,
    status,
    assignee: optStr(fm["assignee"]) ?? null,
    branch: optStr(fm["branch"]) ?? null,
    pr_url: optStr(fm["pr_url"]) ?? null,
    repo,
    default_branch,
    archived,
    created_at,
    updated_at,
    file_path: relPath,
    body_hash: bodyHash,
    frontmatter_json: frontmatterToJson(fm as Record<string, unknown>),
    depends_on,
    tags,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function optStr(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v);
  return s || null;
}

function pathMtimeIso(filePath: string): string {
  const mtimeMs = fs.statSync(filePath).mtimeMs;
  return new Date(mtimeMs).toISOString().replace(/\.\d{3}Z$/, "+00:00");
}
