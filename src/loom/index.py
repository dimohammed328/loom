"""SQLite index for the loom store.

The index is a *derived* artifact: anything in it must also be present in
the source-of-truth markdown files under ``$LOOM_DIR/projects`` (or
``_archive/projects``). :meth:`Index.rebuild` regenerates the index from
the filesystem with no data loss.

Phase 2 covers schema, ``apply_record``, ``get``/``find``, ``statuses``,
and ``rebuild``. Per-item mutators (``set_status`` etc.) come in Phase 3.
"""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

DB_FILENAME = "loom.db"
SCHEMA_VERSION = 1

_PRAGMAS = (
    "PRAGMA journal_mode = WAL",
    "PRAGMA synchronous = NORMAL",
    "PRAGMA foreign_keys = ON",
    "PRAGMA busy_timeout = 5000",
)

_TABLE_NAMES = ("dependencies", "tags", "items")  # drop-order-safe (deps/tags first)

_SCHEMA = (
    """
    CREATE TABLE IF NOT EXISTS items (
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
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_items_status   ON items(status)",
    "CREATE INDEX IF NOT EXISTS idx_items_type     ON items(type)",
    "CREATE INDEX IF NOT EXISTS idx_items_parent   ON items(parent_id)",
    "CREATE INDEX IF NOT EXISTS idx_items_project  ON items(project)",
    "CREATE INDEX IF NOT EXISTS idx_items_assignee ON items(assignee)",
    "CREATE INDEX IF NOT EXISTS idx_items_archived ON items(archived)",
    """
    CREATE TABLE IF NOT EXISTS dependencies (
      source_id   TEXT NOT NULL REFERENCES items(qualified_id) ON DELETE CASCADE,
      target_id   TEXT NOT NULL REFERENCES items(qualified_id) ON DELETE CASCADE,
      created_at  TEXT NOT NULL,
      PRIMARY KEY (source_id, target_id)
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_dep_target ON dependencies(target_id)",
    """
    CREATE TABLE IF NOT EXISTS tags (
      item_id TEXT NOT NULL REFERENCES items(qualified_id) ON DELETE CASCADE,
      tag     TEXT NOT NULL,
      PRIMARY KEY (item_id, tag)
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag)",
)


# ---------------------------------------------------------------------------
# IndexRecord
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class IndexRecord:
    """One row's worth of data, plus its associated deps and tags.

    ``body_hash`` MUST be the sha256 of the raw on-disk file bytes (not
    the parsed-and-rerendered form), so that an idempotent re-render
    does not look like drift.

    ``frontmatter_json`` is a plain-Python JSON serialization of the
    full frontmatter, used for round-trip preservation of unknown keys
    when items are read back through the API.
    """

    qualified_id: str
    type: str
    project: str
    epic: str | None
    story: int | None
    task: int | None
    parent_id: str | None
    title: str
    status: str | None
    assignee: str | None
    branch: str | None
    pr_url: str | None
    repo: str | None
    default_branch: str | None
    archived: bool
    created_at: str
    updated_at: str
    file_path: str
    body_hash: str
    frontmatter_json: str
    depends_on: tuple[str, ...] = field(default_factory=tuple)
    tags: tuple[str, ...] = field(default_factory=tuple)


# ---------------------------------------------------------------------------
# Connection helpers
# ---------------------------------------------------------------------------


def db_path(root: Path) -> Path:
    return root / DB_FILENAME


@contextmanager
def connect(path: Path) -> Iterator[sqlite3.Connection]:
    """Open a connection with loom's standard pragmas applied.

    Commits on clean exit, rolls back on exception, and always closes.
    """
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    for pragma in _PRAGMAS:
        conn.execute(pragma)
    try:
        yield conn
        conn.commit()
    except BaseException:
        conn.rollback()
        raise
    finally:
        conn.close()


def current_version(path: Path) -> int:
    with connect(path) as conn:
        (version,) = conn.execute("PRAGMA user_version").fetchone()
        return int(version)


def set_version(path: Path, version: int) -> None:
    # PRAGMA user_version doesn't accept bound parameters; the value must
    # be embedded literally. We int() it to keep that safe.
    with connect(path) as conn:
        conn.execute(f"PRAGMA user_version = {int(version)}")


def init_db(path: Path) -> None:
    """Create a fresh DB at *path* with the schema applied and stamped."""
    with connect(path) as conn:
        _create_schema(conn)
    set_version(path, SCHEMA_VERSION)


# ---------------------------------------------------------------------------
# Schema management
# ---------------------------------------------------------------------------


def _create_schema(conn: sqlite3.Connection) -> None:
    for stmt in _SCHEMA:
        conn.execute(stmt)


def _drop_schema(conn: sqlite3.Connection) -> None:
    for table in _TABLE_NAMES:
        conn.execute(f"DROP TABLE IF EXISTS {table}")


# ---------------------------------------------------------------------------
# Row ↔ record conversion
# ---------------------------------------------------------------------------


_ITEM_COLUMNS = (
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
)


def _row_to_record(
    row: sqlite3.Row,
    *,
    deps: tuple[str, ...] = (),
    tags: tuple[str, ...] = (),
) -> IndexRecord:
    return IndexRecord(
        qualified_id=row["qualified_id"],
        type=row["type"],
        project=row["project"],
        epic=row["epic"],
        story=row["story"],
        task=row["task"],
        parent_id=row["parent_id"],
        title=row["title"],
        status=row["status"],
        assignee=row["assignee"],
        branch=row["branch"],
        pr_url=row["pr_url"],
        repo=row["repo"],
        default_branch=row["default_branch"],
        archived=bool(row["archived"]),
        created_at=row["created_at"],
        updated_at=row["updated_at"],
        file_path=row["file_path"],
        body_hash=row["body_hash"],
        frontmatter_json=row["frontmatter_json"],
        depends_on=deps,
        tags=tags,
    )


def _record_values(r: IndexRecord) -> tuple:
    return (
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
        1 if r.archived else 0,
        r.created_at,
        r.updated_at,
        r.file_path,
        r.body_hash,
        r.frontmatter_json,
    )


def _insert_item(conn: sqlite3.Connection, r: IndexRecord) -> None:
    placeholders = ",".join("?" * len(_ITEM_COLUMNS))
    cols = ",".join(_ITEM_COLUMNS)
    conn.execute(
        f"INSERT INTO items ({cols}) VALUES ({placeholders})",
        _record_values(r),
    )


def _upsert_item(conn: sqlite3.Connection, r: IndexRecord) -> None:
    """Insert or update one items row in place.

    UPSERT (instead of DELETE + INSERT) is load-bearing: deleting the
    items row would CASCADE to incoming dependency edges via the FK, but
    incoming edges are owned by *other* items' frontmatter — wiping
    them here would silently lose those edges.
    """
    cols = ",".join(_ITEM_COLUMNS)
    placeholders = ",".join("?" * len(_ITEM_COLUMNS))
    update = ",".join(f"{c}=excluded.{c}" for c in _ITEM_COLUMNS if c != "qualified_id")
    conn.execute(
        f"INSERT INTO items ({cols}) VALUES ({placeholders}) "
        f"ON CONFLICT(qualified_id) DO UPDATE SET {update}",
        _record_values(r),
    )


def _delete_item(conn: sqlite3.Connection, qualified_id: str) -> None:
    # ON DELETE CASCADE clears related deps + tags.
    conn.execute("DELETE FROM items WHERE qualified_id = ?", (qualified_id,))


def _insert_tag(conn: sqlite3.Connection, item_id: str, tag: str) -> None:
    conn.execute(
        "INSERT OR IGNORE INTO tags (item_id, tag) VALUES (?, ?)",
        (item_id, tag),
    )


def _insert_dep(conn: sqlite3.Connection, source_id: str, target_id: str, created_at: str) -> None:
    conn.execute(
        "INSERT INTO dependencies (source_id, target_id, created_at) VALUES (?, ?, ?)",
        (source_id, target_id, created_at),
    )


def _select_deps(conn: sqlite3.Connection, item_id: str) -> tuple[str, ...]:
    rows = conn.execute(
        "SELECT target_id FROM dependencies WHERE source_id = ? ORDER BY target_id",
        (item_id,),
    ).fetchall()
    return tuple(row["target_id"] for row in rows)


def _select_tags(conn: sqlite3.Connection, item_id: str) -> tuple[str, ...]:
    rows = conn.execute(
        "SELECT tag FROM tags WHERE item_id = ? ORDER BY tag",
        (item_id,),
    ).fetchall()
    return tuple(row["tag"] for row in rows)


# ---------------------------------------------------------------------------
# Index facade
# ---------------------------------------------------------------------------


@dataclass
class Index:
    """High-level handle to the SQLite index for a loom root."""

    root: Path

    @property
    def db_path(self) -> Path:
        return db_path(self.root)

    # ----- schema -------------------------------------------------------

    def ensure_schema(self) -> None:
        """Create any missing tables/indexes. Safe to call repeatedly."""
        with connect(self.db_path) as conn:
            _create_schema(conn)

    # ----- single-record write -----------------------------------------

    def apply_record(self, record: IndexRecord) -> None:
        """Insert or replace one item plus its tags and outgoing deps.

        Only this item's *outgoing* dependency edges and tags are owned
        by its frontmatter and therefore replaced here. Incoming edges
        (where this item is a target) are owned by other items and left
        alone — see :func:`_upsert_item` for why DELETE+INSERT would be
        wrong.

        Dependency targets MUST already exist in the index, otherwise
        SQLite raises ``IntegrityError``. Use :meth:`rebuild` for
        bulk loads where dep ordering can't be guaranteed.
        """
        with connect(self.db_path) as conn:
            _create_schema(conn)
            _upsert_item(conn, record)
            conn.execute("DELETE FROM tags WHERE item_id = ?", (record.qualified_id,))
            conn.execute(
                "DELETE FROM dependencies WHERE source_id = ?",
                (record.qualified_id,),
            )
            for tag in record.tags:
                _insert_tag(conn, record.qualified_id, tag)
            for dep in record.depends_on:
                _insert_dep(conn, record.qualified_id, dep, record.updated_at)

    def delete(self, qualified_id: str) -> None:
        with connect(self.db_path) as conn:
            _delete_item(conn, qualified_id)

    # ----- queries ------------------------------------------------------

    def get(self, qualified_id: str) -> IndexRecord | None:
        with connect(self.db_path) as conn:
            _create_schema(conn)
            row = conn.execute(
                "SELECT * FROM items WHERE qualified_id = ?",
                (qualified_id,),
            ).fetchone()
            if row is None:
                return None
            return _row_to_record(
                row,
                deps=_select_deps(conn, qualified_id),
                tags=_select_tags(conn, qualified_id),
            )

    def has(self, qualified_id: str) -> bool:
        with connect(self.db_path) as conn:
            _create_schema(conn)
            row = conn.execute(
                "SELECT 1 FROM items WHERE qualified_id = ? LIMIT 1",
                (qualified_id,),
            ).fetchone()
            return row is not None

    def find(
        self,
        *,
        type: str | None = None,
        status: str | None = None,
        project: str | None = None,
        assignee: str | None = None,
        archived: bool | None = None,
        tag: str | None = None,
    ) -> list[IndexRecord]:
        """Filter items by exact-match on the indexed columns."""
        clauses: list[str] = []
        params: list[Any] = []
        joins = ""
        if tag is not None:
            joins = " JOIN tags ON tags.item_id = items.qualified_id"
            clauses.append("tags.tag = ?")
            params.append(tag)
        if type is not None:
            clauses.append("items.type = ?")
            params.append(type)
        if status is not None:
            clauses.append("items.status = ?")
            params.append(status)
        if project is not None:
            clauses.append("items.project = ?")
            params.append(project)
        if assignee is not None:
            clauses.append("items.assignee = ?")
            params.append(assignee)
        if archived is not None:
            clauses.append("items.archived = ?")
            params.append(1 if archived else 0)
        where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
        sql = f"SELECT items.* FROM items{joins}{where} ORDER BY items.qualified_id"
        with connect(self.db_path) as conn:
            _create_schema(conn)
            rows = conn.execute(sql, params).fetchall()
            return [
                _row_to_record(
                    row,
                    deps=_select_deps(conn, row["qualified_id"]),
                    tags=_select_tags(conn, row["qualified_id"]),
                )
                for row in rows
            ]

    def all_qualified_ids(self) -> list[str]:
        with connect(self.db_path) as conn:
            _create_schema(conn)
            rows = conn.execute("SELECT qualified_id FROM items ORDER BY qualified_id").fetchall()
            return [row["qualified_id"] for row in rows]

    def all_dependencies(self) -> list[tuple[str, str]]:
        with connect(self.db_path) as conn:
            _create_schema(conn)
            rows = conn.execute(
                "SELECT source_id, target_id FROM dependencies ORDER BY source_id, target_id"
            ).fetchall()
            return [(row["source_id"], row["target_id"]) for row in rows]

    # ----- dependency helpers ------------------------------------------

    def dependencies_of(self, qualified_id: str) -> tuple[str, ...]:
        """Targets that *qualified_id* depends on, sorted by qid."""
        with connect(self.db_path) as conn:
            _create_schema(conn)
            return _select_deps(conn, qualified_id)

    def dependents_of(self, qualified_id: str) -> tuple[str, ...]:
        """Sources that depend on *qualified_id*, sorted by qid."""
        with connect(self.db_path) as conn:
            _create_schema(conn)
            rows = conn.execute(
                "SELECT source_id FROM dependencies WHERE target_id = ? ORDER BY source_id",
                (qualified_id,),
            ).fetchall()
            return tuple(row["source_id"] for row in rows)

    def find_pickable(
        self,
        *,
        type: str | None = None,
        tag: str | None = None,
        limit: int | None = None,
    ) -> list[IndexRecord]:
        """Items with status='ready', not archived, and every dep done.

        Items with no dependencies satisfy the predicate trivially. Only
        the literal status string ``'done'`` satisfies — custom statuses
        do not.
        """
        clauses = ["items.status = 'ready'", "items.archived = 0"]
        params: list[Any] = []
        joins = ""
        if tag is not None:
            joins = " JOIN tags ON tags.item_id = items.qualified_id"
            clauses.append("tags.tag = ?")
            params.append(tag)
        if type is not None:
            clauses.append("items.type = ?")
            params.append(type)
        # Exclude items with at least one not-yet-done dep target.
        clauses.append(
            "NOT EXISTS ("
            "  SELECT 1 FROM dependencies d "
            "  JOIN items t ON t.qualified_id = d.target_id "
            "  WHERE d.source_id = items.qualified_id "
            "    AND (t.status IS NULL OR t.status != 'done')"
            ")"
        )
        where = " WHERE " + " AND ".join(clauses)
        order_limit = " ORDER BY items.qualified_id"
        if limit is not None:
            order_limit += " LIMIT ?"
            params.append(int(limit))
        sql = f"SELECT items.* FROM items{joins}{where}{order_limit}"
        with connect(self.db_path) as conn:
            _create_schema(conn)
            rows = conn.execute(sql, params).fetchall()
            return [
                _row_to_record(
                    row,
                    deps=_select_deps(conn, row["qualified_id"]),
                    tags=_select_tags(conn, row["qualified_id"]),
                )
                for row in rows
            ]

    def statuses(self) -> list[str]:
        """Return every distinct non-null status currently in the index, sorted.

        Includes archived items — this is for discovering what status
        conventions a dataset has accumulated.
        """
        with connect(self.db_path) as conn:
            _create_schema(conn)
            rows = conn.execute(
                "SELECT DISTINCT status FROM items WHERE status IS NOT NULL ORDER BY status"
            ).fetchall()
            return [row["status"] for row in rows]

    # ----- bulk load ----------------------------------------------------

    def replace_all(self, records: Iterable[IndexRecord]) -> list[tuple[str, str]]:
        """Drop every table and repopulate from *records*. Used by rebuild.

        Returns the list of ``(source_id, target_id)`` dependency edges
        that could not be inserted because the target was missing.
        Callers turn these into ``broken_dep`` validation issues.
        """
        records = list(records)
        broken: list[tuple[str, str]] = []
        with connect(self.db_path) as conn:
            _drop_schema(conn)
            _create_schema(conn)
            # Pass 1: items + tags.
            for r in records:
                _insert_item(conn, r)
                for tag in r.tags:
                    _insert_tag(conn, r.qualified_id, tag)
            # Pass 2: dependencies (now that all items exist).
            for r in records:
                for dep in r.depends_on:
                    try:
                        _insert_dep(conn, r.qualified_id, dep, r.updated_at)
                    except sqlite3.IntegrityError:
                        broken.append((r.qualified_id, dep))
        # Re-stamp user_version after dropping tables. SQLite preserves it
        # across schema changes but explicit beats confused-future-you.
        set_version(self.db_path, SCHEMA_VERSION)
        return broken


# ---------------------------------------------------------------------------
# Helpers used by scan / build_record
# ---------------------------------------------------------------------------


def to_plain(obj: Any) -> Any:
    """Recursively convert ruamel.yaml scalars / containers to plain Python.

    JSON-safe and order-preserving (Python dict iteration order matches
    insertion order, which matches ruamel's parsed key order).
    """
    if isinstance(obj, dict):
        return {str(k): to_plain(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [to_plain(v) for v in obj]
    if isinstance(obj, str):
        return str(obj)
    if isinstance(obj, bool):
        return obj
    if isinstance(obj, int):
        return int(obj)
    if isinstance(obj, float):
        return float(obj)
    return obj


def frontmatter_to_json(fm: dict[str, Any]) -> str:
    return json.dumps(to_plain(fm), ensure_ascii=False)
