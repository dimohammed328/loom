/**
 * Loom facade — public API entrypoint.
 *
 * Wraps Index in a typed, hierarchy-aware API. Mirrors src/loom/api.py.
 *
 * Usage:
 *   const loom = new Loom(root);
 *   const project = await loom.createProject("acme", { title: "Acme" });
 *   const epic    = await project.createEpic({ title: "OAuth" });
 *   const story   = await epic.createStory({ title: "Backend" });
 *   const task    = await story.createTask({ title: "Wire Google" });
 *   task.complete();
 */

import * as fs from "fs";
import * as path from "path";
import { Index, SCHEMA_VERSION, currentVersion, initDb, DB_FILENAME } from "./index";
import {
  Item,
  Project,
  Epic,
  Story,
  Task,
  _Statused,
  itemFromRecord,
  itemsFromRecords,
  buildFrontmatter,
  createItemFile,
} from "./items";
import {
  QualifiedId,
  BACKLOG_EPIC_ID,
  parse_qid,
  path_from_qid,
  validate_project_name,
} from "./ids";
import { LoomError, NotFound, Duplicate } from "./errors";
import { rebuild as _rebuild, syncOne as _syncOne, RebuildResult } from "./rebuild";
import { validate as _validate } from "./validation";
import { ValidationIssue } from "./validation";
import {
  computeDependencies,
  descendants,
  topologicalSort,
} from "./deps";

export class Loom {
  private _root: string;
  private _index: Index;

  /**
   * Loom(root) — override LOOM_DIR.
   * Loom() — uses LOOM_DIR env or ~/.local/share/loom.
   *
   * Does NOT create the directory. If root does not exist, throws LoomError.
   * Stamps user_version if DB is at version 0 (unstamped).
   */
  constructor(root?: string) {
    const resolved = root ?? resolveRoot();
    if (!fs.existsSync(resolved)) {
      throw new LoomError(
        `loom root does not exist: ${resolved}. Run 'loom init' to create it.`
      );
    }
    this._root = resolved;
    this._index = new Index(resolved);

    // Stamp version if DB exists at version 0 (bypassed bootstrap).
    const dbPath = path.join(resolved, DB_FILENAME);
    if (fs.existsSync(dbPath) && currentVersion(dbPath) === 0) {
      initDb(dbPath); // idempotent — sets user_version = SCHEMA_VERSION
    }
  }

  // ----- properties --------------------------------------------------------

  get root(): string {
    return this._root;
  }

  get index(): Index {
    return this._index;
  }

  // ----- create ------------------------------------------------------------

  /**
   * Create a new project with a default backlog epic.
   * Throws Duplicate if the project already exists.
   */
  async createProject(
    name: string,
    opts: {
      title: string;
      body?: string;
      repo?: string | null;
      defaultBranch?: string | null;
    }
  ): Promise<Project> {
    validate_project_name(name);
    const qid = new QualifiedId(name);
    if (
      fs.existsSync(path_from_qid(qid, this._root, false)) ||
      fs.existsSync(path_from_qid(qid, this._root, true))
    ) {
      throw new Duplicate(name);
    }

    const fm = buildFrontmatter(qid, opts.title, null, {
      repo: opts.repo ?? null,
      default_branch: opts.defaultBranch ?? null,
    });
    const record = await createItemFile(this._root, qid, fm, opts.body ?? "");
    const project = new Project(this._root, record);

    // Auto-create backlog epic
    await project.createEpic({ title: "Backlog", epicId: BACKLOG_EPIC_ID });
    return project;
  }

  // ----- read --------------------------------------------------------------

  /** Look up one item by qualified id. Throws NotFound if absent. */
  get(qualifiedId: string): Item {
    parse_qid(qualifiedId);
    const record = this._index.get(qualifiedId);
    if (record === null) throw new NotFound(qualifiedId);
    return itemFromRecord(this._root, record);
  }

  /** Like get() but returns null instead of throwing. */
  getOrNone(qualifiedId: string): Item | null {
    parse_qid(qualifiedId);
    const record = this._index.get(qualifiedId);
    return record === null ? null : itemFromRecord(this._root, record);
  }

