"""Read-only validation: report inconsistencies between DB and filesystem.

Validate never mutates anything (not the DB, not the markdown). For
fixes, point users at :func:`loom.rebuild.rebuild` or
:func:`loom.rebuild.sync_one`.

Cycle detection is intentionally out of scope here — Phase 4's
``deps`` module owns that.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from .errors import InvalidQualifiedId, ValidationError
from .ids import qid_from_path
from .index import Index
from .scan import hash_file_bytes, walk_md_files
from .storage import load

# Stable kind constants for JSON consumers.
KIND_BROKEN_DEP = "broken_dep"
KIND_DRIFT = "drift"
KIND_PATH_ID_MISMATCH = "path_id_mismatch"
KIND_TYPE_MISMATCH = "type_mismatch"
KIND_PARSE_ERROR = "parse_error"
KIND_STRAY_FILE = "stray_file"
KIND_MISSING_FIELD = "missing_field"
KIND_NOT_INDEXED = "not_indexed"
KIND_ORPHAN_INDEX = "orphan_index"


@dataclass(frozen=True, slots=True)
class ValidationIssue:
    kind: str
    qualified_id: str | None
    file_path: str | None
    message: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def validate(root: Path) -> list[ValidationIssue]:
    """Walk the filesystem and the index, returning every inconsistency."""
    issues: list[ValidationIssue] = []
    idx = Index(root)

    indexed_qids = set(idx.all_qualified_ids())
    indexed_records = {qid: idx.get(qid) for qid in indexed_qids}

    seen_qids: set[str] = set()

    for path in walk_md_files(root):
        rel = str(path.relative_to(root))
        try:
            qid, _archived = qid_from_path(path, root)
        except InvalidQualifiedId as e:
            issues.append(ValidationIssue(KIND_STRAY_FILE, None, rel, str(e)))
            continue

        try:
            fm, _body = load(path)
        except ValidationError as e:
            issues.append(ValidationIssue(KIND_PARSE_ERROR, str(qid), rel, str(e)))
            continue

        seen_qids.add(str(qid))

        # Frontmatter qualified_id / id mismatches with the path.
        if (fm_qid := fm.get("qualified_id")) is not None and str(fm_qid) != str(qid):
            issues.append(
                ValidationIssue(
                    KIND_PATH_ID_MISMATCH,
                    str(qid),
                    rel,
                    f"frontmatter qualified_id {str(fm_qid)!r} != path-derived {str(qid)!r}",
                )
            )
        if (fm_local := fm.get("id")) is not None and str(fm_local) != qid.local_id:
            issues.append(
                ValidationIssue(
                    KIND_PATH_ID_MISMATCH,
                    str(qid),
                    rel,
                    f"frontmatter id {str(fm_local)!r} != path-derived {qid.local_id!r}",
                )
            )

        # Type mismatch.
        if (fm_type := fm.get("type")) is not None and str(fm_type) != qid.type.value:
            issues.append(
                ValidationIssue(
                    KIND_TYPE_MISMATCH,
                    str(qid),
                    rel,
                    f"frontmatter type {str(fm_type)!r} != path-derived {qid.type.value!r}",
                )
            )

        # Missing required fields.
        for field_name in ("title", "created_at", "updated_at"):
            if fm.get(field_name) is None:
                issues.append(
                    ValidationIssue(
                        KIND_MISSING_FIELD,
                        str(qid),
                        rel,
                        f"missing required field {field_name!r}",
                    )
                )
        if qid.type.value != "project" and fm.get("status") is None:
            issues.append(
                ValidationIssue(
                    KIND_MISSING_FIELD,
                    str(qid),
                    rel,
                    "missing required field 'status'",
                )
            )

        # Drift / not-indexed.
        rec = indexed_records.get(str(qid))
        if rec is None:
            issues.append(
                ValidationIssue(
                    KIND_NOT_INDEXED,
                    str(qid),
                    rel,
                    "file exists on disk but is not in the index; run `loom rebuild`",
                )
            )
        else:
            on_disk = hash_file_bytes(path)
            if rec.body_hash != on_disk:
                issues.append(
                    ValidationIssue(
                        KIND_DRIFT,
                        str(qid),
                        rel,
                        "on-disk content differs from indexed body_hash",
                    )
                )

        # Broken deps: read from frontmatter (source of truth) so we still
        # surface dependencies whose targets were missing at index time and
        # therefore never landed in the dependencies table.
        for dep in fm.get("depends_on") or ():
            dep_str = str(dep)
            if dep_str not in indexed_qids:
                issues.append(
                    ValidationIssue(
                        KIND_BROKEN_DEP,
                        str(qid),
                        rel,
                        f"depends on missing item {dep_str}",
                    )
                )

    # Index entries with no corresponding file.
    for qid in sorted(indexed_qids - seen_qids):
        rec = indexed_records[qid]
        issues.append(
            ValidationIssue(
                KIND_ORPHAN_INDEX,
                qid,
                rec.file_path if rec else None,
                "indexed but no matching file on disk; run `loom rebuild`",
            )
        )

    return issues
