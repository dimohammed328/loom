"""Tests for Loom.reopen() — recursive status reset + assignee clear."""

from __future__ import annotations

from pathlib import Path

from loom.api import Loom


def test_reopen_resets_self_and_descendants(loom_dir: Path) -> None:
    loom = Loom(root=loom_dir)
    p = loom.create_project(name="p", title="p")
    e = p.create_epic(title="E")
    s = e.create_story(title="s")
    t1 = s.create_task(title="t1")
    t2 = s.create_task(title="t2")
    t1.complete()
    t2.complete()
    # Mark the story done too (close_if_children_done)
    s.complete()
    assert s.refresh().status == "done"
    assert t1.refresh().status == "done"

    loom.reopen(s.qualified_id)

    assert loom.get(s.qualified_id).status == "ready"
    assert loom.get(t1.qualified_id).status == "ready"
    assert loom.get(t2.qualified_id).status == "ready"


def test_reopen_clears_assignee(loom_dir: Path) -> None:
    loom = Loom(root=loom_dir)
    p = loom.create_project(name="p", title="p")
    e = p.create_epic(title="E")
    s = e.create_story(title="s")
    s.set_assignee("session_abc:agent_xyz")
    assert s.refresh().assignee == "session_abc:agent_xyz"
    loom.reopen(s.qualified_id)
    assert loom.get(s.qualified_id).assignee is None


def test_reopen_skips_archived(loom_dir: Path) -> None:
    """Archived descendants live under _archive/; reopen should not touch them."""
    loom = Loom(root=loom_dir)
    p = loom.create_project(name="p", title="p")
    e = p.create_epic(title="E")
    s = e.create_story(title="s")
    t1 = s.create_task(title="t1")
    t1.archive()
    s.complete()
    loom.reopen(s.qualified_id)
    # Archived t1 should still be archived; reopen only touches live tree.
    archived = loom.find(type="task", archived=True)
    assert any(item.qualified_id == t1.qualified_id for item in archived)


from typer.testing import CliRunner  # noqa: E402

from loom.cli import app  # noqa: E402


def test_cli_reopen(loom_dir: Path) -> None:
    loom = Loom(root=loom_dir)
    p = loom.create_project(name="p", title="p")
    e = p.create_epic(title="E")
    s = e.create_story(title="s")
    t = s.create_task(title="t")
    t.complete()
    s.complete()
    runner = CliRunner()
    result = runner.invoke(app, ["reopen", s.qualified_id, "--root", str(loom_dir)])
    assert result.exit_code == 0, result.output
    assert loom.get(s.qualified_id).status == "ready"
    assert loom.get(t.qualified_id).status == "ready"
