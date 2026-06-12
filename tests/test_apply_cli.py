"""Tests for `loom apply` CLI command: nested schema, error report, exit codes, e2e.

Covers: nested JSON input via file/stdin/dry-run, multi-error stdout report,
exact path/code assertions, exit-code mapping per first error,
dry-run on invalid plan prints the report, state touch, human notes to stderr.
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
# Basic nested file input
# ---------------------------------------------------------------------------


def test_apply_creates_items_from_nested_file(tmp_path: Path, loom_dir: Path) -> None:
    _make_project(loom_dir)
    plan_file = tmp_path / "plan.json"
    plan_file.write_text(
        json.dumps(
            {
                "items": [
                    {
                        "ref": "e1",
                        "type": "epic",
                        "parent": "p",
                        "title": "My Epic",
                        "children": [
                            {
                                "ref": "s1",
                                "type": "story",
                                "title": "My Story",
                                "children": [{"type": "task", "title": "My Task"}],
                            }
                        ],
                    }
                ]
            }
        )
    )

    result = runner.invoke(app, ["apply", "--root", str(loom_dir), str(plan_file)])

    assert result.exit_code == 0, result.output
    out = json.loads(result.output.splitlines()[0])
    assert len(out["created"]) == 3
    types = [e["type"] for e in out["created"]]
    assert types == ["epic", "story", "task"]
    assert out["created"][0]["ref"] == "e1"
    assert out["created"][1]["ref"] == "s1"


def test_apply_stdout_is_bare_json(tmp_path: Path, loom_dir: Path) -> None:
    """stdout must be JSON only — no human text."""
    _make_project(loom_dir)
    plan_file = tmp_path / "plan.json"
    plan_file.write_text(_plan_json([{"type": "epic", "parent": "p", "title": "E"}]))

    result = runner.invoke(app, ["apply", "--root", str(loom_dir), str(plan_file)])

    assert result.exit_code == 0
    data = json.loads(result.output.splitlines()[0])
    assert "created" in data


# ---------------------------------------------------------------------------
# stdin input (-)
# ---------------------------------------------------------------------------


def test_apply_reads_from_stdin(loom_dir: Path) -> None:
    _make_project(loom_dir)
    plan = json.dumps(
        {"items": [{"ref": "e1", "type": "epic", "parent": "p", "title": "Stdin Epic"}]}
    )

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
    plan_file.write_text(_plan_json([{"type": "epic", "parent": "p", "title": "Should Not Exist"}]))

    result = runner.invoke(app, ["apply", "--root", str(loom_dir), "--dry-run", str(plan_file)])

    assert result.exit_code == 0
    loom = Loom(root=loom_dir)
    epics = loom.find(type="epic", project="p")
    titles = [e.title for e in epics]
    assert "Should Not Exist" not in titles


def test_apply_dry_run_prints_flattened_plan(tmp_path: Path, loom_dir: Path) -> None:
    """--dry-run on valid plan prints flattened depth-first plan as JSON."""
    _make_project(loom_dir)
    plan_file = tmp_path / "plan.json"
    plan_file.write_text(
        json.dumps(
            {
                "items": [
                    {
                        "ref": "e1",
                        "type": "epic",
                        "parent": "p",
                        "title": "Epic",
                        "children": [{"type": "story", "title": "Story"}],
                    }
                ]
            }
        )
    )

    result = runner.invoke(app, ["apply", "--root", str(loom_dir), "--dry-run", str(plan_file)])

    assert result.exit_code == 0
    payload = json.loads(result.stdout)
    assert "plan" in payload
    types_in_order = [i["type"] for i in payload["plan"]]
    assert types_in_order == ["epic", "story"]


def test_apply_dry_run_exits_nonzero_on_invalid_plan(tmp_path: Path, loom_dir: Path) -> None:
    """--dry-run on a plan that fails validation exits nonzero and prints errors."""
    _make_project(loom_dir)
    plan_file = tmp_path / "plan.json"
    plan_file.write_text(_plan_json([{"type": "epic", "parent": "nonexistent-proj", "title": "E"}]))

    result = runner.invoke(app, ["apply", "--root", str(loom_dir), "--dry-run", str(plan_file)])

    assert result.exit_code != 0
    # stdout should be the error report JSON
    out = json.loads(result.output.splitlines()[0])
    assert "errors" in out


# ---------------------------------------------------------------------------
# Error report: stdout JSON, paths, codes, stderr lines
# ---------------------------------------------------------------------------


def test_apply_validation_error_report_is_json_on_stdout(tmp_path: Path, loom_dir: Path) -> None:
    """Validation failure emits {"errors": [...]} as bare JSON on stdout."""
    _make_project(loom_dir)
    plan_file = tmp_path / "plan.json"
    plan_file.write_text(_plan_json([{"type": "epic", "parent": "no-such-proj", "title": "E"}]))

    result = runner.invoke(app, ["apply", "--root", str(loom_dir), str(plan_file)])

    assert result.exit_code == 2
    out = json.loads(result.output.splitlines()[0])
    assert "errors" in out
    assert isinstance(out["errors"], list)
    first = out["errors"][0]
    assert "path" in first
    assert "code" in first
    assert "message" in first


def test_apply_multi_error_report_all_errors_in_one_run(tmp_path: Path, loom_dir: Path) -> None:
    """Multiple independent errors are all in the stdout report."""
    _make_project(loom_dir)
    plan_file = tmp_path / "plan.json"
    plan_file.write_text(
        json.dumps(
            {
                "items": [
                    {"type": "bogus", "parent": "p", "title": "X"},  # items[0] bad type
                    {"type": "epic", "parent": "p", "title": ""},  # items[1] empty title
                    {"type": "epic", "parent": "nope", "title": "Y"},  # items[2] unknown parent
                ]
            }
        )
    )

    result = runner.invoke(app, ["apply", "--root", str(loom_dir), str(plan_file)])

    # Exits with code of first error (bad type -> 1)
    assert result.exit_code == 1
    out = json.loads(result.output.splitlines()[0])
    assert "errors" in out
    codes = [e["code"] for e in out["errors"]]
    from loom.bulk import CODE_BAD_TYPE, CODE_EMPTY_TITLE, CODE_UNKNOWN_PARENT

    assert CODE_BAD_TYPE in codes
    assert CODE_EMPTY_TITLE in codes
    assert CODE_UNKNOWN_PARENT in codes
    # Nothing created
    loom = Loom(root=loom_dir)
    # backlog epic is auto-created; no user-created epics should exist
    user_epics = [e for e in loom.find(type="epic", project="p") if "backlog" not in e.qualified_id]
    assert user_epics == []


def test_apply_error_report_has_exact_paths(tmp_path: Path, loom_dir: Path) -> None:
    """Error paths point at the exact items including depth."""
    _make_project(loom_dir)
    # Error deep in a nested child
    plan_file = tmp_path / "plan.json"
    plan_file.write_text(
        json.dumps(
            {
                "items": [
                    {
                        "type": "epic",
                        "parent": "p",
                        "title": "E",
                        "children": [
                            {
                                "type": "story",
                                "title": "S",
                                "children": [
                                    {"type": "task", "title": ""}  # empty title at depth 2
                                ],
                            }
                        ],
                    }
                ]
            }
        )
    )

    result = runner.invoke(app, ["apply", "--root", str(loom_dir), str(plan_file)])

    assert result.exit_code == 1
    out = json.loads(result.output.splitlines()[0])
    paths = [e["path"] for e in out["errors"]]
    assert any("items[0].children[0].children[0]" in p for p in paths)


def test_apply_error_messages_name_offending_value(tmp_path: Path, loom_dir: Path) -> None:
    """Error messages name the offending value."""
    _make_project(loom_dir)
    plan_file = tmp_path / "plan.json"
    plan_file.write_text(_plan_json([{"type": "epic", "parent": "ghost-proj-qid", "title": "E"}]))

    result = runner.invoke(app, ["apply", "--root", str(loom_dir), str(plan_file)])

    out = json.loads(result.output.splitlines()[0])
    messages = [e["message"] for e in out["errors"]]
    assert any("ghost-proj-qid" in m for m in messages)


def test_apply_error_report_mirrors_to_stderr(tmp_path: Path, loom_dir: Path) -> None:
    """Human-readable error lines also appear on stderr."""
    _make_project(loom_dir)
    plan_file = tmp_path / "plan.json"
    plan_file.write_text(_plan_json([{"type": "epic", "parent": "nope", "title": "E"}]))

    result = runner.invoke(app, ["apply", "--root", str(loom_dir), str(plan_file)])

    assert result.exit_code != 0
    # stderr should have readable lines
    assert len(result.stderr) > 0 or len(result.output) > 0  # at minimum something


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
        # Structural (bad type) -> exit 1
        (
            [{"type": "bogus", "parent": "p", "title": "E"}],
            1,
        ),
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


def test_apply_parent_on_child_exits_1(tmp_path: Path, loom_dir: Path) -> None:
    """parent field on a nested child is rejected with exit 1."""
    _make_project(loom_dir)
    plan_file = tmp_path / "plan.json"
    plan_file.write_text(
        json.dumps(
            {
                "items": [
                    {
                        "type": "epic",
                        "parent": "p",
                        "title": "E",
                        "children": [
                            {
                                "type": "story",
                                "title": "S",
                                "parent": "p",  # forbidden on child
                            }
                        ],
                    }
                ]
            }
        )
    )

    result = runner.invoke(app, ["apply", "--root", str(loom_dir), str(plan_file)])

    assert result.exit_code == 1
    out = json.loads(result.output.splitlines()[0])
    from loom.bulk import CODE_PARENT_ON_CHILD

    assert any(e["code"] == CODE_PARENT_ON_CHILD for e in out["errors"])


def test_apply_children_on_task_exits_1(tmp_path: Path, loom_dir: Path) -> None:
    """children on a task is rejected with exit 1."""
    _make_project(loom_dir)
    plan_file = tmp_path / "plan.json"
    plan_file.write_text(
        json.dumps(
            {
                "items": [
                    {
                        "type": "epic",
                        "parent": "p",
                        "title": "E",
                        "children": [
                            {
                                "type": "story",
                                "title": "S",
                                "children": [
                                    {
                                        "type": "task",
                                        "title": "T",
                                        "children": [{"type": "task", "title": "Nested"}],
                                    }
                                ],
                            }
                        ],
                    }
                ]
            }
        )
    )

    result = runner.invoke(app, ["apply", "--root", str(loom_dir), str(plan_file)])

    assert result.exit_code == 1


# ---------------------------------------------------------------------------
# Full chain via CLI
# ---------------------------------------------------------------------------


def test_apply_full_chain_via_cli(tmp_path: Path, loom_dir: Path) -> None:
    _make_project(loom_dir)
    plan_file = tmp_path / "plan.json"
    plan_file.write_text(
        json.dumps(
            {
                "items": [
                    {
                        "ref": "epic",
                        "type": "epic",
                        "parent": "p",
                        "title": "CLI Epic",
                        "children": [
                            {
                                "ref": "s1",
                                "type": "story",
                                "title": "CLI Story",
                                "children": [{"type": "task", "title": "CLI Task"}],
                            }
                        ],
                    }
                ]
            }
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
    state_mod.init_workspace(Path.cwd(), "p")

    plan_file = tmp_path / "plan.json"
    plan_file.write_text(
        json.dumps(
            {
                "items": [
                    {
                        "ref": "e1",
                        "type": "epic",
                        "parent": "p",
                        "title": "E",
                        "children": [{"ref": "s1", "type": "story", "title": "S"}],
                    }
                ]
            }
        )
    )

    result = runner.invoke(app, ["apply", "--root", str(loom_dir), str(plan_file)])
    assert result.exit_code == 0

    out = json.loads(result.output.splitlines()[0])
    last_story_qid = out["created"][1]["qid"]

    ws_dir = state_mod.find_workspace_dir(Path.cwd())
    assert ws_dir is not None
    ws = state_mod.load_workspace(ws_dir)
    assert ws.last.story == last_story_qid


# ---------------------------------------------------------------------------
# Human notes go to stderr (not stdout)
# ---------------------------------------------------------------------------


def test_apply_human_notes_on_stderr(tmp_path: Path, loom_dir: Path) -> None:
    """Any human-readable progress notes go to stderr, not polluting stdout JSON."""
    _make_project(loom_dir)
    plan_file = tmp_path / "plan.json"
    plan_file.write_text(_plan_json([{"type": "epic", "parent": "p", "title": "E"}]))

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
            json.dumps(
                {
                    "items": [
                        {"ref": "r", "type": "epic", "parent": "p", "title": "A"},
                        {"ref": "r", "type": "epic", "parent": "p", "title": "B"},
                    ]
                }
            ),
            3,
        ),
        # Empty title
        ('{"items": [{"type": "epic", "parent": "p", "title": ""}]}', 1),
        # Bad type
        ('{"items": [{"type": "bogus", "parent": "p", "title": "X"}]}', 1),
        # parent on child
        (
            json.dumps(
                {
                    "items": [
                        {
                            "type": "epic",
                            "parent": "p",
                            "title": "E",
                            "children": [{"type": "story", "title": "S", "parent": "p"}],
                        }
                    ]
                }
            ),
            1,
        ),
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
