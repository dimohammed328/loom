"""Bulk-load (`rebuild`) and per-item resync (`sync_one`).

Both operate by scanning files into :class:`IndexRecord`s and writing
them through :class:`Index`. ``rebuild`` is destructive on the DB
(drop + repopulate) and may rewrite a file's frontmatter when its
``qualified_id`` / ``id`` disagree with the filesystem path — the path
always wins. ``sync_one`` is the single-file equivalent.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .errors import InvalidQualifiedId, NotFound, ValidationError
from .ids import QualifiedId, parse_qid, path_from_qid, qid_from_path
from .index import Index
from .scan import build_record, walk_md_files
from .storage import dump, load
from .validation import (
    KIND_BROKEN_DEP,
    KIND_PARSE_ERROR,
    KIND_STRAY_FILE,
    ValidationIssue,
)


@dataclass(frozen=True, slots=True)
class RebuildResult:
    indexed_count: int
    rewrites: tuple[str, ...] = field(default_factory=tuple)
    issues: tuple[ValidationIssue, ...] = field(default_factory=tuple)


def rebuild(root: Path, *, log: Callable[[str], None] | None = None) -> RebuildResult:
    """Walk *root* and rebuild the index from scratch.

    Returns the count of indexed items, the list of file paths whose
    frontmatter was rewritten, and the list of validation issues
    encountered. Best-effort: parse errors and stray files become
    issues but do not abort the rebuild.
    """
    issues: list[ValidationIssue] = []
    rewrites: list[str] = []
    records = []

    for path in walk_md_files(root):
        rel = str(path.relative_to(root))
        try:
            qid, _archived = qid_from_path(path, root)
        except InvalidQualifiedId as e:
            issues.append(ValidationIssue(KIND_STRAY_FILE, None, rel, str(e)))
            continue

        try:
            fm, body = load(path)
        except ValidationError as e:
            issues.append(ValidationIssue(KIND_PARSE_ERROR, str(qid), rel, str(e)))
            continue

        if _rewrite_id_fields_if_needed(fm, qid):
            dump(path, fm, body)
            rewrites.append(rel)
            if log is not None:
                log(f"rewrote: {rel} (id mismatch)")

        try:
            record = build_record(path, root)
        except (InvalidQualifiedId, ValidationError) as e:
            issues.append(ValidationIssue(KIND_PARSE_ERROR, str(qid), rel, str(e)))
            continue

        records.append(record)

    idx = Index(root)
    broken_deps = idx.replace_all(records)
    record_by_id = {r.qualified_id: r for r in records}
    for source_id, target_id in broken_deps:
        rec = record_by_id.get(source_id)
        rel = rec.file_path if rec else None
        issues.append(
            ValidationIssue(
                KIND_BROKEN_DEP,
                source_id,
                rel,
                f"depends on missing item {target_id}",
            )
        )

    return RebuildResult(
        indexed_count=len(records),
        rewrites=tuple(rewrites),
        issues=tuple(issues),
    )


def sync_one(root: Path, qualified_id: str) -> None:
    """Re-read the file backing *qualified_id* and apply it to the index.

    If the file no longer exists in either ``projects/`` or
    ``_archive/projects/``, the index entry is dropped. Raises
    :class:`InvalidQualifiedId` if the qid is malformed.
    """
    qid = parse_qid(qualified_id)
    live = path_from_qid(qid, root, archived=False)
    archived = path_from_qid(qid, root, archived=True)

    path: Path | None = None
    if live.exists():
        path = live
    elif archived.exists():
        path = archived

    idx = Index(root)
    if path is None:
        if not idx.has(str(qid)):
            raise NotFound(str(qid))
        idx.delete(str(qid))
        return

    record = build_record(path, root)
    idx.apply_record(record)


def _rewrite_id_fields_if_needed(fm: dict[str, Any], qid: QualifiedId) -> bool:
    """Return True if ``fm`` was mutated to align id/qualified_id with the path."""
    expected_qid = str(qid)
    expected_local = qid.local_id
    changed = False
    if str(fm.get("qualified_id", "")) != expected_qid:
        fm["qualified_id"] = expected_qid
        changed = True
    if str(fm.get("id", "")) != expected_local:
        fm["id"] = expected_local
        changed = True
    return changed
