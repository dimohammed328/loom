"""Filesystem scan: walk markdown files and turn them into IndexRecords.

Used by :mod:`loom.rebuild`, :mod:`loom.validation`, and Phase 3's
single-item sync.
"""

from __future__ import annotations

import hashlib
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .ids import (
    ARCHIVE_DIRNAME,
    PROJECTS_DIRNAME,
    ItemType,
    qid_from_path,
)
from .index import IndexRecord, frontmatter_to_json
from .storage import load


def walk_md_files(root: Path) -> Iterator[Path]:
    """Yield every ``.md`` file under ``projects/`` and ``_archive/projects/``.

    Anything outside those subtrees (e.g. files in ``.loom/``, top-level
    READMEs) is ignored. Within those subtrees a non-canonical file
    layout will be reported as a stray-file issue by callers, not by
    this walker.
    """
    candidates = (
        root / PROJECTS_DIRNAME,
        root / ARCHIVE_DIRNAME / PROJECTS_DIRNAME,
    )
    for base in candidates:
        if base.exists():
            yield from sorted(base.rglob("*.md"))


def hash_file_bytes(path: Path) -> str:
    """sha256 of the raw on-disk bytes.

    Hashing the raw bytes — never the parsed-and-rerendered form — keeps
    drift detection honest: ruamel may normalize quoting or spacing on
    rewrite, which would be spurious drift if we hashed parsed content.
    """
    return hashlib.sha256(path.read_bytes()).hexdigest()


def build_record(path: Path, root: Path) -> IndexRecord:
    """Construct an :class:`IndexRecord` from a markdown file.

    Raises :class:`InvalidQualifiedId` if the path doesn't match the
    canonical layout, or :class:`ValidationError` if the file is
    unreadable or its frontmatter parses to something unusable.

    Missing optional fields fall back to sensible defaults; missing
    timestamps fall back to the file's mtime; a missing ``status`` on a
    non-project item defaults to ``"ready"`` (the canonical initial
    state). The path's qid always wins over any disagreeing
    ``qualified_id`` / ``id`` in the frontmatter — those mismatches are
    surfaced as validation issues by the caller, not corrected here.
    """
    qid, archived = qid_from_path(path, root)
    fm, _body = load(path)

    rel_path = str(path.relative_to(root))
    body_hash = hash_file_bytes(path)

    mtime_iso = _path_mtime_iso(path)
    created_at = _opt_str(fm.get("created_at")) or mtime_iso
    updated_at = _opt_str(fm.get("updated_at")) or mtime_iso

    title = _opt_str(fm.get("title")) or f"(untitled) {qid}"

    status: str | None = None
    if qid.type != ItemType.PROJECT:
        status = _opt_str(fm.get("status")) or "ready"

    parent = qid.parent
    parent_id = str(parent) if parent else None

    is_project = qid.type == ItemType.PROJECT
    repo = _opt_str(fm.get("repo")) if is_project else None
    default_branch = _opt_str(fm.get("default_branch")) if is_project else None

    depends_on = tuple(str(x) for x in (fm.get("depends_on") or ()))
    tags = tuple(str(x) for x in (fm.get("tags") or ()))

    return IndexRecord(
        qualified_id=str(qid),
        type=qid.type.value,
        project=qid.project,
        epic=qid.epic,
        story=qid.story,
        task=qid.task,
        parent_id=parent_id,
        title=title,
        status=status,
        assignee=_opt_str(fm.get("assignee")),
        branch=_opt_str(fm.get("branch")),
        pr_url=_opt_str(fm.get("pr_url")),
        repo=repo,
        default_branch=default_branch,
        archived=archived,
        created_at=created_at,
        updated_at=updated_at,
        file_path=rel_path,
        body_hash=body_hash,
        frontmatter_json=frontmatter_to_json(fm),
        depends_on=depends_on,
        tags=tags,
    )


def _opt_str(v: Any) -> str | None:
    if v is None:
        return None
    s = str(v)
    return s if s else None


def _path_mtime_iso(path: Path) -> str:
    return datetime.fromtimestamp(path.stat().st_mtime, UTC).isoformat(timespec="seconds")
