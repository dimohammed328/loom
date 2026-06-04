/**
 * SQLite index for the loom store — mirrors src/loom/index.py.
 *
 * The index is a *derived* artifact: anything in it must also be present in
 * the source-of-truth markdown files under $LOOM_DIR/projects (or
 * _archive/projects). Index.replaceAll regenerates the index from the
 * filesystem with no data loss.
 *
 * Uses bun:sqlite — available in Bun runtime only.
 */

import { Database } from "bun:sqlite";
import * as path from "path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DB_FILENAME = "loom.db";
export const SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const TABLE_NAMES = ["dependencies", "tags", "items"] as const; // drop-order-safe

const SCHEMA_STMTS = [
  `CREATE TABLE IF NOT EXISTS items (
    qualified_id     TEXT PRIMARY KEY,
    type             TEXT NOT NULL CHECK (type IN ('project','epic','story','task')),
    project          TEXT NOT NULL,
    epic             TEXT,
    story            INTEGER,
    task             INTEGER,
    parent_id        TEXT,
    title            TEXT NOT NULL,
    status           TEXT,
    assignee         TEXT,
    branch           TEXT,
    pr_url           TEXT,
    repo             TEXT,
    default_branch   TEXT,
    archived         INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL,
    file_path        TEXT NOT NULL UNIQUE,
    body_hash        TEXT NOT NULL,
    frontmatter_json TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_items_status   ON items(status)",
  "CREATE INDEX IF NOT EXISTS idx_items_type     ON items(type)",
  "CREATE INDEX IF NOT EXISTS idx_items_parent   ON items(parent_id)",
  "CREATE INDEX IF NOT EXISTS idx_items_project  ON items(project)",
  "CREATE INDEX IF NOT EXISTS idx_items_assignee ON items(assignee)",
  "CREATE INDEX IF NOT EXISTS idx_items_archived ON items(archived)",
  `CREATE TABLE IF NOT EXISTS dependencies (
    source_id   TEXT NOT NULL REFERENCES items(qualified_id) ON DELETE CASCADE,
    target_id   TEXT NOT NULL REFERENCES items(qualified_id) ON DELETE CASCADE,
    created_at  TEXT NOT NULL,
    PRIMARY KEY (source_id, target_id)
  )`,
  "CREATE INDEX IF NOT EXISTS idx_dep_target ON dependencies(target_id)",
  `CREATE TABLE IF NOT EXISTS tags (
    item_id TEXT NOT NULL REFERENCES items(qualified_id) ON DELETE CASCADE,
    tag     TEXT NOT NULL,
    PRIMARY KEY (item_id, tag)
  )`,
  "CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag)",
];

// ---------------------------------------------------------------------------
// IndexRecord
// ---------------------------------------------------------------------------

/**
 * One row's worth of data, plus its associated deps and tags.
 *
 * body_hash MUST be the sha256 of the raw on-disk file bytes (not the
 * parsed-and-rerendered form), so that an idempotent re-render does not
 * look like drift.
 *
 * frontmatter_json is a plain JSON serialization of the full frontmatter,
 * used for round-trip preservation of unknown keys.
 */
export interface IndexRecord {
  qualified_id: string;
  type: string;
  project: string;
  epic: string | null;
  story: number | null;
  task: number | null;
  parent_id: string | null;
  title: string;
  status: string | null;
  assignee: string | null;
  branch: string | null;
  pr_url: string | null;
  repo: string | null;
  default_branch: string | null;
  archived: boolean;
  created_at: string;
  updated_at: string;
  file_path: string;
  body_hash: string;
  frontmatter_json: string;
  depends_on: string[];
  tags: string[];
}

// ---------------------------------------------------------------------------
// Connection / DB helpers
// ---------------------------------------------------------------------------

function openDb(dbPath: string): Database {
  const db = new Database(dbPath);
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = NORMAL");
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA busy_timeout = 5000");
  return db;
}

function createSchema(db: Database): void {
  for (const stmt of SCHEMA_STMTS) {
    db.run(stmt);
  }
}

function dropSchema(db: Database): void {
  for (const table of TABLE_NAMES) {
    db.run(`DROP TABLE IF EXISTS ${table}`);
  }
}

export function currentVersion(dbPath: string): number {
  const db = openDb(dbPath);
  try {
    const row = db.query("PRAGMA user_version").get() as { user_version: number };
    return row.user_version;
  } finally {
    db.close();
  }
}

function setVersion(dbPath: string, version: number): void {
  // PRAGMA user_version doesn't accept bound parameters; embed literally.
  const db = openDb(dbPath);
  try {
    db.run(`PRAGMA user_version = ${Math.trunc(version)}`);
  } finally {
    db.close();
  }
}

export function initDb(dbPath: string): void {
  const db = openDb(dbPath);
  try {
    createSchema(db);
  } finally {
    db.close();
  }
  setVersion(dbPath, SCHEMA_VERSION);
}

// ---------------------------------------------------------------------------
// Row columns (same order as Python's _ITEM_COLUMNS)
// ---------------------------------------------------------------------------

const ITEM_COLUMNS = [
  "qualified_id",
  "type",
  "project",
  "epic",
  "story",
  "task",
  "parent_id",
  "title",
  "status",
  "assignee",
  "branch",
  "pr_url",
  "repo",
  "default_branch",
  "archived",
  "created_at",
  "updated_at",
  "file_path",
  "body_hash",
  "frontmatter_json",
] as const;

type ItemRow = {
  qualified_id: string;
  type: string;
  project: string;
  epic: string | null;
  story: number | null;
  task: number | null;
  parent_id: string | null;
  title: string;
  status: string | null;
  assignee: string | null;
  branch: string | null;
  pr_url: string | null;
  repo: string | null;
  default_branch: string | null;
  archived: number;
  created_at: string;
  updated_at: string;
  file_path: string;
  body_hash: string;
  frontmatter_json: string;
};

function rowToRecord(
  row: ItemRow,
  deps: string[] = [],
  tags: string[] = []
): IndexRecord {
  return {
    qualified_id: row.qualified_id,
    type: row.type,
    project: row.project,
    epic: row.epic,
    story: row.story,
    task: row.task,
    parent_id: row.parent_id,
    title: row.title,
    status: row.status,
    assignee: row.assignee,
    branch: row.branch,
    pr_url: row.pr_url,
    repo: row.repo,
    default_branch: row.default_branch,
    archived: row.archived !== 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
    file_path: row.file_path,
    body_hash: row.body_hash,
    frontmatter_json: row.frontmatter_json,
    depends_on: deps,
    tags: tags,
  };
}

function recordValues(r: IndexRecord): (string | number | null)[] {
  return [
    r.qualified_id,
    r.type,
    r.project,
    r.epic,
    r.story,
    r.task,
    r.parent_id,
    r.title,
    r.status,
    r.assignee,
    r.branch,
    r.pr_url,
    r.repo,
    r.default_branch,
    r.archived ? 1 : 0,
    r.created_at,
    r.updated_at,
    r.file_path,
    r.body_hash,
    r.frontmatter_json,
  ];
}

function selectDeps(db: Database, itemId: string): string[] {
  const rows = db
    .query(
      "SELECT target_id FROM dependencies WHERE source_id = ? ORDER BY target_id"
    )
    .all(itemId) as { target_id: string }[];
  return rows.map((r) => r.target_id);
}

function selectTags(db: Database, itemId: string): string[] {
  const rows = db
    .query("SELECT tag FROM tags WHERE item_id = ? ORDER BY tag")
    .all(itemId) as { tag: string }[];
  return rows.map((r) => r.tag);
}

// ---------------------------------------------------------------------------
// Index facade
// ---------------------------------------------------------------------------

/**
 * High-level handle to the SQLite index for a loom root.
 * root is the $LOOM_DIR path; the db lives at root/loom.db.
 */
export class Index {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  get dbPath(): string {
    return path.join(this.root, DB_FILENAME);
  }

  /** Create any missing tables/indexes. Safe to call repeatedly. */
  ensureSchema(): void {
    const db = openDb(this.dbPath);
    try {
      createSchema(db);
    } finally {
      db.close();
    }
  }

  // ----- single-record write -------------------------------------------

  /**
   * Insert or replace one item plus its tags and outgoing deps.
   *
   * Only this item's *outgoing* dependency edges and tags are owned by its
   * frontmatter and therefore replaced here. Incoming edges (where this item
   * is a target) are owned by other items and left alone — UPSERT instead
   * of DELETE+INSERT is load-bearing: deleting the items row would CASCADE
   * to incoming edges.
   *
   * Dependency targets MUST already exist in the index, otherwise a
   * constraint violation is thrown. Use replaceAll for bulk loads.
   */
  applyRecord(record: IndexRecord): void {
    const db = openDb(this.dbPath);
    try {
      createSchema(db);
      const cols = ITEM_COLUMNS.join(", ");
      const placeholders = ITEM_COLUMNS.map(() => "?").join(", ");
      const updateSet = ITEM_COLUMNS.filter((c) => c !== "qualified_id")
        .map((c) => `${c}=excluded.${c}`)
        .join(", ");
      db.run(
        `INSERT INTO items (${cols}) VALUES (${placeholders}) ` +
          `ON CONFLICT(qualified_id) DO UPDATE SET ${updateSet}`,
        recordValues(record)
      );
      db.run("DELETE FROM tags WHERE item_id = ?", [record.qualified_id]);
      db.run("DELETE FROM dependencies WHERE source_id = ?", [
        record.qualified_id,
      ]);
      for (const tag of record.tags) {
        db.run("INSERT OR IGNORE INTO tags (item_id, tag) VALUES (?, ?)", [
          record.qualified_id,
          tag,
        ]);
      }
      for (const dep of record.depends_on) {
        db.run(
          "INSERT INTO dependencies (source_id, target_id, created_at) VALUES (?, ?, ?)",
          [record.qualified_id, dep, record.updated_at]
        );
      }
    } finally {
      db.close();
    }
  }

  delete(qualifiedId: string): void {
    const db = openDb(this.dbPath);
    try {
      db.run("DELETE FROM items WHERE qualified_id = ?", [qualifiedId]);
    } finally {
      db.close();
    }
  }

  // ----- queries -------------------------------------------------------

  get(qualifiedId: string): IndexRecord | null {
    const db = openDb(this.dbPath);
    try {
      createSchema(db);
      const row = db
        .query("SELECT * FROM items WHERE qualified_id = ?")
        .get(qualifiedId) as ItemRow | null;
      if (row === null) return null;
      return rowToRecord(
        row,
        selectDeps(db, qualifiedId),
        selectTags(db, qualifiedId)
      );
    } finally {
      db.close();
    }
  }

  has(qualifiedId: string): boolean {
    const db = openDb(this.dbPath);
    try {
      createSchema(db);
      const row = db
        .query("SELECT 1 FROM items WHERE qualified_id = ? LIMIT 1")
        .get(qualifiedId);
      return row !== null;
    } finally {
      db.close();
    }
  }

  find(filters: {
    type?: string;
    status?: string;
    project?: string;
    assignee?: string;
    archived?: boolean;
    tag?: string;
  } = {}): IndexRecord[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    let joins = "";
    if (filters.tag !== undefined) {
      joins = " JOIN tags ON tags.item_id = items.qualified_id";
      clauses.push("tags.tag = ?");
      params.push(filters.tag);
    }
    if (filters.type !== undefined) {
      clauses.push("items.type = ?");
      params.push(filters.type);
    }
    if (filters.status !== undefined) {
      clauses.push("items.status = ?");
      params.push(filters.status);
    }
    if (filters.project !== undefined) {
      clauses.push("items.project = ?");
      params.push(filters.project);
    }
    if (filters.assignee !== undefined) {
      clauses.push("items.assignee = ?");
      params.push(filters.assignee);
    }
    if (filters.archived !== undefined) {
      clauses.push("items.archived = ?");
      params.push(filters.archived ? 1 : 0);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    const sql = `SELECT items.* FROM items${joins}${where} ORDER BY items.qualified_id`;
    const db = openDb(this.dbPath);
    try {
      createSchema(db);
      const rows = db.query(sql).all(...params) as ItemRow[];
      return rows.map((row) =>
        rowToRecord(
          row,
          selectDeps(db, row.qualified_id),
          selectTags(db, row.qualified_id)
        )
      );
    } finally {
      db.close();
    }
  }

  allQualifiedIds(): string[] {
    const db = openDb(this.dbPath);
    try {
      createSchema(db);
      const rows = db
        .query("SELECT qualified_id FROM items ORDER BY qualified_id")
        .all() as { qualified_id: string }[];
      return rows.map((r) => r.qualified_id);
    } finally {
      db.close();
    }
  }

  allDependencies(): [string, string][] {
    const db = openDb(this.dbPath);
    try {
      createSchema(db);
      const rows = db
        .query(
          "SELECT source_id, target_id FROM dependencies ORDER BY source_id, target_id"
        )
        .all() as { source_id: string; target_id: string }[];
      return rows.map((r) => [r.source_id, r.target_id]);
    } finally {
      db.close();
    }
  }

  // ----- dependency helpers -------------------------------------------

  /** Targets that qualifiedId depends on, sorted by qid. */
  dependenciesOf(qualifiedId: string): string[] {
    const db = openDb(this.dbPath);
    try {
      createSchema(db);
      return selectDeps(db, qualifiedId);
    } finally {
      db.close();
    }
  }

  /** Sources that depend on qualifiedId, sorted by qid. */
  dependentsOf(qualifiedId: string): string[] {
    const db = openDb(this.dbPath);
    try {
      createSchema(db);
      const rows = db
        .query(
          "SELECT source_id FROM dependencies WHERE target_id = ? ORDER BY source_id"
        )
        .all(qualifiedId) as { source_id: string }[];
      return rows.map((r) => r.source_id);
    } finally {
      db.close();
    }
  }

  /**
   * Items with status='ready', not archived, and every dep done.
   * Only the literal 'done' status satisfies — custom statuses do not.
   */
  findPickable(filters: {
    type?: string;
    tag?: string;
    limit?: number;
  } = {}): IndexRecord[] {
    const clauses = ["items.status = 'ready'", "items.archived = 0"];
    const params: (string | number)[] = [];
    let joins = "";
    if (filters.tag !== undefined) {
      joins = " JOIN tags ON tags.item_id = items.qualified_id";
      clauses.push("tags.tag = ?");
      params.push(filters.tag);
    }
    if (filters.type !== undefined) {
      clauses.push("items.type = ?");
      params.push(filters.type);
    }
    // Exclude items with at least one not-yet-done dep target.
    clauses.push(
      "NOT EXISTS (" +
        "  SELECT 1 FROM dependencies d " +
        "  JOIN items t ON t.qualified_id = d.target_id " +
        "  WHERE d.source_id = items.qualified_id " +
        "    AND (t.status IS NULL OR t.status != 'done')" +
        ")"
    );
    const where = " WHERE " + clauses.join(" AND ");
    let orderLimit = " ORDER BY items.qualified_id";
    if (filters.limit !== undefined) {
      orderLimit += " LIMIT ?";
      params.push(filters.limit);
    }
    const sql = `SELECT items.* FROM items${joins}${where}${orderLimit}`;
    const db = openDb(this.dbPath);
    try {
      createSchema(db);
      const rows = db.query(sql).all(...params) as ItemRow[];
      return rows.map((row) =>
        rowToRecord(
          row,
          selectDeps(db, row.qualified_id),
          selectTags(db, row.qualified_id)
        )
      );
    } finally {
      db.close();
    }
  }

  /** Every distinct non-null status in the index, sorted. */
  statuses(): string[] {
    const db = openDb(this.dbPath);
    try {
      createSchema(db);
      const rows = db
        .query(
          "SELECT DISTINCT status FROM items WHERE status IS NOT NULL ORDER BY status"
        )
        .all() as { status: string }[];
      return rows.map((r) => r.status);
    } finally {
      db.close();
    }
  }

  // ----- bulk load ----------------------------------------------------

  /**
   * Drop every table and repopulate from records. Used by rebuild.
   * Returns the list of (source_id, target_id) edges that could not be
   * inserted because the target was missing.
   */
  replaceAll(records: IndexRecord[]): [string, string][] {
    const broken: [string, string][] = [];
    const db = openDb(this.dbPath);
    try {
      dropSchema(db);
      createSchema(db);
      const cols = ITEM_COLUMNS.join(", ");
      const placeholders = ITEM_COLUMNS.map(() => "?").join(", ");
      const insertItem = db.prepare(
        `INSERT INTO items (${cols}) VALUES (${placeholders})`
      );
      const insertTag = db.prepare(
        "INSERT OR IGNORE INTO tags (item_id, tag) VALUES (?, ?)"
      );
      const insertDep = db.prepare(
        "INSERT INTO dependencies (source_id, target_id, created_at) VALUES (?, ?, ?)"
      );
      // Pass 1: items + tags.
      for (const r of records) {
        insertItem.run(...recordValues(r));
        for (const tag of r.tags) {
          insertTag.run(r.qualified_id, tag);
        }
      }
      // Pass 2: dependencies (all items exist now).
      for (const r of records) {
        for (const dep of r.depends_on) {
          try {
            insertDep.run(r.qualified_id, dep, r.updated_at);
          } catch {
            broken.push([r.qualified_id, dep]);
          }
        }
      }
    } finally {
      db.close();
    }
    // Re-stamp user_version after dropping tables.
    setVersion(this.dbPath, SCHEMA_VERSION);
    return broken;
  }
}

// ---------------------------------------------------------------------------
// JSON helpers (mirrors index.py to_plain / frontmatter_to_json)
// ---------------------------------------------------------------------------

export function toPlain(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === "boolean" || typeof obj === "number" || typeof obj === "string") return obj;
  if (Array.isArray(obj)) return obj.map(toPlain);
  if (typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      out[String(k)] = toPlain(v);
    }
    return out;
  }
  return obj;
}

export function frontmatterToJson(fm: Record<string, unknown>): string {
  return JSON.stringify(toPlain(fm));
}
