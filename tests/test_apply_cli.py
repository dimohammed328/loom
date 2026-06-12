"""Tests for `loom apply` CLI command: file/stdin/--dry-run, exit codes, state touch, e2e.

RED phase: all tests must fail before any CLI implementation is written.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from typer.testing import CliRunner

from loom.api import Loom
from loom.cli import app

runner = CliRunner()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _plan_json(items: list[dict]) -> str:
    return json.dumps({"items": items})


def _make_project(loom_dir: Path, name: str = "p") -> str:
    """Create a project and return its qid."""
    loom = Loom(root=loom_dir)
    loom.create_project(name, title="Test Project")
    return name


# ---------------------------------------------------------------------------
# Basic file input
# ---------------------------------------------------------------------------


def test_apply_creates_items_from_file(tmp_path: Path, loom_dir: Path) -> None:
    _make_project(loom_dir)
    plan_file = tmp_path / "plan.json"
    plan_file.write_text(
        _plan_json(
            [
                {"ref": "e1", "type": "epic", "parent": "p", "title": "My Epic"},
            ]
        )
    )

    result = runner.invoke(app, ["apply", "--root", str(loom_dir), str(plan_file)])

    assert result.exit_code == 0
    out = json.loads(result.output.splitlines()[0])
    assert len(out["created"]) == 1
    assert out["created"][0]["type"] == "epic"
    assert out["created"][0]["ref"] == "e1"
    assert out["created"][0]["qid"].startswith("p:")


def test_apply_stdout_is_bare_json(tmp_path: Path, loom_dir: Path) -> None:
    """stdout must be JSON only — no human text."""
    _make_project(loom_dir)
    plan_file = tmp_path / "plan.json"
    plan_file.write_text(
        _plan_json(
            [
                {"type": "epic", "parent": "p", "title": "E"},
            ]
        )
    )

    result = runner.invoke(app, ["apply", "--root", str(loom_dir), str(plan_file)])

    assert result.exit_code == 0
    # Must parse cleanly as JSON
    data = json.loads(result.output.splitlines()[0])
    assert "created" in data


# ---------------------------------------------------------------------------
# stdin input (-)
# ---------------------------------------------------------------------------


def test_apply_reads_from_stdin(loom_dir: Path) -> None:
    _make_project(loom_dir)
    plan = _plan_json([{"ref": "e1", "type": "epic", "parent": "p", "title": "Stdin Epic"}])

    result = runner.invoke(app, ["apply", "--root", str(loom_dir), "-"], input=plan)

    assert result.exit_code == 0
    out = json.loads(result.output.splitlines()[0])
    assert out["created"][0]["ref"] == "e1"


# ---------------------------------------------------------------------------
# --dry-run
# ---------------------------------------------------------------------------


def test_apply_dry_run_creates_nothing(tmp_path: Path, loom_dir: Path) -> None:
    """--dry-run must not persist any items."""
    _make_project(loom_dir)
    plan_file = tmp_path / "plan.json"
    plan_file.write_text(
        _plan_json(
            [
                {"type": "epic", "parent": "p", "title": "Should Not Exist"},
            ]
        )
    )

    result = runner.invoke(app, ["apply", "--root", str(loom_dir), "--dry-run", str(plan_file)])

    assert result.exit_code == 0
    loom = Loom(root=loom_dir)
    epics = loom.find(type="epic", project="p")
    # Only the auto-created backlog epic should exist, no user epic.
    titles = [e.title for e in epics]
    assert "Should Not Exist" not in titles


def test_apply_dry_run_exits_zero_on_valid_plan(tmp_path: Path, loom_dir: Path) -> None:
    _make_project(loom_dir)
    plan_file = tmp_path / "plan.json"
    plan_file.write_text(
        _plan_json(
            [
                {"type": "epic", "parent": "p", "title": "Dry Run Epic"},
            ]
        )
    )

    result = runner.invoke(app, ["apply", "--root", str(loom_dir), "--dry-run", str(plan_file)])

    assert result.exit_code == 0


def test_apply_dry_run_exits_nonzero_on_invalid_plan(tmp_path: Path, loom_dir: Path) -> None:
    """--dry-run on a plan that would fail validation exits nonzero."""
    _make_project(loom_dir)
    plan_file = tmp_path / "plan.json"
    plan_file.write_text(
        _plan_json(
            [
                {"type": "epic", "parent": "nonexistent-proj", "title": "E"},
            ]
        )
    )

    result = runner.invoke(app, ["apply", "--root", str(loom_dir), "--dry-run", str(plan_file)])

    assert result.exit_code != 0


# ---------------------------------------------------------------------------
# Exit codes
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "bad_items,expected_code",
    [
        # Duplicate ref -> exit 3
        (
            [
                {"ref": "e1", "type": "epic", "parent": "p", "title": "E1"},
                {"ref": "e1", "type": "epic", "parent": "p", "title": "E2"},
            ],
            3,
        ),
        # Unknown parent qid -> exit 2
        (
            [{"type": "epic", "parent": "does-not-exist", "title": "E"}],
            2,
        ),
        # Bad/malformed JSON -> exit 1
        # (tested separately below as it needs different input handling)
    ],
)
def test_apply_cli_exit_codes(bad_items, expected_code, tmp_path: Path, loom_dir: Path) -> None:
    _make_project(loom_dir)
    plan_file = tmp_path / "plan.json"
    plan_file.write_text(_plan_json(bad_items))

    result = runner.invoke(app, ["apply", "--root", str(loom_dir), str(plan_file)])

    assert result.exit_code == expected_code


def test_apply_malformed_json_exits_1(tmp_path: Path, loom_dir: Path) -> None:
    _make_project(loom_dir)
    plan_file = tmp_path / "plan.json"
    plan_file.write_text("not json at all {{{")

    result = runner.invoke(app, ["apply", "--root", str(loom_dir), str(plan_file)])

    assert result.exit_code == 1


def test_apply_missing_items_key_exits_1(tmp_path: Path, loom_dir: Path) -> None:
    """JSON without an 'items' key is malformed -> exit 1."""
    _make_project(loom_dir)
    plan_file = tmp_path / "plan.json"
    plan_file.write_text(json.dumps({"not_items": []}))

    result = runner.invoke(app, ["apply", "--root", str(loom_dir), str(plan_file)])

    assert result.exit_code == 1


# ---------------------------------------------------------------------------
# Full chain via CLI
# ---------------------------------------------------------------------------


def test_apply_full_chain_via_cli(tmp_path: Path, loom_dir: Path) -> None:
    _make_project(loom_dir)
    plan_file = tmp_path / "plan.json"
    plan_file.write_text(
        _plan_json(
            [
                {"ref": "epic", "type": "epic", "parent": "p", "title": "CLI Epic"},
                {"ref": "s1", "type": "story", "parent": "epic", "title": "CLI Story"},
                {"type": "task", "parent": "s1", "title": "CLI Task"},
            ]
        )
    )

    result = runner.invoke(app, ["apply", "--root", str(loom_dir), str(plan_file)])

    assert result.exit_code == 0
    out = json.loads(result.output.splitlines()[0])
    assert len(out["created"]) == 3
    types = [e["type"] for e in out["created"]]
    assert types == ["epic", "story", "task"]

    loom = Loom(root=loom_dir)
    for entry in out["created"]:
        item = loom.get(entry["qid"])
        assert item is not None


# ---------------------------------------------------------------------------
# state touch after successful apply
# ---------------------------------------------------------------------------


def test_apply_updates_workspace_state(tmp_path: Path, loom_dir: Path) -> None:
    """After successful apply, the last-created item is recorded in workspace state."""
    from loom import state as state_mod

    _make_project(loom_dir)
    # Init a workspace in tmp_path (tests chdir there via autouse fixture)
    state_mod.init_workspace(Path.cwd(), "p")

    plan_file = tmp_path / "plan.json"
    plan_file.write_text(
        _plan_json(
            [
                {"ref": "e1", "type": "epic", "parent": "p", "title": "E"},
                {"ref": "s1", "type": "story", "parent": "e1", "title": "S"},
            ]
        )
    )

    result = runner.invoke(app, ["apply", "--root", str(loom_dir), str(plan_file)])
    assert result.exit_code == 0

    out = json.loads(result.output.splitlines()[0])
    last_story_qid = out["created"][1]["qid"]

    ws_dir = state_mod.find_workspace_dir(Path.cwd())
    assert ws_dir is not None
    ws = state_mod.load_workspace(ws_dir)
    # The last-touched story qid should be recorded
    assert ws.last.story == last_story_qid


# ---------------------------------------------------------------------------
# Human notes go to stderr (not stdout)
# ---------------------------------------------------------------------------


def test_apply_human_notes_on_stderr(tmp_path: Path, loom_dir: Path) -> None:
    """Any human-readable progress notes go to stderr, not polluting stdout JSON."""
    _make_project(loom_dir)
    plan_file = tmp_path / "plan.json"
    plan_file.write_text(
        _plan_json(
            [
                {"type": "epic", "parent": "p", "title": "E"},
            ]
        )
    )

    result = runner.invoke(
        app, ["apply", "--root", str(loom_dir), str(plan_file)], catch_exceptions=False
    )

    assert result.exit_code == 0
    # stdout must be pure JSON
    json.loads(result.output.splitlines()[0])


# ---------------------------------------------------------------------------
# Parametrized reject tests
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "bad_plan,expected_exit",
    [
        # Malformed JSON
        ("not json", 1),
        # Missing 'items' key
        ('{"other": []}', 1),
        # Unknown parent qid
        ('{"items": [{"type": "epic", "parent": "no-such-proj", "title": "E"}]}', 2),
        # Duplicate ref
        (
            '{"items": [{"ref": "r", "type": "epic", "parent": "p", "title": "A"}, '
            '{"ref": "r", "type": "epic", "parent": "p", "title": "B"}]}',
            3,
        ),
        # Empty title
        ('{"items": [{"type": "epic", "parent": "p", "title": ""}]}', 1),
        # Bad type
        ('{"items": [{"type": "bogus", "parent": "p", "title": "X"}]}', 1),
    ],
)
def test_apply_parametrized_reject_cases(
    bad_plan, expected_exit, tmp_path: Path, loom_dir: Path
) -> None:
    _make_project(loom_dir)
    plan_file = tmp_path / "plan.json"
    plan_file.write_text(bad_plan)

    result = runner.invoke(app, ["apply", "--root", str(loom_dir), str(plan_file)])

    assert result.exit_code == expected_exit
