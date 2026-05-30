"""Tests for loom.api.Loom.project_status and the `loom status` CLI command."""

from __future__ import annotations

from pathlib import Path

import pytest
from typer.testing import CliRunner

from conftest import write_item
from loom.api import Loom
from loom.ids import QualifiedId
from loom.rebuild import rebuild

runner = CliRunner()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _setup_project(loom_dir: Path) -> str:
    """Build a project with a mix of done/not-done epics, stories, tasks."""
    project_qid = QualifiedId("myproj")
    epic_qid = QualifiedId("myproj", "abcdefg")
    epic2_qid = QualifiedId("myproj", "aaabbbg")
    story1_qid = QualifiedId("myproj", "abcdefg", 1)
    story2_qid = QualifiedId("myproj", "abcdefg", 2)
    task1_qid = QualifiedId("myproj", "abcdefg", 1, 1)
    task2_qid = QualifiedId("myproj", "abcdefg", 1, 2)
    task3_qid = QualifiedId("myproj", "abcdefg", 2, 1)

    write_item(loom_dir, project_qid, title="My Project")
    write_item(loom_dir, epic_qid, title="Epic One", status="ready")
    write_item(loom_dir, epic2_qid, title="Epic Two", status="done")
    write_item(loom_dir, story1_qid, title="Story One", status="in_progress")
    write_item(loom_dir, story2_qid, title="Story Two", status="done")
    write_item(loom_dir, task1_qid, title="Task One", status="ready")
    write_item(loom_dir, task2_qid, title="Task Two", status="done")
    write_item(loom_dir, task3_qid, title="Task Three", status="done")

    rebuild(loom_dir)
    return "myproj"


# ---------------------------------------------------------------------------
# Library tests: Loom.project_status
# ---------------------------------------------------------------------------


def test_project_status_counts_open_and_closed(loom_dir: Path) -> None:
    """project_status returns per-type open/closed counts; project row excluded."""
    _setup_project(loom_dir)
    loom = Loom(root=loom_dir)

    result = loom.project_status("myproj")

    assert result["project"] == "myproj"
    # 2 epics total: 1 done (closed), 1 not done (open)
    assert result["epics"]["open"] == 1
    assert result["epics"]["closed"] == 1
    # 2 stories total: 1 done (closed), 1 not done (open)
    assert result["stories"]["open"] == 1
    assert result["stories"]["closed"] == 1
    # 3 tasks total: 2 done (closed), 1 not done (open)
    assert result["tasks"]["open"] == 1
    assert result["tasks"]["closed"] == 2


def test_project_status_all_open(loom_dir: Path) -> None:
    """project_status counts correctly when nothing is done."""
    project_qid = QualifiedId("fresh")
    epic_qid = QualifiedId("fresh", "abcdefg")
    story_qid = QualifiedId("fresh", "abcdefg", 1)
    task_qid = QualifiedId("fresh", "abcdefg", 1, 1)

    write_item(loom_dir, project_qid, title="Fresh")
    write_item(loom_dir, epic_qid, title="Epic", status="ready")
    write_item(loom_dir, story_qid, title="Story", status="ready")
    write_item(loom_dir, task_qid, title="Task", status="ready")
    rebuild(loom_dir)

    result = Loom(root=loom_dir).project_status("fresh")

    assert result["epics"] == {"open": 1, "closed": 0}
    assert result["stories"] == {"open": 1, "closed": 0}
    assert result["tasks"] == {"open": 1, "closed": 0}


def test_project_status_all_closed(loom_dir: Path) -> None:
    """project_status counts correctly when everything is done."""
    project_qid = QualifiedId("allclosed")
    epic_qid = QualifiedId("allclosed", "abcdefg")
    story_qid = QualifiedId("allclosed", "abcdefg", 1)
    task_qid = QualifiedId("allclosed", "abcdefg", 1, 1)

    write_item(loom_dir, project_qid, title="AllClosed")
    write_item(loom_dir, epic_qid, title="Epic", status="done")
    write_item(loom_dir, story_qid, title="Story", status="done")
    write_item(loom_dir, task_qid, title="Task", status="done")
    rebuild(loom_dir)

    result = Loom(root=loom_dir).project_status("allclosed")

    assert result["epics"] == {"open": 0, "closed": 1}
    assert result["stories"] == {"open": 0, "closed": 1}
    assert result["tasks"] == {"open": 0, "closed": 1}


def test_project_status_raises_not_found_for_unknown_project(loom_dir: Path) -> None:
    """project_status raises NotFound for a project that doesn't exist."""
    from loom.errors import NotFound

    loom = Loom(root=loom_dir)
    with pytest.raises(NotFound):
        loom.project_status("nonexistent")