  /** Filter items by exact-match on indexed columns. */
  find(filters: {
    type?: string;
    status?: string;
    project?: string;
    assignee?: string;
    tag?: string;
    archived?: boolean;
  } = {}): Item[] {
    const records = this._index.find(filters);
    return itemsFromRecords(this._root, records);
  }

  /** Return all projects. */
  projects(): Project[] {
    return this.find({ type: "project" }).filter(
      (i): i is Project => i instanceof Project
    );
  }

  /**
   * Return a flat-array tree rooted at qualifiedId.
   *
   * Shape: { root: string, items: Array<{qid, type, title, status, branch,
   *   pr_url, assignee, updated_at, deps, children}> }
   */
  tree(
    qualifiedId: string,
    opts: { depth?: number; status?: string } = {}
  ): { root: string; items: unknown[] } {
    const rootRecord = this._index.get(qualifiedId);
    if (rootRecord === null) throw new NotFound(qualifiedId);

    const allRecords = [rootRecord, ...descendants(this._index, qualifiedId)];

    function depthBelowRoot(qid: string): number {
      return qid.split(":").length - qualifiedId.split(":").length;
    }

    let filtered = allRecords;
    if (opts.depth !== undefined) {
      filtered = filtered.filter((r) => depthBelowRoot(r.qualified_id) <= opts.depth!);
    }
    if (opts.status !== undefined) {
      filtered = filtered.filter((r) => r.status === opts.status);
    }

    const presentQids = new Set(filtered.map((r) => r.qualified_id));
    const items = filtered
      .slice()
      .sort((a, b) => a.qualified_id.localeCompare(b.qualified_id))
      .map((record) => {
        const prefix = record.qualified_id + ":";
        const children = [...presentQids]
          .filter(
            (q) =>
              q.startsWith(prefix) &&
              !q.slice(prefix.length).includes(":")
          )
          .sort();
        const deps = computeDependencies(this._index, record.qualified_id).map(
          (ref) => ref.qualifiedId
        );
        return {
          qid: record.qualified_id,
          type: record.type,
          title: record.title,
          status: record.status,
          branch: record.branch,
          pr_url: record.pr_url,
          assignee: record.assignee,
          updated_at: record.updated_at,
          deps,
          children,
        };
      });

    return { root: qualifiedId, items };
  }

  /**
   * Return descendants of qualifiedId in topological dep-order.
   *
   * Default scope: direct children. recursive=true: all descendants.
   * Done items excluded by default; pass includeDone=true to include.
   */
  async order(
    qualifiedId: string,
    opts: { recursive?: boolean; includeDone?: boolean } = {}
  ): Promise<Item[]> {
    const rootRecord = this._index.get(qualifiedId);
    if (rootRecord === null) throw new NotFound(qualifiedId);

    let allRecords = descendants(this._index, qualifiedId);

    if (!opts.recursive) {
      const prefix = qualifiedId + ":";
      allRecords = allRecords.filter((r) => {
        const rest = r.qualified_id.slice(prefix.length);
        return r.qualified_id.startsWith(prefix) && !rest.includes(":");
      });
    }

    if (!opts.includeDone) {
      allRecords = allRecords.filter((r) => r.status !== "done");
    }

    const ordered = topologicalSort(allRecords, this._index);
    return itemsFromRecords(this._root, ordered);
  }

  /** Return all status strings in use. */
  statuses(): string[] {
    return this._index.statuses();
  }

