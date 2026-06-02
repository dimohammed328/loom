/**
 * Typed fetch wrappers for the Loom API.
 *
 * All functions throw on non-2xx responses with a descriptive message.
 * The base URL defaults to the current origin (same-host FastAPI server).
 */

// ---------------------------------------------------------------------------
// Types — mirroring src/loom_web/schemas.py
// ---------------------------------------------------------------------------

export interface ProjectSummary {
  qid: string;
  title: string;
  repo: string | null;
  default_branch: string | null;
  archived: boolean;
}

export interface ItemRef {
  qid: string;
  type: string;
  title: string;
  status: string | null;
}

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
}

export interface TreeResponse {
  root: string;
  items: ItemNode[];
}

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

// ---------------------------------------------------------------------------
// Internal helper
// ---------------------------------------------------------------------------

async function apiFetch<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = (await res.json()) as { detail?: string };
      if (body.detail) detail = body.detail;
    } catch {
      /* ignore parse errors */
    }
    throw new Error(`API ${res.status}: ${detail} (${path})`);
  }
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** GET /api/projects — list all projects. */
export function listProjects(): Promise<ProjectSummary[]> {
  return apiFetch<ProjectSummary[]>("/api/projects");
}

/** GET /api/projects/{project}/tree — full epic→story→task tree. */
export function getProjectTree(projectQid: string): Promise<TreeResponse> {
  // The project segment is just the project name (slug), not the full qid.
  const slug = projectQid.split(":")[0];
  return apiFetch<TreeResponse>(`/api/projects/${encodeURIComponent(slug)}/tree`);
}

/** GET /api/items/{qid} — full item detail with body + deps + children. */
export function getItem(qid: string): Promise<ItemDetail> {
  return apiFetch<ItemDetail>(`/api/items/${qid}`);
}

/** GET /api/health — liveness probe. */
export function getHealth(): Promise<{ status: string }> {
  return apiFetch<{ status: string }>("/api/health");
}
