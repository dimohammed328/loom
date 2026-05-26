"""Tests for qid-scoped, level-aware loom ready."""

from __future__ import annotations

from pathlib import Path

from loom.api import Loom


def _setup(root: Path) -> Loom:
    """Build a fixture tree:
    myproj
    └── epic E
        ├── story 1 (ready)
        │   ├── task 1 (ready)
        │   └── task 2 (depends on task 1)
        └── story 2 (ready, depends on story 1)
    """
    loom = Loom(root=root)
    p = loom.create_project(name="myproj", title="MyProj")
    e = p.create_epic(title="E")
    s1 = e.create_story(title="s1")
    t1 = s1.create_task(title="t1")
    t2 = s1.create_task(title="t2")
    t2.depends_on(t1.qualified_id)
    s2 = e.create_story(title="s2")
    s2.depends_on(s1.qualified_id)
    return loom


def _non_backlog_epic(loom: Loom):
    """Return the project's non-backlog epic (the fixture creates one)."""
    return next(e for e in loom.find(type="epic") if not e.qualified_id.endswith(":backlog"))


def test_ready_scoped_to_epic_returns_only_first_level_stories(
    loom_dir: Path,
) -> None:
    loom = _setup(loom_dir)
    epic = _non_backlog_epic(loom)
    items = loom.ready(parent=epic.qualified_id, type="story")
    qids = {i.qualified_id for i in items}
    # Only s1 is ready; s2 is blocked by s1.
    assert any(q.endswith(":1") for q in qids)
    assert not any(q.endswith(":2") for q in qids)


def test_ready_recursive_returns_all_ready_descendants(loom_dir: Path) -> None:
    loom = _setup(loom_dir)
    epic = _non_backlog_epic(loom)
    items = loom.ready(parent=epic.qualified_id, recursive=True)
    # Should include story 1 AND task 1 (both ready, no blockers under epic).
    # Task 2 is blocked by task 1, story 2 is blocked by story 1.
    qids = {i.qualified_id for i in items}
    # Exactly two: the story and the unblocked task.
    assert len(qids) == 2


def test_ready_no_parent_returns_global(loom_dir: Path) -> None:
    """Existing behavior preserved when parent is omitted."""
    loom = _setup(loom_dir)
    items = loom.ready()
    # At least one ready item across the whole tree.
    assert items
