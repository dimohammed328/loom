from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from loom.index import (
    SCHEMA_VERSION,
    Index,
    IndexRecord,
    current_version,
    db_path,
    frontmatter_to_json,
    init_db,
    to_plain,
)


def make_record(
    qid: str = "foo",
    type_: str = "project",
    **overrides,
) -> IndexRecord:
    base = dict(
        qualified_id=qid,
        type=type_,
        project=qid.split(":")[0],
        epic=None,
        story=None,
        task=None,
        parent_id=None,
        title="Test",
        status=None if type_ == "project" else "ready",
        assignee=None,
        branch=None,
        pr_url=None,
        repo=None,
        default_branch=None,
        archived=False,
        created_at="2026-01-01T00:00:00+00:00",
        updated_at="2026-01-01T00:00:00+00:00",
        file_path=f"projects/{qid}/project.md",
        body_hash="0" * 64,
        frontmatter_json="{}",
        depends_on=(),
        tags=(),
    )
    base.update(overrides)
    return IndexRecord(**base)


def test_init_db_sets_schema_and_version(tmp_path: Path) -> None:
    p = db_path(tmp_path)
    init_db(p)
    assert current_version(p) == SCHEMA_VERSION
    # All three tables should exist.
    with sqlite3.connect(p) as conn:
        rows = conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
        names = {row[0] for row in rows}
    assert {"items", "dependencies", "tags"} <= names


def test_apply_record_round_trip(loom_dir: Path) -> None:
    idx = Index(loom_dir)
    rec = make_record()
    idx.apply_record(rec)
    out = idx.get("foo")
    assert out is not None
    assert out.qualified_id == "foo"
    assert out.type == "project"
    assert out.archived is False


def test_apply_record_overwrites(loom_dir: Path) -> None:
    idx = Index(loom_dir)
    idx.apply_record(make_record(title="first"))
    idx.apply_record(make_record(title="second"))
    out = idx.get("foo")
    assert out is not None and out.title == "second"


def test_get_returns_none_for_missing(loom_dir: Path) -> None:
    assert Index(loom_dir).get("missing") is None


def test_apply_record_with_tags_and_deps(loom_dir: Path) -> None:
    idx = Index(loom_dir)
    idx.apply_record(make_record(qid="foo"))  # dep target must exist
    idx.apply_record(
        make_record(
            qid="foo:abcdefg",
            type_="epic",
            depends_on=("foo",),
            tags=("auth", "security"),
        )
    )
    out = idx.get("foo:abcdefg")
    assert out is not None
    assert out.depends_on == ("foo",)
    assert set(out.tags) == {"auth", "security"}


def test_apply_record_rejects_dep_to_missing_item(loom_dir: Path) -> None:
    idx = Index(loom_dir)
    with pytest.raises(sqlite3.IntegrityError):
        idx.apply_record(make_record(qid="foo", depends_on=("nonexistent",)))


def test_apply_record_rolls_back_on_failed_dep(loom_dir: Path) -> None:
    """A broken-dep failure must leave the index in its prior state.

    Locks down the connect()-context-manager rollback contract: if the
    dep insert fails, the prior upsert + tag/dep wipes don't stick.
    """
    idx = Index(loom_dir)
    idx.apply_record(make_record(qid="foo", title="original"))
    with pytest.raises(sqlite3.IntegrityError):
        idx.apply_record(make_record(qid="foo", title="replacement", depends_on=("nonexistent",)))
    out = idx.get("foo")
    assert out is not None
    assert out.title == "original"


def test_apply_record_preserves_incoming_edges(loom_dir: Path) -> None:
    """Re-applying an item must NOT wipe edges where it is the target.

    Regression: an earlier apply_record did DELETE + INSERT on items,
    which CASCADEd to dependencies via the FK and silently dropped
    incoming edges. Now apply_record UPSERTs the item row instead.
    """
    idx = Index(loom_dir)
    idx.apply_record(make_record(qid="foo"))
    idx.apply_record(make_record(qid="bar", depends_on=("foo",)))
    assert idx.dependencies_of("bar") == ("foo",)
    # Re-apply foo (e.g., a status change). bar's edge to foo must persist.
    idx.apply_record(make_record(qid="foo", title="updated"))
    assert idx.dependencies_of("bar") == ("foo",)


def test_replace_all_two_pass_handles_dep_ordering(loom_dir: Path) -> None:
    idx = Index(loom_dir)
    # Records intentionally out of order: epic depends on project, but listed first.
    epic = make_record(qid="foo:abcdefg", type_="epic", depends_on=("foo",), tags=("a",))
    project = make_record(qid="foo")
    broken = idx.replace_all([epic, project])
    assert broken == []
    assert idx.get("foo") is not None
    assert idx.get("foo:abcdefg").depends_on == ("foo",)


