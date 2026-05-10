"""Tests for the Phase 3 item layer: create chains, mutators, archive."""

from __future__ import annotations

from pathlib import Path

import pytest

from loom import (
    Duplicate,
    Epic,
    Loom,
    LoomError,
    NotFound,
    Project,
    Story,
    Task,
)
from loom.ids import EPIC_ALPHABET, EPIC_ID_LEN
from loom.index import Index
from loom.storage import load

# ---------------------------------------------------------------------------
# create chains
# ---------------------------------------------------------------------------


def test_create_full_chain(loom_dir: Path) -> None:
    loom = Loom(root=loom_dir)
    p = loom.create_project("acme", title="Acme")
    assert isinstance(p, Project)
    assert p.qualified_id == "acme"
    assert p.title == "Acme"
    assert p.repo is None
    assert p.default_branch is None

    e = p.create_epic(title="Auth")
    assert isinstance(e, Epic)
    assert e.qualified_id.startswith("acme:")
    assert len(e.qualified_id.split(":")[1]) == EPIC_ID_LEN
    assert e.status == "ready"

    s = e.create_story(title="Backend")
    assert isinstance(s, Story)
    assert s.qualified_id == f"{e.qualified_id}:1"
    assert s.parent_id == e.qualified_id

    t = s.create_task(title="Wire google")
    assert isinstance(t, Task)
    assert t.qualified_id == f"{s.qualified_id}:1"
    assert t.parent_id == s.qualified_id


def test_create_project_with_repo_metadata(loom_dir: Path) -> None:
    loom = Loom(root=loom_dir)
    p = loom.create_project(
        "acme",
        title="Acme",
        repo="https://github.com/acme/repo",
        default_branch="main",
    )
    assert p.repo == "https://github.com/acme/repo"
    assert p.default_branch == "main"

    # Round-trip through the index.
    p2 = loom.get("acme")
    assert isinstance(p2, Project)
    assert p2.repo == "https://github.com/acme/repo"
    assert p2.default_branch == "main"


def test_create_project_duplicate_raises(loom_dir: Path) -> None:
    loom = Loom(root=loom_dir)
    loom.create_project("acme", title="A")
    with pytest.raises(Duplicate):
        loom.create_project("acme", title="A")


def test_create_project_invalid_name_raises(loom_dir: Path) -> None:
    loom = Loom(root=loom_dir)
    with pytest.raises(LoomError):
        loom.create_project("Bad-Name", title="x")


def test_create_with_body(loom_dir: Path) -> None:
    loom = Loom(root=loom_dir)
    p = loom.create_project("acme", title="A", body="## hello\n\nworld\n")
    e = p.create_epic(title="E", body="epic body")
    assert "hello" in p.body
    assert "world" in p.body
    assert e.body == "epic body\n"  # render normalizes trailing newline


# ---------------------------------------------------------------------------
# Sequential allocation
# ---------------------------------------------------------------------------


def test_sequential_story_and_task_allocation(loom_dir: Path) -> None:
    loom = Loom(root=loom_dir)
    p = loom.create_project("acme", title="A")
    e = p.create_epic(title="E")
    s1 = e.create_story(title="s1")
    s2 = e.create_story(title="s2")
    s3 = e.create_story(title="s3")
    assert [s.qualified_id for s in (s1, s2, s3)] == [
        f"{e.qualified_id}:1",
        f"{e.qualified_id}:2",
        f"{e.qualified_id}:3",
    ]

    t1 = s2.create_task(title="t1")
    t2 = s2.create_task(title="t2")
    assert [t.qualified_id for t in (t1, t2)] == [
        f"{s2.qualified_id}:1",
        f"{s2.qualified_id}:2",
    ]

    # Different stories under the same epic each start counting at 1.
    other_t1 = s1.create_task(title="x")
    assert other_t1.qualified_id == f"{s1.qualified_id}:1"


def test_sequential_allocation_skips_archived_siblings(loom_dir: Path) -> None:
    """Archived stories/tasks must NOT have their ids reused."""
    loom = Loom(root=loom_dir)
    p = loom.create_project("acme", title="A")
    e = p.create_epic(title="E")
    e.create_story(title="s1")
    s2 = e.create_story(title="s2")
    s3 = e.create_story(title="s3")
    # Archive s2 (now lives under _archive/).
    s2.archive()
    # Refresh epic to allocate the next story.
    fresh_epic = loom.get(e.qualified_id)
    assert isinstance(fresh_epic, Epic)
    s4 = fresh_epic.create_story(title="s4")
    assert s4.qualified_id == f"{e.qualified_id}:4"
    # Make sure s3 still exists at id 3.
    assert s3.qualified_id == f"{e.qualified_id}:3"


# ---------------------------------------------------------------------------
# Mutators
# ---------------------------------------------------------------------------


