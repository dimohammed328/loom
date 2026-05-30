"""Tests for Loom.tree() and loom tree CLI."""

from __future__ import annotations

import json
from pathlib import Path

from typer.testing import CliRunner

from loom import state
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


# ---------------------------------------------------------------------------
# Default mode: no qid, uses bound project
# ---------------------------------------------------------------------------


def test_cli_tree_no_qid_shows_open_epics(loom_dir: Path, tmp_path: Path) -> None:
    """loom tree with no qid uses the bound project and shows open epics."""
    _build_tree(loom_dir)
    # Bind the workspace to myproj
    state.init_workspace(tmp_path, "myproj")
    runner = CliRunner()
    result = runner.invoke(app, ["tree", "--root", str(loom_dir)])
    assert result.exit_code == 0, result.output
    # Should show the epic (non-backlog, non-done)
    assert "myproj" in result.output


def test_cli_tree_no_qid_json_shows_project_root(loom_dir: Path, tmp_path: Path) -> None:
    """loom tree --json with no qid has root=<project qid>."""
    _build_tree(loom_dir)
    state.init_workspace(tmp_path, "myproj")
    runner = CliRunner()
    result = runner.invoke(app, ["tree", "--root", str(loom_dir), "--json"])
    assert result.exit_code == 0, result.output
    data = json.loads(result.output)
    assert data["root"] == "myproj"
    # Only open (non-done) epics included, not backlog
    open_epic_qids = [item["qid"] for item in data["items"] if item["type"] == "epic"]
    assert all(not q.endswith(":backlog") for q in open_epic_qids)


def test_cli_tree_no_qid_excludes_done_epics(loom_dir: Path, tmp_path: Path) -> None:
    """loom tree with no qid excludes done epics by default."""
    loom = _build_tree(loom_dir)
    state.init_workspace(tmp_path, "myproj")
    # Complete the non-backlog epic
    non_backlog_epics = [
        e for e in loom.find(type="epic") if not e.qualified_id.endswith(":backlog")
    ]
    non_backlog_epics[0].complete()
    runner = CliRunner()
    result = runner.invoke(app, ["tree", "--root", str(loom_dir), "--json"])
    assert result.exit_code == 0, result.output
    data = json.loads(result.output)
    epic_qids = [item["qid"] for item in data["items"] if item["type"] == "epic"]
    # The done epic should NOT be present
    assert non_backlog_epics[0].qualified_id not in epic_qids


def test_cli_tree_no_qid_outside_project_exits_nonzero(loom_dir: Path) -> None:
    """loom tree with no qid outside any project fails with EXIT_NOT_FOUND."""
    # No workspace bound (conftest chdir to tmp_path with no .loom)
    runner = CliRunner()
    result = runner.invoke(app, ["tree", "--root", str(loom_dir)])
    assert result.exit_code == 2  # EXIT_NOT_FOUND
    assert "loom project not found" in result.output


# ---------------------------------------------------------------------------
# --all flag: include done epics in default project mode
# ---------------------------------------------------------------------------


def test_cli_tree_all_includes_done_epics(loom_dir: Path, tmp_path: Path) -> None:
    """loom tree --all includes done epics in the default project mode."""
    loom = _build_tree(loom_dir)
    state.init_workspace(tmp_path, "myproj")
    non_backlog_epics = [
        e for e in loom.find(type="epic") if not e.qualified_id.endswith(":backlog")
    ]
    non_backlog_epics[0].complete()
    runner = CliRunner()
    result = runner.invoke(app, ["tree", "--all", "--root", str(loom_dir), "--json"])
    assert result.exit_code == 0, result.output
    data = json.loads(result.output)
    epic_qids = [item["qid"] for item in data["items"] if item["type"] == "epic"]
    # Done epic should now be included
    assert non_backlog_epics[0].qualified_id in epic_qids


def test_cli_tree_all_without_done_epics_shows_all_open(loom_dir: Path, tmp_path: Path) -> None:
    """loom tree --all with no done epics shows all open epics (same as without --all)."""
    _build_tree(loom_dir)
    state.init_workspace(tmp_path, "myproj")
    runner = CliRunner()
    result_default = runner.invoke(app, ["tree", "--root", str(loom_dir), "--json"])
    result_all = runner.invoke(app, ["tree", "--all", "--root", str(loom_dir), "--json"])
    assert result_default.exit_code == 0, result_default.output
    assert result_all.exit_code == 0, result_all.output
    default_qids = {i["qid"] for i in json.loads(result_default.output)["items"]}
    all_qids = {i["qid"] for i in json.loads(result_all.output)["items"]}
    # With no done epics, --all and default produce the same non-backlog items
    assert default_qids == all_qids


def test_cli_tree_all_on_explicit_qid_is_ignored(loom_dir: Path) -> None:
    """loom tree <qid> --all renders the explicit qid subtree (--all is a no-op)."""
    loom = _build_tree(loom_dir)
    epic = next(e for e in loom.find(type="epic") if not e.qualified_id.endswith(":backlog"))
    runner = CliRunner()
    result = runner.invoke(
        app, ["tree", epic.qualified_id, "--all", "--root", str(loom_dir), "--json"]
    )
    assert result.exit_code == 0, result.output
    data = json.loads(result.output)
    assert data["root"] == epic.qualified_id
