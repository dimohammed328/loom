"""Tests for the default `backlog` epic feature."""

from __future__ import annotations

from pathlib import Path

import pytest
from typer.testing import CliRunner

from loom import Duplicate, Loom
from loom.cli import app
from loom.errors import InvalidQualifiedId
from loom.ids import BACKLOG_EPIC_ID

runner = CliRunner()


def test_create_epic_with_explicit_id(loom_dir: Path) -> None:
    loom = Loom(root=loom_dir)
    # 'acme' eats the literal 'backlog' epic id via auto-creation; pick a
    # separate project to exercise the explicit-id path without colliding.
    loom.create_project("acme", title="A")
    other = loom.create_project("other", title="O")
    epic = other.create_epic(title="X", epic_id="abcdefg")
    assert epic.qualified_id == "other:abcdefg"


def test_create_epic_explicit_id_duplicate_raises(loom_dir: Path) -> None:
    loom = Loom(root=loom_dir)
    project = loom.create_project("acme", title="A")
    # The backlog already exists from create_project's auto-creation.
    with pytest.raises(Duplicate):
        project.create_epic(title="Backlog 2", epic_id="backlog")


def test_create_epic_invalid_explicit_id_raises(loom_dir: Path) -> None:
    loom = Loom(root=loom_dir)
    project = loom.create_project("acme", title="A")
    # 'BAD' has uppercase chars; not in the alphabet and not the literal 'backlog'.
    with pytest.raises(InvalidQualifiedId):
        project.create_epic(title="X", epic_id="BAD")


def test_create_project_writes_backlog_epic(loom_dir: Path) -> None:
    loom = Loom(root=loom_dir)
    loom.create_project("acme", title="A")

    # Backlog epic exists on disk and in the index.
    backlog_qid = f"acme:{BACKLOG_EPIC_ID}"
    backlog_path = loom_dir / "projects" / "acme" / "epics" / "backlog" / "epic.md"
    assert backlog_path.is_file()

    epic = loom.get(backlog_qid)
    assert epic.title == "Backlog"
    assert epic.qualified_id == backlog_qid
    assert epic.type == "epic"
    # _Statused exposes status; cast through the index record to avoid mypy noise.
    assert epic.record.status == "ready"


def test_create_project_backlog_appears_in_find(loom_dir: Path) -> None:
    loom = Loom(root=loom_dir)
    loom.create_project("acme", title="A")
    epics = loom.find(type="epic")
    assert {e.qualified_id for e in epics} == {f"acme:{BACKLOG_EPIC_ID}"}


def test_create_project_backlog_uses_schema_v2(loom_dir: Path) -> None:
    from loom.storage import load

    loom = Loom(root=loom_dir)
    loom.create_project("acme", title="A")
    backlog_path = loom_dir / "projects" / "acme" / "epics" / "backlog" / "epic.md"
    fm, _body = load(backlog_path)
    assert fm["schema_version"] == 2


def test_project_named_backlog_creates_backlog_backlog(loom_dir: Path) -> None:
    """Edge case: project literally named `backlog` still gets its backlog epic."""
    loom = Loom(root=loom_dir)
    loom.create_project("backlog", title="Backlog Project")
    backlog_path = loom_dir / "projects" / "backlog" / "epics" / "backlog" / "epic.md"
    assert backlog_path.is_file()
    epic = loom.get("backlog:backlog")
    assert epic.title == "Backlog"


def test_cli_story_create_defaults_to_backlog(loom_dir: Path) -> None:
    runner.invoke(
        app,
        [
            "project",
            "create",
            "acme",
            "--title",
            "A",
            "--repo",
            "https://e/a",
            "--root",
            str(loom_dir),
        ],
    )
    r = runner.invoke(
        app,
        ["story", "create", "acme", "--title", "Fix login bug", "--root", str(loom_dir)],
    )
    assert r.exit_code == 0, r.output
    assert "created acme:backlog:1" in r.output


def test_cli_story_create_legacy_project_lazy_creates_backlog(
    loom_dir: Path,
) -> None:
    """A project written without a backlog (legacy layout) gets backlog
    materialized the first time `story create <project>` defaults into it.
    """
    from conftest import write_item
    from loom.ids import QualifiedId

    # Write a project with NO backlog epic — simulates pre-feature layout.
    write_item(loom_dir, QualifiedId("legacy"), title="Legacy Project")

    # Rebuild so the index sees the project.
    runner.invoke(app, ["rebuild", "--root", str(loom_dir), "-q"])

    backlog_path = loom_dir / "projects" / "legacy" / "epics" / "backlog" / "epic.md"
    assert not backlog_path.exists()

    r = runner.invoke(
        app,
        ["story", "create", "legacy", "--title", "S", "--root", str(loom_dir)],
    )
    assert r.exit_code == 0, r.output
    assert backlog_path.is_file()
    assert "created legacy:backlog:1" in r.output


def test_cli_story_create_explicit_epic_unchanged(loom_dir: Path) -> None:
    """Passing a real epic qid still creates the story under that epic."""
    loom = Loom(root=loom_dir)
    p = loom.create_project("acme", title="A")
    e = p.create_epic(title="Auth")
    r = runner.invoke(
        app,
        ["story", "create", e.qualified_id, "--title", "S", "--root", str(loom_dir)],
    )
    assert r.exit_code == 0, r.output
    assert f"created {e.qualified_id}:1" in r.output
