"""Tests for loom list workspace-scoping behavior (story loom-app:rr948yv:1).

Tests for Task 1: Default loom list to the bound project
Tests for Task 2: Add --all bypass to loom list
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest
from typer.testing import CliRunner

from loom import state
from loom.bootstrap import init
from loom.cli import app

runner = CliRunner()


def _setup_two_projects(root: Path) -> tuple[str, str]:
    """Create two projects (alpha, beta) each with one epic/story/task.

    Returns (alpha_task_qid, beta_task_qid).
    """
    # Project alpha
    r = runner.invoke(
        app,
        [
            "project",
            "create",
            "alpha",
            "--title",
            "Alpha",
            "--repo",
            "https://github.com/example/alpha",
            "--root",
            str(root),
        ],
    )
    assert r.exit_code == 0, r.output

    r = runner.invoke(
        app, ["epic", "create", "alpha", "--title", "Alpha Epic", "--root", str(root)]
    )
    assert r.exit_code == 0, r.output
    alpha_epic = r.output.strip().removeprefix("created ").strip()

    r = runner.invoke(
        app,
        [
            "story",
            "create",
            alpha_epic,
            "--title",
            "Alpha Story",
            "--root",
            str(root),
        ],
    )
    assert r.exit_code == 0, r.output
    alpha_story = r.output.strip().removeprefix("created ").strip()

    r = runner.invoke(
        app,
        [
            "task",
            "create",
            alpha_story,
            "--title",
            "Alpha Task",
            "--root",
            str(root),
        ],
    )
    assert r.exit_code == 0, r.output
    alpha_task = r.output.strip().removeprefix("created ").strip()

    # Project beta
    r = runner.invoke(
        app,
        [
            "project",
            "create",
            "beta",
            "--title",
            "Beta",
            "--repo",
            "https://github.com/example/beta",
            "--root",
            str(root),
        ],
    )
    assert r.exit_code == 0, r.output

    r = runner.invoke(app, ["epic", "create", "beta", "--title", "Beta Epic", "--root", str(root)])
    assert r.exit_code == 0, r.output
    beta_epic = r.output.strip().removeprefix("created ").strip()

    r = runner.invoke(
        app,
        [
            "story",
            "create",
            beta_epic,
            "--title",
            "Beta Story",
            "--root",
            str(root),
        ],
    )
    assert r.exit_code == 0, r.output
    beta_story = r.output.strip().removeprefix("created ").strip()

    r = runner.invoke(
        app,
        [
            "task",
            "create",
            beta_story,
            "--title",
            "Beta Task",
            "--root",
            str(root),
        ],
    )
    assert r.exit_code == 0, r.output
    beta_task = r.output.strip().removeprefix("created ").strip()

    return alpha_task, beta_task


# ---------------------------------------------------------------------------
# Task 1: Default loom list to the bound project
# ---------------------------------------------------------------------------


def test_list_default_scopes_to_bound_project(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """loom list with no filters, from within project alpha, returns only alpha items."""
    root = tmp_path / "loom"
    init(root)
    alpha_task, beta_task = _setup_two_projects(root)

    # Bind workspace to alpha
    state.init_workspace(tmp_path, "alpha")

    r = runner.invoke(app, ["list", "--json", "--root", str(root)])
    assert r.exit_code == 0, r.output
    payload = json.loads(r.output)
    qids = {item["qualified_id"] for item in payload}
    assert alpha_task in qids
    assert beta_task not in qids
    # No beta items at all
    assert all(qid.startswith("alpha") for qid in qids)


def test_list_default_scopes_from_child_dir(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """loom list from a child dir of a workspace-bound project returns only that project."""
    root = tmp_path / "loom"
    init(root)
    alpha_task, beta_task = _setup_two_projects(root)

    # Bind workspace at tmp_path, then chdir to a subdirectory
    state.init_workspace(tmp_path, "alpha")
    child = tmp_path / "subdir"
    child.mkdir()
    monkeypatch.chdir(child)

    r = runner.invoke(app, ["list", "--json", "--root", str(root)])
    assert r.exit_code == 0, r.output
    payload = json.loads(r.output)
    qids = {item["qualified_id"] for item in payload}
    assert alpha_task in qids
    assert beta_task not in qids


def test_list_outside_project_returns_all(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """loom list outside any workspace returns all items (no filter)."""
    root = tmp_path / "loom"
    init(root)
    alpha_task, beta_task = _setup_two_projects(root)

    # Remove the .loom/ workspace that project create auto-created, so there
    # is no workspace binding at all.
    ws_dir = tmp_path / ".loom"
    if ws_dir.exists():
        shutil.rmtree(ws_dir)

    r = runner.invoke(app, ["list", "--json", "--root", str(root)])
    assert r.exit_code == 0, r.output
    payload = json.loads(r.output)
    qids = {item["qualified_id"] for item in payload}
    assert alpha_task in qids
    assert beta_task in qids


def test_list_explicit_project_overrides_default(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """loom list --project Q returns only Q's items, overriding the bound default."""
    root = tmp_path / "loom"
    init(root)
    alpha_task, beta_task = _setup_two_projects(root)

    # Workspace bound to alpha, but --project beta overrides
    state.init_workspace(tmp_path, "alpha")

    r = runner.invoke(app, ["list", "--project", "beta", "--json", "--root", str(root)])
    assert r.exit_code == 0, r.output
    payload = json.loads(r.output)
    qids = {item["qualified_id"] for item in payload}
    assert beta_task in qids
    assert alpha_task not in qids


# ---------------------------------------------------------------------------
# Task 2: Add --all bypass to loom list
# ---------------------------------------------------------------------------


def test_list_all_returns_items_from_all_projects(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """loom list --all returns items across all projects even when workspace is bound."""
    root = tmp_path / "loom"
    init(root)
    alpha_task, beta_task = _setup_two_projects(root)

    # Bind workspace to alpha
    state.init_workspace(tmp_path, "alpha")

    r = runner.invoke(app, ["list", "--all", "--json", "--root", str(root)])
    assert r.exit_code == 0, r.output
    payload = json.loads(r.output)
    qids = {item["qualified_id"] for item in payload}
    assert alpha_task in qids
    assert beta_task in qids


def test_list_all_with_explicit_project_is_rejected(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """loom list --all --project P should fail (mutually exclusive)."""
    root = tmp_path / "loom"
    init(root)
    _setup_two_projects(root)

    r = runner.invoke(app, ["list", "--all", "--project", "alpha", "--root", str(root)])
    assert r.exit_code != 0
