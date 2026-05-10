from __future__ import annotations

from pathlib import Path

import pytest

from conftest import write_item
from loom.errors import NotFound
from loom.ids import QualifiedId
from loom.index import Index
from loom.rebuild import rebuild, sync_one
from loom.storage import dump, load
from loom.validation import (
    KIND_BROKEN_DEP,
    KIND_PARSE_ERROR,
    KIND_STRAY_FILE,
)


def test_rebuild_empty_dir(loom_dir: Path) -> None:
    result = rebuild(loom_dir)
    assert result.indexed_count == 0
    assert result.issues == ()
    assert result.rewrites == ()


def test_rebuild_simple_chain(loom_dir: Path) -> None:
    write_item(loom_dir, QualifiedId("foo"))
    write_item(loom_dir, QualifiedId("foo", "abcdefg"))
    write_item(loom_dir, QualifiedId("foo", "abcdefg", 1))
    write_item(loom_dir, QualifiedId("foo", "abcdefg", 1, 1))

    result = rebuild(loom_dir)
    assert result.indexed_count == 4
    assert result.issues == ()

    idx = Index(loom_dir)
    assert {r.qualified_id for r in idx.find()} == {
        "foo",
        "foo:abcdefg",
        "foo:abcdefg:1",
        "foo:abcdefg:1:1",
    }


def test_rebuild_is_idempotent(loom_dir: Path) -> None:
    write_item(loom_dir, QualifiedId("foo"))
    write_item(loom_dir, QualifiedId("foo", "abcdefg"))
    first = rebuild(loom_dir)
    second = rebuild(loom_dir)
    assert first.indexed_count == second.indexed_count == 2
    assert first.issues == second.issues == ()


def test_rebuild_archived_items_round_trip(loom_dir: Path) -> None:
    write_item(loom_dir, QualifiedId("foo"))
    write_item(loom_dir, QualifiedId("bar"), archived=True)
    rebuild(loom_dir)
    idx = Index(loom_dir)
    foo = idx.get("foo")
    bar = idx.get("bar")
    assert foo is not None and foo.archived is False
    assert bar is not None and bar.archived is True


def test_rebuild_stray_file_becomes_issue(loom_dir: Path) -> None:
    # A .md file inside projects/ that doesn't match the canonical layout.
    bogus = loom_dir / "projects" / "stray.md"
    bogus.write_text("---\ntitle: x\n---\nbody\n")
    result = rebuild(loom_dir)
    assert result.indexed_count == 0
    kinds = [i.kind for i in result.issues]
    assert KIND_STRAY_FILE in kinds


def test_rebuild_garbled_yaml_becomes_issue(loom_dir: Path) -> None:
    path = write_item(loom_dir, QualifiedId("foo"))
    path.write_text("---\nkey: : :\n---\nbody\n")
    result = rebuild(loom_dir)
    assert result.indexed_count == 0
    assert any(i.kind == KIND_PARSE_ERROR for i in result.issues)


def test_rebuild_broken_dep_becomes_issue_but_source_indexed(loom_dir: Path) -> None:
    write_item(loom_dir, QualifiedId("foo"), depends_on=["nope:absentab"])
    result = rebuild(loom_dir)
    assert result.indexed_count == 1
    assert any(i.kind == KIND_BROKEN_DEP and i.qualified_id == "foo" for i in result.issues)
    assert Index(loom_dir).get("foo") is not None


def test_rebuild_rewrites_path_id_mismatch(loom_dir: Path) -> None:
    # Write file at correct path but with mismatched frontmatter id.
    path = write_item(loom_dir, QualifiedId("foo"))
    fm, body = load(path)
    fm["id"] = "wrong"
    fm["qualified_id"] = "wrong"
    dump(path, fm, body)

    rewritten: list[str] = []
    result = rebuild(loom_dir, log=rewritten.append)
    assert result.indexed_count == 1
    assert "projects/foo/project.md" in result.rewrites
    assert any("rewrote" in line for line in rewritten)
    # Reload to confirm fix landed on disk.
    fm2, _ = load(path)
    assert fm2["id"] == "foo"
    assert fm2["qualified_id"] == "foo"


def test_sync_one_reflects_disk_edits(loom_dir: Path) -> None:
    path = write_item(loom_dir, QualifiedId("foo"), title="initial")
    rebuild(loom_dir)
    assert Index(loom_dir).get("foo").title == "initial"

    fm, body = load(path)
    fm["title"] = "edited"
    dump(path, fm, body)
    sync_one(loom_dir, "foo")
    rec = Index(loom_dir).get("foo")
    assert rec.title == "edited"


def test_sync_one_drops_index_entry_when_file_deleted(loom_dir: Path) -> None:
    path = write_item(loom_dir, QualifiedId("foo"))
    rebuild(loom_dir)
    path.unlink()
    sync_one(loom_dir, "foo")
    assert Index(loom_dir).get("foo") is None


def test_sync_one_raises_for_unknown_id(loom_dir: Path) -> None:
    with pytest.raises(NotFound):
        sync_one(loom_dir, "no_such_project")


def test_sync_one_finds_archived_file(loom_dir: Path) -> None:
    write_item(loom_dir, QualifiedId("foo"), archived=True)
    sync_one(loom_dir, "foo")
    rec = Index(loom_dir).get("foo")
    assert rec is not None and rec.archived is True