  /**
   * Return open/closed counts per item type for a project.
   * Shape: { project, epics: {open, closed}, stories: {…}, tasks: {…} }
   */
  projectStatus(projectName: string): {
    project: string;
    epics: { open: number; closed: number };
    stories: { open: number; closed: number };
    tasks: { open: number; closed: number };
  } {
    const projectRecord = this._index.get(projectName);
    if (projectRecord === null || projectRecord.type !== "project") {
      throw new NotFound(projectName);
    }

    const result: ReturnType<Loom["projectStatus"]> = {
      project: projectName,
      epics: { open: 0, closed: 0 },
      stories: { open: 0, closed: 0 },
      tasks: { open: 0, closed: 0 },
    };

    for (const [itemType, key] of [
      ["epic", "epics"],
      ["story", "stories"],
      ["task", "tasks"],
    ] as const) {
      const all = this._index.find({ type: itemType, project: projectName, archived: false });
      const closed = all.filter((r) => r.status === "done").length;
      result[key] = { open: all.length - closed, closed };
    }

    return result;
  }

  // ----- Phase 4: ready + close -------------------------------------------

  /**
   * Return pickable items: status='ready', not archived, all deps done.
   */
  ready(opts: {
    type?: string;
    tag?: string;
    limit?: number;
    parent?: string;
    recursive?: boolean;
  } = {}): Item[] {
    const candidates = this._index.findPickable({
      type: opts.type,
      tag: opts.tag,
      limit: undefined,
    });

    const out: Item[] = [];
    for (const record of candidates) {
      if (opts.parent !== undefined) {
        if (opts.recursive) {
          if (!record.qualified_id.startsWith(opts.parent + ":")) continue;
        } else {
          const rest = record.qualified_id.slice(opts.parent.length + 1);
          if (!record.qualified_id.startsWith(opts.parent + ":") || rest.includes(":")) continue;
        }
      }
      const item = itemFromRecord(this._root, record);
      if (item instanceof _Statused && item.isPickable()) {
        out.push(item);
        if (opts.limit !== undefined && out.length >= opts.limit) break;
      }
    }
    return out;
  }

  /**
   * Reset qualifiedId and all live descendants to status=ready and clear assignee.
   */
  reopen(qualifiedId: string): void {
    const rootRecord = this._index.get(qualifiedId);
    if (rootRecord === null) throw new NotFound(qualifiedId);

    const allRecords = [rootRecord, ...descendants(this._index, qualifiedId)].filter(
      (r) => !r.archived
    );

    for (const record of allRecords) {
      const item = itemFromRecord(this._root, record);
      if (item instanceof _Statused) {
        item.setStatus("ready");
        item.refresh().setAssignee(null);
      }
    }
  }

  /**
   * Close qualifiedId if every descendant is done.
   *
   * Returns true if closed, false if not all children are done or if the
   * container is empty (non-vacuous). Throws for projects (no status)
   * and tasks (no children).
   */
  closeIfChildrenDone(qualifiedId: string): boolean {
    const record = this._index.get(qualifiedId);
    if (record === null) throw new NotFound(qualifiedId);
    if (record.type === "project") {
      throw new LoomError("projects do not have a status to close");
    }
    if (record.type === "task") {
      throw new LoomError("tasks have no children; use .complete() directly");
    }

    const kids = descendants(this._index, qualifiedId);
    if (kids.length === 0) return false;
    if (!kids.every((r) => r.status === "done")) return false;

    const item = itemFromRecord(this._root, record);
    (item as _Statused).setStatus("done");
    return true;
  }

  // ----- maintenance -------------------------------------------------------

  /** Re-read one item from disk into the index. */
  async sync(qualifiedId: string): Promise<void> {
    await _syncOne(this._root, qualifiedId);
  }

  /** Drop and rebuild the index from the markdown tree. */
  async rebuild(): Promise<RebuildResult> {
    return _rebuild(this._root);
  }

  /** Return every inconsistency between the index and the filesystem. */
  async validate(): Promise<ValidationIssue[]> {
    return _validate(this._root);
  }
}

// ---------------------------------------------------------------------------
// Root resolution
// ---------------------------------------------------------------------------

function resolveRoot(): string {
  if (process.env["LOOM_DIR"]) return process.env["LOOM_DIR"];
  const xdg = process.env["XDG_DATA_HOME"];
  if (xdg) return path.join(xdg, "loom");
  return path.join(process.env["HOME"] ?? "~", ".local", "share", "loom");
}
