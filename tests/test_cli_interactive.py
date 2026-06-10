"""Interactive-mode CLI tests.

The TTY guard at :func:`loom.prompts.is_interactive` is monkeypatched to
True; the underlying ``pick_one`` / ``prompt_editor_*`` callables are
injected with fakes so tests stay deterministic and don't shell out.
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

import pytest
from typer.testing import CliRunner

from loom import prompts
from loom.cli import app

runner = CliRunner()


@pytest.fixture
def force_tty(monkeypatch: pytest.MonkeyPatch) -> None:
    """Make :func:`prompts.is_interactive` return True under CliRunner.

    CliRunner reassigns sys.stdin during ``invoke``, so patching isatty
    on the live stdin doesn't survive. Patching ``is_interactive`` is
    the only stable seam.
    """
    monkeypatch.setattr(prompts, "is_interactive", lambda non_interactive: not non_interactive)


def _fake_picker(answers: list[str]) -> Callable[..., str]:
    """Return a pick_one stub that yields *answers* in order."""
    it = iter(answers)

    def _pick(_cands, *, prompt, preselect, non_interactive):  # type: ignore[no-untyped-def]
        return next(it)

    return _pick


def _fake_editor_template(title: str, body: str = "body text") -> Callable[..., dict]:
    def _template(_text, *, non_interactive):  # type: ignore[no-untyped-def]
        return {"title": title, "body": body, "frontmatter": {"title": title}}

    return _template


def _create_project(loom_dir: Path) -> None:
    r = runner.invoke(
        app,
        [
            "project",
            "create",
            "acme",
            "--title",
            "Acme",
            "--repo",
            "https://example/acme",
            "--root",
            str(loom_dir),
        ],
    )
    assert r.exit_code == 0, r.output


# ---------------------------------------------------------------------------
# epic / story / task create — parent picker
# ---------------------------------------------------------------------------


def test_epic_create_picks_project(
    loom_dir: Path, force_tty: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    _create_project(loom_dir)
    monkeypatch.setattr(prompts, "pick_one", _fake_picker(["acme"]))
    r = runner.invoke(
        app,
        ["epic", "create", "--title", "Picked", "--root", str(loom_dir)],
    )
    assert r.exit_code == 0, r.output
    assert r.stdout.strip().startswith("acme:")


def test_epic_create_opens_editor_when_title_and_body_blank(
    loom_dir: Path, force_tty: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    _create_project(loom_dir)
    monkeypatch.setattr(prompts, "pick_one", _fake_picker(["acme"]))
    monkeypatch.setattr(prompts, "prompt_editor_template", _fake_editor_template("From Editor"))
    r = runner.invoke(app, ["epic", "create", "--root", str(loom_dir)])
    assert r.exit_code == 0, r.output
    qid = r.stdout.strip()
    show = runner.invoke(app, ["show", qid, "--root", str(loom_dir)])
    assert "title: From Editor" in show.output


def test_story_create_picks_epic(
    loom_dir: Path, force_tty: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    _create_project(loom_dir)
    r = runner.invoke(app, ["epic", "create", "acme", "--title", "E", "--root", str(loom_dir)])
    epic_qid = r.stdout.strip()

    monkeypatch.setattr(prompts, "pick_one", _fake_picker([epic_qid]))
    r = runner.invoke(app, ["story", "create", "--title", "S", "--root", str(loom_dir)])
    assert r.exit_code == 0, r.output
    assert r.stdout.strip().startswith(epic_qid + ":")


# ---------------------------------------------------------------------------
# update — qid/field/value
# ---------------------------------------------------------------------------


def _make_chain(loom_dir: Path) -> tuple[str, str, str, str]:
    _create_project(loom_dir)
    r = runner.invoke(app, ["epic", "create", "acme", "--title", "E", "--root", str(loom_dir)])
    epic = r.stdout.strip()
    r = runner.invoke(app, ["story", "create", epic, "--title", "S", "--root", str(loom_dir)])
    story = r.stdout.strip()
    r = runner.invoke(app, ["task", "create", story, "--title", "T", "--root", str(loom_dir)])
    task = r.stdout.strip()
    return "acme", epic, story, task


def test_update_picks_qid_and_field_then_prompts_value(
    loom_dir: Path,
    force_tty: None,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _, _, _, task = _make_chain(loom_dir)
    monkeypatch.setattr(prompts, "pick_one", _fake_picker([task, "assignee"]))
    monkeypatch.setattr("typer.prompt", lambda *_a, **_kw: "alice")
    r = runner.invoke(app, ["update", "--root", str(loom_dir)])
    assert r.exit_code == 0, r.output
    show = runner.invoke(app, ["show", task, "--root", str(loom_dir)])
    assert "assignee: alice" in show.output


def test_update_title_with_no_value_opens_existing_file(
    loom_dir: Path,
    force_tty: None,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _, _, _, task = _make_chain(loom_dir)

    captured: dict[str, Path] = {}

    def fake_editor_file(path, *, non_interactive):  # type: ignore[no-untyped-def]
        captured["path"] = path
        # Simulate user replacing the title in the existing file.
        text = path.read_text(encoding="utf-8")
        path.write_text(text.replace("title: T", "title: Renamed"), encoding="utf-8")

    monkeypatch.setattr(prompts, "prompt_editor_file", fake_editor_file)
    r = runner.invoke(app, ["update", task, "title", "--root", str(loom_dir)])
    assert r.exit_code == 0, r.output
    assert captured["path"].name == f"{task.split(':')[-1]}.md"
    show = runner.invoke(app, ["show", task, "--root", str(loom_dir)])
    assert "title: Renamed" in show.output


# ---------------------------------------------------------------------------
# dep add — both source and target picker
# ---------------------------------------------------------------------------


def test_dep_add_prompts_for_source_and_target(
    loom_dir: Path,
    force_tty: None,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _, _, _, task = _make_chain(loom_dir)
    # Add a second task under the same story to depend on
    story_qid = task.rsplit(":", 1)[0]
    r = runner.invoke(
        app,
        ["task", "create", story_qid, "--title", "T2", "--root", str(loom_dir)],
    )
    assert r.exit_code == 0, r.output
    task2 = r.stdout.strip()

    monkeypatch.setattr(prompts, "pick_one", _fake_picker([task, task2]))
    r = runner.invoke(app, ["dep", "add", "--root", str(loom_dir)])
    assert r.exit_code == 0, r.output
    assert f"{task} -> {task2}" in r.output


# ---------------------------------------------------------------------------
# tag add — comma-separated prompt
# ---------------------------------------------------------------------------


def test_tag_add_prompts_when_omitted(
    loom_dir: Path,
    force_tty: None,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _, _, _, task = _make_chain(loom_dir)
    monkeypatch.setattr(prompts, "pick_one", _fake_picker([task]))
    monkeypatch.setattr("typer.prompt", lambda *_a, **_kw: "auth, security")
    r = runner.invoke(app, ["tag", "add", "--root", str(loom_dir)])
    assert r.exit_code == 0, r.output
    assert "auth" in r.output and "security" in r.output


# ---------------------------------------------------------------------------
# Non-interactive guard
# ---------------------------------------------------------------------------


def test_non_interactive_flag_blocks_prompts(loom_dir: Path, force_tty: None) -> None:
    """`-y` must short-circuit any picker. ``update`` with no QID always picks."""
    _create_project(loom_dir)
    r = runner.invoke(app, ["-y", "update", "--root", str(loom_dir)])
    assert r.exit_code != 0
    assert "required" in r.output.lower() or "missing" in r.output.lower()


def test_no_tty_blocks_prompts(loom_dir: Path) -> None:
    """Default CliRunner stdin is not a TTY → picker raises."""
    _create_project(loom_dir)
    r = runner.invoke(app, ["update", "--root", str(loom_dir)])
    assert r.exit_code != 0