def test_set_title_persists_and_updates_self(loom_dir: Path) -> None:
    loom = Loom(root=loom_dir)
    p = loom.create_project("acme", title="Old")
    p.set_title("New")
    # Same instance reflects the new title (advisor flag).
    assert p.title == "New"
    # Round-trip through fresh fetch.
    assert loom.get("acme").title == "New"


def test_set_status_canonical_and_custom(loom_dir: Path) -> None:
    loom = Loom(root=loom_dir)
    p = loom.create_project("acme", title="A")
    e = p.create_epic(title="E")

    e.complete()
    assert e.status == "done"

    e.block()
    assert e.status == "blocked"

    e.mark_ready()
    assert e.status == "ready"

    e.set_status("in_review")  # custom
    assert e.status == "in_review"

    # Statuses query reflects every label seen.
    assert "in_review" in loom.statuses()


def test_set_status_empty_raises(loom_dir: Path) -> None:
    loom = Loom(root=loom_dir)
    e = loom.create_project("acme", title="A").create_epic(title="E")
    with pytest.raises(ValueError):
        e.set_status("")


def test_branch_pr_url_assignee_round_trip(loom_dir: Path) -> None:
    loom = Loom(root=loom_dir)
    s = loom.create_project("acme", title="A").create_epic(title="E").create_story(title="S")
    s.set_assignee("alice")
    s.set_branch("feat/x")
    s.set_pr_url("https://github.com/acme/repo/pull/1")

    # Reload from index to confirm persistence.
    s2 = loom.get(s.qualified_id)
    assert isinstance(s2, Story)
    assert s2.assignee == "alice"
    assert s2.branch == "feat/x"
    assert s2.pr_url == "https://github.com/acme/repo/pull/1"

    # Clearing optional fields with None.
    s.set_assignee(None)
    s.set_branch(None)
    s.set_pr_url(None)
    s3 = loom.get(s.qualified_id)
    assert s3.assignee is None
    assert s3.branch is None
    assert s3.pr_url is None


def test_repo_default_branch_round_trip_and_clearing(loom_dir: Path) -> None:
    loom = Loom(root=loom_dir)
    p = loom.create_project("acme", title="A", repo="r", default_branch="main")
    p.set_repo("https://new")
    p.set_default_branch("trunk")

    p2 = loom.get("acme")
    assert isinstance(p2, Project)
    assert p2.repo == "https://new"
    assert p2.default_branch == "trunk"

    p.set_repo(None)
    p.set_default_branch(None)
    p3 = loom.get("acme")
    assert isinstance(p3, Project)
    assert p3.repo is None
    assert p3.default_branch is None


def test_set_body_preserves_unknown_frontmatter(loom_dir: Path) -> None:
    loom = Loom(root=loom_dir)
    p = loom.create_project("acme", title="A")
    # Sneak an unknown key in by editing the file directly through storage.
    fm, body = load(p.file_path)
    fm["custom"] = {"score": 7}
    from loom.storage import dump

    dump(p.file_path, fm, body)
    loom.sync("acme")

    p2 = loom.get("acme")
    p2.set_body("new body content\n")
    # Custom key survives the rewrite.
    fm_after, body_after = load(p2.file_path)
    assert fm_after.get("custom") == {"score": 7}
    assert body_after == "new body content\n"


def test_add_remove_tag(loom_dir: Path) -> None:
    loom = Loom(root=loom_dir)
    e = loom.create_project("acme", title="A").create_epic(title="E")
    e.add_tag("auth").add_tag("security")
    assert set(e.tags) == {"auth", "security"}

    # Adding the same tag is a no-op.
    e.add_tag("auth")
    assert e.tags.count("auth") == 1

    e.remove_tag("auth")
    assert "auth" not in e.tags

    # Removing a missing tag is a no-op.
    e.remove_tag("missing")

    # Tags survive a fresh fetch.
    e2 = loom.get(e.qualified_id)
    assert e2.tags == ("security",)


def test_refresh_picks_up_external_changes(loom_dir: Path) -> None:
    loom = Loom(root=loom_dir)
    e = loom.create_project("acme", title="A").create_epic(title="Old")
    # Simulate a write through a different in-memory copy.
    other = loom.get(e.qualified_id)
    other.set_title("New")
    # The original instance is stale until refreshed.
    assert e.title == "Old"
    e.refresh()
    assert e.title == "New"


# ---------------------------------------------------------------------------
# Archive round-trip
# ---------------------------------------------------------------------------


def test_archive_task_only(loom_dir: Path) -> None:
    loom = Loom(root=loom_dir)
    p = loom.create_project("acme", title="A")
    e = p.create_epic(title="E")
    s = e.create_story(title="S")
    t = s.create_task(title="T")

    t.archive()
    assert t.archived is True

    # File is gone from live tree, present in archive tree.
    live_path = loom_dir / "projects" / "acme" / "epics" / e.qid.epic / "stories/1/tasks/1.md"
    arch_path = loom_dir / "_archive/projects/acme/epics" / e.qid.epic / "stories/1/tasks/1.md"
    assert not live_path.exists()
    assert arch_path.exists()

    # Index reflects the archived flag.
    rec = Index(loom_dir).get(t.qualified_id)
    assert rec is not None
    assert rec.archived is True


