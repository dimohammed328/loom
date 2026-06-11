"""End-to-end workspace tests: `.loom/` binding + last-touched preselect."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from typer.testing import CliRunner

from loom import gitprobe, prompts, state
from loom.cli import app

runner = CliRunner()


@pytest.fixture
def force_tty(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(prompts, "is_interactive", lambda non_interactive: not non_interactive)


@pytest.fixture
def no_git(monkeypatch: pytest.MonkeyPatch) -> None:
    """Force gitprobe to look like 'no git at all'."""
    monkeypatch.setattr(gitprobe, "is_git_repo", lambda _cwd: False)
    monkeypatch.setattr(gitprobe, "discover_remote", lambda _cwd, *, remote="origin": None)
    monkeypatch.setattr(gitprobe, "git_toplevel", lambda _cwd: None)


@pytest.fixture
def fake_git(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """Pretend cwd is the toplevel of a git repo with origin set."""
    monkeypatch.setattr(gitprobe, "is_git_repo", lambda _cwd: True)
    monkeypatch.setattr(
        gitprobe, "discover_remote", lambda _cwd, *, remote="origin": "https://example/acme.git"
    )
    monkeypatch.setattr(gitprobe, "git_toplevel", lambda _cwd: tmp_path)


def _capture_picker() -> tuple[list[dict], object]:
    """Return (calls, callable). The callable returns the first candidate."""
    calls: list[dict] = []

    def _pick(candidates, *, prompt, preselect, non_interactive):  # type: ignore[no-untyped-def]
        calls.append({"prompt": prompt, "preselect": preselect})
        return candidates[0].qid

    return calls, _pick


# ---------------------------------------------------------------------------
# project create writes .loom/
# ---------------------------------------------------------------------------


def test_project_create_writes_workspace(loom_dir: Path, fake_git: None, tmp_path: Path) -> None:
    r = runner.invoke(
        app, ["project", "create", "acme", "--title", "Acme", "--root", str(loom_dir)]
    )
    assert r.exit_code == 0, r.output

    state_file = tmp_path / ".loom" / "state.json"
    assert state_file.exists()
    payload = json.loads(state_file.read_text())
    assert payload["project"] == "acme"

    # gitignore is created so `.loom/` stays out of the user's index.
    assert (tmp_path / ".loom" / ".gitignore").read_text() == "*\n"


def test_project_create_warns_on_rebind(loom_dir: Path, fake_git: None, tmp_path: Path) -> None:
    runner.invoke(app, ["project", "create", "acme", "--title", "Acme", "--root", str(loom_dir)])
    r = runner.invoke(
        app,
        [
            "project",
            "create",
            "blue",
            "--title",
            "Blue",
            "--repo",
            "https://example/blue",
            "--root",
            str(loom_dir),
        ],
    )
    assert r.exit_code == 0
    # The note about rebinding goes to stderr; typer.testing captures it via .output.
    assert "was bound to acme" in r.output
    assert "now bound to blue" in r.output


def test_project_create_without_git_uses_cwd_anchor(
    loom_dir: Path, no_git: None, tmp_path: Path
) -> None:
    """When cwd isn't in git, --repo bypasses the probe; workspace anchors at cwd."""
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
    assert (tmp_path / ".loom" / "state.json").exists()


# ---------------------------------------------------------------------------
# Workspace.project drives epic create
# ---------------------------------------------------------------------------


def test_epic_create_uses_workspace_project_silently(
    loom_dir: Path, force_tty: None, fake_git: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Once a workspace is bound, `loom epic create` does NOT prompt for project."""
    runner.invoke(app, ["project", "create", "acme", "--title", "Acme", "--root", str(loom_dir)])

    calls, fake = _capture_picker()
    monkeypatch.setattr(prompts, "pick_one", fake)
    r = runner.invoke(app, ["epic", "create", "--title", "Auth", "--root", str(loom_dir)])
    assert r.exit_code == 0, r.output
    # The project picker never ran — workspace.project filled it in.
    assert not any(c["prompt"] == "project" for c in calls)
    assert r.stdout.strip().startswith("acme:")


# ---------------------------------------------------------------------------
# Last-touched drives picker preselect
# ---------------------------------------------------------------------------


def test_story_create_preselects_last_epic(
    loom_dir: Path, force_tty: None, fake_git: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    runner.invoke(app, ["project", "create", "acme", "--title", "Acme", "--root", str(loom_dir)])
    r = runner.invoke(app, ["epic", "create", "--title", "E1", "--root", str(loom_dir)])
    epic_qid = r.stdout.strip()

    calls, fake = _capture_picker()
    monkeypatch.setattr(prompts, "pick_one", fake)
    r = runner.invoke(app, ["story", "create", "--title", "S1", "--root", str(loom_dir)])
    assert r.exit_code == 0, r.output
    assert calls
    epic_pick = [c for c in calls if c["prompt"] == "epic"]
    assert epic_pick and epic_pick[0]["preselect"] == epic_qid


def test_show_preselects_deepest_last_touched(
    loom_dir: Path, force_tty: None, fake_git: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    runner.invoke(app, ["project", "create", "acme", "--title", "Acme", "--root", str(loom_dir)])
    r = runner.invoke(app, ["epic", "create", "--title", "E", "--root", str(loom_dir)])
    epic = r.stdout.strip()
    r = runner.invoke(app, ["story", "create", epic, "--title", "S", "--root", str(loom_dir)])
    story = r.stdout.strip()
    r = runner.invoke(app, ["task", "create", story, "--title", "T", "--root", str(loom_dir)])
    task = r.stdout.strip()

    calls, fake = _capture_picker()
    monkeypatch.setattr(prompts, "pick_one", fake)
    r = runner.invoke(app, ["show", "--root", str(loom_dir)])
    assert r.exit_code == 0
    assert calls[0]["preselect"] == task


# ---------------------------------------------------------------------------
# No workspace → no preselect
# ---------------------------------------------------------------------------


def test_no_workspace_no_preselect(
    loom_dir: Path, force_tty: None, no_git: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Outside any workspace, the picker still works but has no preselect."""
    # Create a project directly via library to avoid writing a .loom dir
    from loom import api as api_mod

    loom = api_mod.Loom(root=loom_dir)
    loom.create_project("acme", title="Acme", repo="https://example/acme")

    calls, fake = _capture_picker()
    monkeypatch.setattr(prompts, "pick_one", fake)
    r = runner.invoke(app, ["epic", "create", "--title", "E", "--root", str(loom_dir)])
    assert r.exit_code == 0
    project_pick = [c for c in calls if c["prompt"] == "project"]
    assert project_pick and project_pick[0]["preselect"] is None


# ---------------------------------------------------------------------------
# Workspace state survives across CLI invocations
# ---------------------------------------------------------------------------


def test_workspace_state_round_trips(
    loom_dir: Path, force_tty: None, fake_git: None, tmp_path: Path
) -> None:
    runner.invoke(app, ["project", "create", "acme", "--title", "Acme", "--root", str(loom_dir)])
    runner.invoke(app, ["epic", "create", "--title", "E", "--root", str(loom_dir)])

    ws = state.load_workspace(tmp_path)
    assert ws.project == "acme"
    assert ws.last.epic is not None and ws.last.epic.startswith("acme:")
