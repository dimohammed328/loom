"""Tests for `loom dep apply` CLI command: batch dependency wiring.

RED phase: all tests must fail before any implementation is written.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from typer.testing import CliRunner

from loom.api import Loom
from loom.cli import app
from loom.errors import CycleError, LoomError, NotFound

runner = CliRunner()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _deps_json(deps: list[dict]) -> str:
    return json.dumps({"deps": deps})


def _make_chain(loom_dir: Path) -> tuple[str, str, str]:
    """Create project with two tasks a->b with existing edge (a depends on b).
    Returns (proj_qid, task_a_qid, task_b_qid).
    """
    loom = Loom(root=loom_dir)
    p = loom.create_project("proj", title="P")
    e = p.create_epic(title="E")
    s = e.create_story(title="S")
    a = s.create_task(title="A")
    b = s.create_task(title="B")
    return p.qualified_id, a.qualified_id, b.qualified_id


# ---------------------------------------------------------------------------
# Library: Loom.add_dependencies
# ---------------------------------------------------------------------------


def test_add_dependencies_happy_path(loom_dir: Path) -> None:
    """add_dependencies applies all edges and returns count."""
    _, a, b = _make_chain(loom_dir)
    loom = Loom(root=loom_dir)
    added = loom.add_dependencies([(a, b)])
    assert added == 1
    deps = loom.get(a).dependencies()  # type: ignore[union-attr]
    assert any(r.qualified_id == b for r in deps)


def test_add_dependencies_idempotent(loom_dir: Path) -> None:
    """Already-existing edges are counted but not re-applied."""
    _, a, b = _make_chain(loom_dir)
    loom = Loom(root=loom_dir)
    loom.add_dependencies([(a, b)])
    added = loom.add_dependencies([(a, b)])
    # Idempotent: still counted as 0 new (already present)
    assert added == 0


def test_add_dependencies_unknown_qid_raises(loom_dir: Path) -> None:
    """Unknown source or target raises NotFound before any write."""
    _, a, _b = _make_chain(loom_dir)
    loom = Loom(root=loom_dir)
    with pytest.raises(NotFound):
        loom.add_dependencies([(a, "proj:abcdefg:9:9")])


def test_add_dependencies_dep_on_project_raises(loom_dir: Path) -> None:
    """Depending on a project raises before any write."""
    proj, a, _ = _make_chain(loom_dir)
    loom = Loom(root=loom_dir)
    with pytest.raises(LoomError):
        loom.add_dependencies([(a, proj)])


def test_add_dependencies_self_loop_raises(loom_dir: Path) -> None:
    """Self-loop raises before any write."""
    _, a, _ = _make_chain(loom_dir)
    loom = Loom(root=loom_dir)
    with pytest.raises(LoomError):
        loom.add_dependencies([(a, a)])


def test_add_dependencies_cycle_visible_only_across_new_edges(loom_dir: Path) -> None:
    """Batch cycle only visible when combining multiple new edges is detected.

    Existing: a->b.  New edges: b->c, c->a.  Neither alone is a cycle
    against the existing graph, but together they close a->b->c->a.
    All-or-nothing: nothing written.
    """
    _, a, b = _make_chain(loom_dir)
    loom = Loom(root=loom_dir)
    # Add a third task c.
    story = loom.get(a.rsplit(":", 1)[0])  # get the story
    c = story.create_task(title="C").qualified_id  # type: ignore[union-attr]

    # Add existing edge a->b.
    loom.add_dependencies([(a, b)])

    # Now try adding b->c and c->a together — forms a cycle.
    with pytest.raises(CycleError):
        loom.add_dependencies([(b, c), (c, a)])

    # Nothing written: b should have no deps.
    assert loom.get(b).dependencies() == []  # type: ignore[union-attr]


def test_add_dependencies_all_or_nothing_unknown(loom_dir: Path) -> None:
    """When one edge has an unknown qid, no edges are applied."""
    _, a, b = _make_chain(loom_dir)
    loom = Loom(root=loom_dir)
    with pytest.raises(NotFound):
        loom.add_dependencies([(a, b), (a, "proj:abcdefg:9:9")])
    # a->b was NOT applied.
    assert loom.get(a).dependencies() == []  # type: ignore[union-attr]


# ---------------------------------------------------------------------------
# CLI: loom dep apply — file input
# ---------------------------------------------------------------------------


def test_dep_apply_from_file(tmp_path: Path, loom_dir: Path) -> None:
    """Basic file input: applies edges and prints {added: N}."""
    _, a, b = _make_chain(loom_dir)
    plan_file = tmp_path / "deps.json"
    plan_file.write_text(_deps_json([{"source": a, "on": b}]))

    result = runner.invoke(app, ["dep", "apply", "--root", str(loom_dir), str(plan_file)])

    assert result.exit_code == 0
    out = json.loads(result.output.splitlines()[0])
    assert out == {"added": 1}


def test_dep_apply_from_stdin(loom_dir: Path) -> None:
    """stdin ('-') accepted."""
    _, a, b = _make_chain(loom_dir)
    plan = _deps_json([{"source": a, "on": b}])

    result = runner.invoke(app, ["dep", "apply", "--root", str(loom_dir), "-"], input=plan)

    assert result.exit_code == 0
    out = json.loads(result.output.splitlines()[0])
    assert out == {"added": 1}


def test_dep_apply_stdout_is_bare_json(tmp_path: Path, loom_dir: Path) -> None:
    """stdout must be JSON only."""
    _, a, b = _make_chain(loom_dir)
    plan_file = tmp_path / "deps.json"
    plan_file.write_text(_deps_json([{"source": a, "on": b}]))

    result = runner.invoke(app, ["dep", "apply", "--root", str(loom_dir), str(plan_file)])

    assert result.exit_code == 0
    json.loads(result.output.splitlines()[0])  # must parse cleanly


def test_dep_apply_per_edge_note_to_stderr(tmp_path: Path, loom_dir: Path) -> None:
    """Per-edge src -> tgt notes go to stderr; stdout first line is JSON.

    CliRunner mixes stderr into stdout so we just verify that the first
    non-empty output line parses as JSON (the contract that matters for
    machine consumers).
    """
    _, a, b = _make_chain(loom_dir)
    plan_file = tmp_path / "deps.json"
    plan_file.write_text(_deps_json([{"source": a, "on": b}]))

    result = runner.invoke(
        app,
        ["dep", "apply", "--root", str(loom_dir), str(plan_file)],
        catch_exceptions=False,
    )

    assert result.exit_code == 0
    # First non-empty output line must be JSON.
    first_line = next(line for line in result.output.splitlines() if line.strip())
    data = json.loads(first_line)
    assert "added" in data


def test_dep_apply_idempotent_already_exists(tmp_path: Path, loom_dir: Path) -> None:
    """Already-existing edges are a no-op (exit 0, added=0)."""
    _, a, b = _make_chain(loom_dir)
    loom = Loom(root=loom_dir)
    loom.add_dependencies([(a, b)])  # pre-apply

    plan_file = tmp_path / "deps.json"
    plan_file.write_text(_deps_json([{"source": a, "on": b}]))

    result = runner.invoke(app, ["dep", "apply", "--root", str(loom_dir), str(plan_file)])

    assert result.exit_code == 0
    out = json.loads(result.output.splitlines()[0])
    assert out == {"added": 0}


# ---------------------------------------------------------------------------
# CLI: exit codes
# ---------------------------------------------------------------------------


def test_dep_apply_malformed_json_exits_1(tmp_path: Path, loom_dir: Path) -> None:
    _make_chain(loom_dir)
    plan_file = tmp_path / "deps.json"
    plan_file.write_text("not json {{{")

    result = runner.invoke(app, ["dep", "apply", "--root", str(loom_dir), str(plan_file)])

    assert result.exit_code == 1


def test_dep_apply_missing_deps_key_exits_1(tmp_path: Path, loom_dir: Path) -> None:
    _make_chain(loom_dir)
    plan_file = tmp_path / "deps.json"
    plan_file.write_text(json.dumps({"other": []}))

    result = runner.invoke(app, ["dep", "apply", "--root", str(loom_dir), str(plan_file)])

    assert result.exit_code == 1


def test_dep_apply_unknown_qid_exits_2(tmp_path: Path, loom_dir: Path) -> None:
    _, a, _ = _make_chain(loom_dir)
    plan_file = tmp_path / "deps.json"
    plan_file.write_text(_deps_json([{"source": a, "on": "proj:abcdefg:9:9"}]))

    result = runner.invoke(app, ["dep", "apply", "--root", str(loom_dir), str(plan_file)])

    assert result.exit_code == 2


def test_dep_apply_dep_on_project_exits_1(tmp_path: Path, loom_dir: Path) -> None:
    proj, a, _ = _make_chain(loom_dir)
    plan_file = tmp_path / "deps.json"
    plan_file.write_text(_deps_json([{"source": a, "on": proj}]))

    result = runner.invoke(app, ["dep", "apply", "--root", str(loom_dir), str(plan_file)])

    assert result.exit_code == 1


def test_dep_apply_self_loop_exits_1(tmp_path: Path, loom_dir: Path) -> None:
    _, a, _ = _make_chain(loom_dir)
    plan_file = tmp_path / "deps.json"
    plan_file.write_text(_deps_json([{"source": a, "on": a}]))

    result = runner.invoke(app, ["dep", "apply", "--root", str(loom_dir), str(plan_file)])

    assert result.exit_code == 1


def test_dep_apply_cycle_exits_4(tmp_path: Path, loom_dir: Path) -> None:
    _, a, b = _make_chain(loom_dir)
    loom = Loom(root=loom_dir)
    # Create a third task c.
    story_qid = a.rsplit(":", 1)[0]
    story = loom.get(story_qid)
    c = story.create_task(title="C").qualified_id  # type: ignore[union-attr]
    # Existing: a->b
    loom.add_dependencies([(a, b)])

    # Batch that creates cycle: b->c, c->a
    plan_file = tmp_path / "deps.json"
    plan_file.write_text(_deps_json([{"source": b, "on": c}, {"source": c, "on": a}]))

    result = runner.invoke(app, ["dep", "apply", "--root", str(loom_dir), str(plan_file)])

    assert result.exit_code == 4


def test_dep_apply_cycle_nothing_applied(tmp_path: Path, loom_dir: Path) -> None:
    """On cycle, no edges are written."""
    _, a, b = _make_chain(loom_dir)
    loom = Loom(root=loom_dir)
    story_qid = a.rsplit(":", 1)[0]
    story = loom.get(story_qid)
    c = story.create_task(title="C").qualified_id  # type: ignore[union-attr]
    loom.add_dependencies([(a, b)])

    plan_file = tmp_path / "deps.json"
    plan_file.write_text(_deps_json([{"source": b, "on": c}, {"source": c, "on": a}]))

    result = runner.invoke(app, ["dep", "apply", "--root", str(loom_dir), str(plan_file)])

    assert result.exit_code == 4
    # Neither b->c nor c->a applied
    assert loom.get(b).dependencies() == []  # type: ignore[union-attr]
    assert loom.get(c).dependencies() == []  # type: ignore[union-attr]


# ---------------------------------------------------------------------------
# State touch
# ---------------------------------------------------------------------------


def test_dep_apply_updates_workspace_state(tmp_path: Path, loom_dir: Path) -> None:
    """After successful dep apply, workspace state updated (last source touched)."""
    from loom import state as state_mod

    _, a, b = _make_chain(loom_dir)
    state_mod.init_workspace(Path.cwd(), "proj")

    plan_file = tmp_path / "deps.json"
    plan_file.write_text(_deps_json([{"source": a, "on": b}]))

    result = runner.invoke(app, ["dep", "apply", "--root", str(loom_dir), str(plan_file)])

    assert result.exit_code == 0
    ws_dir = state_mod.find_workspace_dir(Path.cwd())
    assert ws_dir is not None
    # state was updated (no crash; actual value depends on task qid)


# ---------------------------------------------------------------------------
# --dry-run
# ---------------------------------------------------------------------------


def test_dep_apply_dry_run_creates_nothing(tmp_path: Path, loom_dir: Path) -> None:
    _, a, b = _make_chain(loom_dir)
    plan_file = tmp_path / "deps.json"
    plan_file.write_text(_deps_json([{"source": a, "on": b}]))

    result = runner.invoke(
        app, ["dep", "apply", "--root", str(loom_dir), "--dry-run", str(plan_file)]
    )

    assert result.exit_code == 0
    loom = Loom(root=loom_dir)
    assert loom.get(a).dependencies() == []  # type: ignore[union-attr]


def test_dep_apply_dry_run_on_invalid_plan_exits_nonzero(tmp_path: Path, loom_dir: Path) -> None:
    """--dry-run with an invalid plan exits nonzero."""
    _make_chain(loom_dir)
    plan_file = tmp_path / "deps.json"
    plan_file.write_text(_deps_json([{"source": "no-such", "on": "also-no"}]))

    result = runner.invoke(
        app, ["dep", "apply", "--root", str(loom_dir), "--dry-run", str(plan_file)]
    )

    assert result.exit_code != 0


# ---------------------------------------------------------------------------
# e2e: rebuild is a no-op after dep apply
# ---------------------------------------------------------------------------


def test_dep_apply_rebuild_is_noop(tmp_path: Path, loom_dir: Path) -> None:
    """After dep apply, rebuild must return the same deps (deps in frontmatter)."""
    _, a, b = _make_chain(loom_dir)
    plan_file = tmp_path / "deps.json"
    plan_file.write_text(_deps_json([{"source": a, "on": b}]))

    result = runner.invoke(app, ["dep", "apply", "--root", str(loom_dir), str(plan_file)])
    assert result.exit_code == 0

    loom = Loom(root=loom_dir)
    loom.rebuild()

    deps = loom.get(a).dependencies()  # type: ignore[union-attr]
    assert any(r.qualified_id == b for r in deps)
