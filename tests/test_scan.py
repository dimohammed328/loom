from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from conftest import write_item
from loom.errors import InvalidQualifiedId, ValidationError
from loom.ids import QualifiedId
from loom.scan import build_record, hash_file_bytes, walk_md_files


def test_walk_finds_md_under_projects_and_archive(loom_dir: Path) -> None:
    write_item(loom_dir, QualifiedId("foo"))
    write_item(loom_dir, QualifiedId("bar"), archived=True)
    # A stray, non-canonical file: still visible to the walker, callers handle it.
    (loom_dir / "projects" / "stray.md").write_text("garbage\n")

    paths = sorted(p.relative_to(loom_dir) for p in walk_md_files(loom_dir))
    assert paths == sorted(
        [
            Path("_archive/projects/bar/project.md"),
            Path("projects/foo/project.md"),
            Path("projects/stray.md"),
        ]
    )


def test_walk_ignores_top_level_and_dotfiles(loom_dir: Path) -> None:
    (loom_dir / "README.md").write_text("# top-level\n")
    (loom_dir / ".loom").mkdir(exist_ok=True)
    (loom_dir / ".loom" / "stuff.md").write_text("internal\n")
    paths = list(walk_md_files(loom_dir))
    assert paths == []


def test_hash_file_bytes_changes_with_content(tmp_path: Path) -> None:
    p = tmp_path / "a.md"
    p.write_text("one\n")
    h1 = hash_file_bytes(p)
    p.write_text("two\n")
    h2 = hash_file_bytes(p)
    assert h1 != h2
    assert len(h1) == 64  # sha256 hex


def test_build_record_project(loom_dir: Path) -> None:
    write_item(
        loom_dir,
        QualifiedId("foo"),
        repo="https://github.com/acme/foo",
        default_branch="main",
        body="## about\n",
    )
    rec = build_record(loom_dir / "projects" / "foo" / "project.md", loom_dir)
    assert rec.qualified_id == "foo"
    assert rec.type == "project"
    assert rec.status is None
    assert rec.repo == "https://github.com/acme/foo"
    assert rec.default_branch == "main"
    assert rec.parent_id is None
    assert rec.archived is False


def test_build_record_task_with_deps_and_tags(loom_dir: Path) -> None:
    write_item(loom_dir, QualifiedId("foo"))
    write_item(loom_dir, QualifiedId("foo", "abcdefg"))
    write_item(loom_dir, QualifiedId("foo", "abcdefg", 1))
    write_item(
        loom_dir,
        QualifiedId("foo", "abcdefg", 1, 1),
        depends_on=["foo:abcdefg"],
        tags=["urgent", "auth"],
    )
    rec = build_record(
        loom_dir / "projects/foo/epics/abcdefg/stories/1/tasks/1.md",
        loom_dir,
    )
    assert rec.qualified_id == "foo:abcdefg:1:1"
    assert rec.parent_id == "foo:abcdefg:1"
    assert rec.type == "task"
    assert rec.status == "ready"
    assert rec.depends_on == ("foo:abcdefg",)
    assert rec.tags == ("urgent", "auth")


def test_build_record_archived(loom_dir: Path) -> None:
    write_item(loom_dir, QualifiedId("foo"), archived=True)
    rec = build_record(loom_dir / "_archive/projects/foo/project.md", loom_dir)
    assert rec.archived is True
    assert rec.qualified_id == "foo"


def test_build_record_falls_back_to_mtime_for_missing_timestamps(loom_dir: Path) -> None:
    path = write_item(loom_dir, QualifiedId("foo"), created_at=None, updated_at=None)
    # Re-write WITHOUT timestamps in frontmatter
    from loom.storage import dump

    dump(
        path,
        {
            "schema_version": 1,
            "id": "foo",
            "qualified_id": "foo",
            "type": "project",
            "title": "Foo",
        },
        "",
    )
    # Force a known mtime.
    target_ts = 1700000000  # 2023-11-14T22:13:20+00:00
    os.utime(path, (target_ts, target_ts))
    rec = build_record(path, loom_dir)
    assert rec.created_at.startswith("2023-11-14")
    assert rec.updated_at.startswith("2023-11-14")


def test_build_record_default_status_for_non_project(loom_dir: Path) -> None:
    write_item(loom_dir, QualifiedId("foo"), status=None)  # omit status
    # Story without status in frontmatter
    write_item(loom_dir, QualifiedId("foo", "abcdefg"))
    epic_path = loom_dir / "projects/foo/epics/abcdefg/epic.md"
    from loom.storage import dump, load

    fm, body = load(epic_path)
    fm.pop("status", None)
    dump(epic_path, fm, body)

    rec = build_record(epic_path, loom_dir)
    assert rec.status == "ready"


def test_build_record_raises_on_invalid_path(loom_dir: Path) -> None:
    bogus = loom_dir / "projects" / "foo" / "garbage" / "thing.md"
    bogus.parent.mkdir(parents=True)
    bogus.write_text("---\ntitle: x\n---\n")
    with pytest.raises(InvalidQualifiedId):
        build_record(bogus, loom_dir)


def test_build_record_raises_on_garbled_yaml(loom_dir: Path) -> None:
    path = write_item(loom_dir, QualifiedId("foo"))
    path.write_text("---\nkey: : :\n---\nbody\n")
    with pytest.raises(ValidationError):
        build_record(path, loom_dir)


def test_build_record_serializes_frontmatter_json(loom_dir: Path) -> None:
    write_item(
        loom_dir,
        QualifiedId("foo"),
        custom={"score": 7, "extra": ["a", "b"]},
    )
    rec = build_record(loom_dir / "projects/foo/project.md", loom_dir)
    parsed = json.loads(rec.frontmatter_json)
    assert parsed["custom"] == {"score": 7, "extra": ["a", "b"]}
    # title preserved
    assert parsed["title"] == "Item foo"