def test_replace_all_reports_broken_deps(loom_dir: Path) -> None:
    idx = Index(loom_dir)
    rec = make_record(qid="foo", depends_on=("not_there",))
    broken = idx.replace_all([rec])
    assert broken == [("foo", "not_there")]
    # The source item is still indexed.
    assert idx.get("foo") is not None


def test_replace_all_drops_previous_data(loom_dir: Path) -> None:
    idx = Index(loom_dir)
    idx.apply_record(make_record(qid="foo"))
    assert idx.get("foo") is not None
    idx.replace_all([])
    assert idx.get("foo") is None


def test_replace_all_preserves_user_version(loom_dir: Path) -> None:
    idx = Index(loom_dir)
    idx.replace_all([make_record(qid="foo")])
    assert current_version(idx.db_path) == SCHEMA_VERSION


def test_find_filters(loom_dir: Path) -> None:
    idx = Index(loom_dir)
    idx.apply_record(make_record(qid="foo"))
    idx.apply_record(make_record(qid="foo:abcdefg", type_="epic", status="ready", tags=("a",)))
    idx.apply_record(
        make_record(
            qid="foo:abcdefg:1",
            type_="story",
            story=1,
            epic="abcdefg",
            parent_id="foo:abcdefg",
            status="done",
            tags=("a", "b"),
        )
    )

    assert {r.qualified_id for r in idx.find(type="epic")} == {"foo:abcdefg"}
    assert {r.qualified_id for r in idx.find(status="ready")} == {"foo:abcdefg"}
    assert {r.qualified_id for r in idx.find(status="done")} == {"foo:abcdefg:1"}
    assert {r.qualified_id for r in idx.find(tag="b")} == {"foo:abcdefg:1"}
    assert {r.qualified_id for r in idx.find(tag="a")} == {
        "foo:abcdefg",
        "foo:abcdefg:1",
    }


def test_find_archived_filter(loom_dir: Path) -> None:
    idx = Index(loom_dir)
    idx.apply_record(make_record(qid="foo"))
    idx.apply_record(make_record(qid="bar", archived=True))
    assert {r.qualified_id for r in idx.find(archived=False)} == {"foo"}
    assert {r.qualified_id for r in idx.find(archived=True)} == {"bar"}


def test_statuses_distinct_sorted_includes_archived(loom_dir: Path) -> None:
    idx = Index(loom_dir)
    idx.apply_record(make_record(qid="foo"))
    idx.apply_record(make_record(qid="foo:abcdefg", type_="epic", status="ready"))
    idx.apply_record(
        make_record(
            qid="foo:hjkmnpq",
            type_="epic",
            status="in_progress",
            archived=True,
        )
    )
    idx.apply_record(
        make_record(qid="foo:rstvwxy", type_="epic", status="ready")  # duplicate of "ready"
    )
    assert idx.statuses() == ["in_progress", "ready"]


def test_delete_cascades_to_deps_and_tags(loom_dir: Path) -> None:
    idx = Index(loom_dir)
    idx.apply_record(make_record(qid="foo", tags=("a",)))
    idx.apply_record(make_record(qid="foo:abcdefg", type_="epic", depends_on=("foo",), tags=("b",)))
    idx.delete("foo:abcdefg")
    # After delete, both items removed (well, just the epic) — and dep + tag rows gone.
    assert idx.get("foo:abcdefg") is None
    # Remaining "foo" should still have its tag.
    assert idx.get("foo").tags == ("a",)


def test_to_plain_handles_ruamel_types() -> None:
    # CommentedMap is the type ruamel.yaml round-trip mode produces.
    from ruamel.yaml.comments import CommentedMap, CommentedSeq

    cm = CommentedMap()
    cm["k"] = "v"
    cm["nested"] = CommentedMap()
    cm["nested"]["a"] = 1
    cm["list"] = CommentedSeq(["x", "y"])

    plain = to_plain(cm)
    assert plain == {"k": "v", "nested": {"a": 1}, "list": ["x", "y"]}


def test_frontmatter_to_json_preserves_order() -> None:
    fm = {"z": 1, "a": 2, "m": 3}
    out = frontmatter_to_json(fm)
    # JSON preserves dict insertion order in Python 3.7+
    assert out.index('"z"') < out.index('"a"') < out.index('"m"')
