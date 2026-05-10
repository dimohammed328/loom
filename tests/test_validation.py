from __future__ import annotations

from pathlib import Path

from conftest import write_item
from loom.ids import QualifiedId
from loom.rebuild import rebuild
from loom.storage import dump, load
from loom.validation import (
    KIND_BROKEN_DEP,
    KIND_DRIFT,
    KIND_MISSING_FIELD,
    KIND_NOT_INDEXED,
    KIND_ORPHAN_INDEX,
    KIND_PARSE_ERROR,
    KIND_PATH_ID_MISMATCH,
    KIND_STRAY_FILE,
    KIND_TYPE_MISMATCH,
    validate,
)


def test_validate_clean_state(loom_dir: Path) -> None:
    write_item(loom_dir, QualifiedId("foo"))
    write_item(loom_dir, QualifiedId("foo", "abcdefg"))
    rebuild(loom_dir)
    assert validate(loom_dir) == []


def test_validate_detects_drift_after_disk_edit(loom_dir: Path) -> None:
    path = write_item(loom_dir, QualifiedId("foo"))
    rebuild(loom_dir)
    fm, body = load(path)
    fm["title"] = "edited externally"
    dump(path, fm, body)
    issues = validate(loom_dir)
    assert any(i.kind == KIND_DRIFT and i.qualified_id == "foo" for i in issues)


def test_validate_detects_path_id_mismatch(loom_dir: Path) -> None:
    path = write_item(loom_dir, QualifiedId("foo"))
    rebuild(loom_dir)
    # Mutate frontmatter id; do NOT rebuild (we want to see the mismatch).
    fm, body = load(path)
    fm["qualified_id"] = "wrong"
    fm["id"] = "wrong"
    dump(path, fm, body)
    issues = validate(loom_dir)
    kinds = {i.kind for i in issues if i.qualified_id == "foo"}
    # Both fire: the frontmatter disagrees with the path AND the on-disk bytes
    # changed since the last index, so the body_hash no longer matches.
    assert KIND_PATH_ID_MISMATCH in kinds
    assert KIND_DRIFT in kinds


def test_validate_detects_type_mismatch(loom_dir: Path) -> None:
    path = write_item(loom_dir, QualifiedId("foo"))
    fm, body = load(path)
    fm["type"] = "epic"
    dump(path, fm, body)
    rebuild(loom_dir)
    issues = validate(loom_dir)
    assert any(i.kind == KIND_TYPE_MISMATCH for i in issues)


def test_validate_detects_missing_required_fields(loom_dir: Path) -> None:
    write_item(loom_dir, QualifiedId("foo"))
    write_item(loom_dir, QualifiedId("foo", "abcdefg"))
    epic_path = loom_dir / "projects/foo/epics/abcdefg/epic.md"
    fm, body = load(epic_path)
    del fm["title"]
    del fm["status"]
    dump(epic_path, fm, body)
    rebuild(loom_dir)
    issues = validate(loom_dir)
    msgs = [i.message for i in issues if i.kind == KIND_MISSING_FIELD]
    assert any("'title'" in m for m in msgs)
    assert any("'status'" in m for m in msgs)


def test_validate_detects_stray_file(loom_dir: Path) -> None:
    bogus = loom_dir / "projects" / "stray.md"
    bogus.write_text("---\ntitle: x\n---\nbody\n")
    issues = validate(loom_dir)
    assert any(i.kind == KIND_STRAY_FILE for i in issues)


def test_validate_detects_parse_error(loom_dir: Path) -> None:
    path = write_item(loom_dir, QualifiedId("foo"))
    path.write_text("---\nkey: : :\n---\nbody\n")
    issues = validate(loom_dir)
    assert any(i.kind == KIND_PARSE_ERROR for i in issues)


def test_validate_detects_broken_dep(loom_dir: Path) -> None:
    write_item(loom_dir, QualifiedId("foo"), depends_on=["nope:absentab"])
    rebuild(loom_dir)
    issues = validate(loom_dir)
    assert any(i.kind == KIND_BROKEN_DEP for i in issues)


def test_validate_detects_not_indexed_after_new_file(loom_dir: Path) -> None:
    write_item(loom_dir, QualifiedId("foo"))
    rebuild(loom_dir)
    # Add a new file without rebuilding.
    write_item(loom_dir, QualifiedId("bar"))
    issues = validate(loom_dir)
    assert any(i.kind == KIND_NOT_INDEXED and i.qualified_id == "bar" for i in issues)


def test_validate_detects_orphan_index_after_file_removed(loom_dir: Path) -> None:
    path = write_item(loom_dir, QualifiedId("foo"))
    rebuild(loom_dir)
    path.unlink()
    issues = validate(loom_dir)
    assert any(i.kind == KIND_ORPHAN_INDEX and i.qualified_id == "foo" for i in issues)


def test_validation_issue_to_dict() -> None:
    from loom.validation import ValidationIssue

    issue = ValidationIssue("drift", "foo", "projects/foo/project.md", "msg")
    assert issue.to_dict() == {
        "kind": "drift",
        "qualified_id": "foo",
        "file_path": "projects/foo/project.md",
        "message": "msg",
    }
