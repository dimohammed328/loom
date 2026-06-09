/**
 * Response schemas for the loom-app Bun HTTP server.
 *
 * Mirrors src/loom_web/schemas.py — field names and nesting are identical
 * so the Bun server produces JSON shapes parity with the Python server.
 */

/** Sentinel version — lets tests import a runtime value to verify the module loads. */
export const SCHEMAS_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// GET /api/projects → ProjectSummary[]
// ---------------------------------------------------------------------------

/** Lightweight project descriptor returned by GET /api/projects. */
export interface ProjectSummary {
  qid: string;
  title: string;
  repo: string | null;
  default_branch: string | null;
  archived: boolean;
}

// ---------------------------------------------------------------------------
// Shared cross-reference
// ---------------------------------------------------------------------------

/** Minimal cross-reference used in dependency/dependent lists. */
export interface ItemRef {
  qid: string;
  type: string;
  title: string;
  status: string | null;
}

// ---------------------------------------------------------------------------
// GET /api/projects/{project}/tree → TreeResponse
// ---------------------------------------------------------------------------

/** One node in the project tree (no body). Used by TreeResponse.items. */
export interface ItemNode {
  qid: string;
  type: string;
  title: string;
  status: string | null;
  assignee: string | null;
  branch: string | null;
  pr_url: string | null;
  deps: string[];
  children: string[];
  updated_at: string;
  created_at: string;
}

/** Response shape for GET /api/projects/{project}/tree. */
export interface TreeResponse {
  root: string;
  items: ItemNode[];
}

// ---------------------------------------------------------------------------
// GET /api/items/{qid} → ItemDetail
// ---------------------------------------------------------------------------

/** Full item descriptor returned by GET /api/items/{qid}. */
export interface ItemDetail {
  qid: string;
  type: string;
  title: string;
  status: string | null;
  assignee: string | null;
  branch: string | null;
  pr_url: string | null;
  tags: string[];
  archived: boolean;
  body: string;
  dependencies: ItemRef[];
  dependents: ItemRef[];
  children: string[];
}
