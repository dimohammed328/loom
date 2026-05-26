"""Tests for Loom.tree() and loom tree CLI."""

from __future__ import annotations

import json
from pathlib import Path

from typer.testing import CliRunner

from loom.api import Loom
from loom.cli import app


def _build_tree(root: Path) -> Loom:
    loom = Loom(root=root)
    p = loom.create_project(name="myproj", title="myproj")
    e = p.create_epic(title="E")
    s1 = e.create_story(title="s1")
    s1.create_task(title="t1")
    s1.create_task(title="t2")
    e.create_story(title="s2")
    return loom


def test_tree_flat_array_includes_all_descendants(loom_dir: Path) -> None:
    loom = _build_tree(loom_dir)
    epic = next(e for e in loom.find(type="epic") if not e.qualified_id.endswith(":backlog"))
    result = loom.tree(epic.qualified_id)
    qids = {entry["qid"] for entry in result["items"]}
    assert result["root"] == epic.qualified_id
    # epic, 2 stories, 2 tasks = 5 items
    assert len(result["items"]) == 5
    assert epic.qualified_id in qids


def test_tree_children_are_qid_refs(loom_dir: Path) -> None:
    loom = _build_tree(loom_dir)
    epic = next(e for e in loom.find(type="epic") if not e.qualified_id.endswith(":backlog"))
    result = loom.tree(epic.qualified_id)
    by_qid = {entry["qid"]: entry for entry in result["items"]}
    epic_entry = by_qid[epic.qualified_id]
    # children is a list of qid strings, NOT nested objects
    assert isinstance(epic_entry["children"], list)
    assert all(isinstance(c, str) for c in epic_entry["children"])
    assert len(epic_entry["children"]) == 2  # two stories


def test_tree_depth_limits_descent(loom_dir: Path) -> None:
    loom = _build_tree(loom_dir)
    epic = next(e for e in loom.find(type="epic") if not e.qualified_id.endswith(":backlog"))
    result = loom.tree(epic.qualified_id, depth=1)
    # Only epic + direct children (2 stories), tasks excluded.
    assert len(result["items"]) == 3


def test_tree_status_filter(loom_dir: Path) -> None:
    loom = _build_tree(loom_dir)
    epic = next(e for e in loom.find(type="epic") if not e.qualified_id.endswith(":backlog"))
    # Complete one task
    tasks = loom.find(type="task")
    tasks[0].complete()
    result = loom.tree(epic.qualified_id, status="done")
    assert all(entry["status"] == "done" for entry in result["items"])
    assert len(result["items"]) == 1


def test_cli_tree_text_output(loom_dir: Path) -> None:
    loom = _build_tree(loom_dir)
    epic = next(e for e in loom.find(type="epic") if not e.qualified_id.endswith(":backlog"))
    runner = CliRunner()
    result = runner.invoke(app, ["tree", epic.qualified_id, "--root", str(loom_dir)])
    assert result.exit_code == 0, result.output
    # Unicode box characters for the tree
    assert "├─" in result.output or "└─" in result.output
    # Root qid appears at top
    assert epic.qualified_id in result.output
    # Status is shown
    assert "ready" in result.output


def test_cli_tree_json_output(loom_dir: Path) -> None:
    loom = _build_tree(loom_dir)
    epic = next(e for e in loom.find(type="epic") if not e.qualified_id.endswith(":backlog"))
    runner = CliRunner()
    result = runner.invoke(
        app,
        ["tree", epic.qualified_id, "--root", str(loom_dir), "--json"],
    )
    assert result.exit_code == 0, result.output
    data = json.loads(result.output)
    assert data["root"] == epic.qualified_id
    assert isinstance(data["items"], list)