def test_archive_container_moves_subtree(loom_dir: Path) -> None:
    loom = Loom(root=loom_dir)
    p = loom.create_project("acme", title="A")
    e = p.create_epic(title="E")
    s = e.create_story(title="S")
    t1 = s.create_task(title="T1")
    t2 = s.create_task(title="T2")

    e.archive()

    # Every descendant is now archived in the index.
    idx = Index(loom_dir)
    for qid in (e.qualified_id, s.qualified_id, t1.qualified_id, t2.qualified_id):
        rec = idx.get(qid)
        assert rec is not None
        assert rec.archived is True


def test_archive_already_archived_raises(loom_dir: Path) -> None:
    loom = Loom(root=loom_dir)
    p = loom.create_project("acme", title="A")
    p.archive()
    with pytest.raises(LoomError):
        p.archive()


def test_archive_parent_when_subtree_already_partly_archived_raises(
    loom_dir: Path,
) -> None:
    """If a child was already archived, the parent's archive dest is occupied.

    Locks down the current behavior: archiving the parent in this state
    raises rather than silently merging two trees. A future change that
    accidentally allows overwrite-by-merge will trip this.
    """
    loom = Loom(root=loom_dir)
    p = loom.create_project("acme", title="A")
    e = p.create_epic(title="E")
    e.archive()
    # The project's archive destination already contains the archived epic
    # subtree, so archiving the project must error rather than merge.
    fresh_p = loom.get("acme")
    with pytest.raises(LoomError):
        fresh_p.archive()


# ---------------------------------------------------------------------------
# Lookup
# ---------------------------------------------------------------------------


def test_get_returns_correct_subclass(loom_dir: Path) -> None:
    loom = Loom(root=loom_dir)
    p = loom.create_project("acme", title="A")
    e = p.create_epic(title="E")
    s = e.create_story(title="S")
    t = s.create_task(title="T")

    assert isinstance(loom.get("acme"), Project)
    assert isinstance(loom.get(e.qualified_id), Epic)
    assert isinstance(loom.get(s.qualified_id), Story)
    assert isinstance(loom.get(t.qualified_id), Task)


def test_get_missing_raises(loom_dir: Path) -> None:
    loom = Loom(root=loom_dir)
    with pytest.raises(NotFound):
        loom.get("nonexistent")
    assert loom.get_or_none("nonexistent") is None


def test_find_filters(loom_dir: Path) -> None:
    loom = Loom(root=loom_dir)
    p = loom.create_project("acme", title="A")
    e = p.create_epic(title="E")
    s1 = e.create_story(title="S1")
    s2 = e.create_story(title="S2")
    s2.complete()

    done = loom.find(type="story", status="done")
    assert {x.qualified_id for x in done} == {s2.qualified_id}

    by_project = {x.qualified_id for x in loom.find(project="acme")}
    assert s1.qualified_id in by_project
    assert e.qualified_id in by_project


def test_projects_helper(loom_dir: Path) -> None:
    loom = Loom(root=loom_dir)
    loom.create_project("p1", title="P1")
    loom.create_project("p2", title="P2")
    qids = {p.qualified_id for p in loom.projects()}
    assert qids == {"p1", "p2"}


# ---------------------------------------------------------------------------
# Epic ID generator
# ---------------------------------------------------------------------------


def test_epic_id_is_from_alphabet(loom_dir: Path) -> None:
    loom = Loom(root=loom_dir)
    p = loom.create_project("acme", title="A")
    e = p.create_epic(title="E")
    epic_id = e.qualified_id.split(":")[1]
    assert all(c in EPIC_ALPHABET for c in epic_id)
    assert len(epic_id) == EPIC_ID_LEN


def test_epic_id_collision_retry(monkeypatch: pytest.MonkeyPatch, loom_dir: Path) -> None:
    """If random_epic_id keeps colliding, eventually a unique one wins."""
    loom = Loom(root=loom_dir)
    p = loom.create_project("acme", title="A")
    existing = p.create_epic(title="first")
    existing_id = existing.qualified_id.split(":")[1]

    # First two attempts collide, third returns a fresh id.
    fresh = "abcdefg"
    sequence = iter([existing_id, existing_id, fresh])
    monkeypatch.setattr("loom.items.random_epic_id", lambda: next(sequence))

    second = p.create_epic(title="second")
    assert second.qualified_id == f"acme:{fresh}"


def test_epic_id_collision_exhausted_raises(
    monkeypatch: pytest.MonkeyPatch, loom_dir: Path
) -> None:
    loom = Loom(root=loom_dir)
    p = loom.create_project("acme", title="A")
    existing = p.create_epic(title="first")
    existing_id = existing.qualified_id.split(":")[1]
    monkeypatch.setattr("loom.items.random_epic_id", lambda: existing_id)
    with pytest.raises(LoomError):
        p.create_epic(title="never")
