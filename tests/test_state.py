"""Tests for the project-local workspace state."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from loom import state

# ---------------------------------------------------------------------------
# Discovery (walk-up)
# ---------------------------------------------------------------------------


def test_find_workspace_dir_returns_none_when_no_dotloom(tmp_path: Path) -> None:
    assert state.find_workspace_dir(tmp_path) is None


def test_find_workspace_dir_finds_cwd(tmp_path: Path) -> None:
    (tmp_path / ".loom").mkdir()
    assert state.find_workspace_dir(tmp_path) == tmp_path.resolve()


def test_find_workspace_dir_walks_up(tmp_path: Path) -> None:
    (tmp_path / ".loom").mkdir()
    deep = tmp_path / "a" / "b" / "c"
    deep.mkdir(parents=True)
    assert state.find_workspace_dir(deep) == tmp_path.resolve()


def test_find_workspace_dir_dotloom_must_be_directory(tmp_path: Path) -> None:
    # A file named .loom should NOT be picked up.
    (tmp_path / ".loom").write_text("oops", encoding="utf-8")
    assert state.find_workspace_dir(tmp_path) is None


# ---------------------------------------------------------------------------
# load_workspace
# ---------------------------------------------------------------------------


def test_load_workspace_missing_file(tmp_path: Path) -> None:
    (tmp_path / ".loom").mkdir()
    ws = state.load_workspace(tmp_path)
    assert ws.project is None
    assert ws.last == state.WorkspaceLast()


def test_load_workspace_corrupt(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    (tmp_path / ".loom").mkdir()
    (tmp_path / ".loom" / "state.json").write_text("not json", encoding="utf-8")
    ws = state.load_workspace(tmp_path)
    assert ws.project is None
    assert "unreadable" in capsys.readouterr().err


def test_load_workspace_wrong_schema(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    (tmp_path / ".loom").mkdir()
    (tmp_path / ".loom" / "state.json").write_text(
        json.dumps({"schema_version": 99, "project": "acme"}), encoding="utf-8"
    )
    ws = state.load_workspace(tmp_path)
    assert ws.project is None
    assert "unexpected schema" in capsys.readouterr().err


# ---------------------------------------------------------------------------
# init_workspace
# ---------------------------------------------------------------------------


def test_init_workspace_creates_directory_and_gitignore(tmp_path: Path) -> None:
    prior = state.init_workspace(tmp_path, "acme")
    assert prior is None
    assert (tmp_path / ".loom").is_dir()
    assert (tmp_path / ".loom" / ".gitignore").read_text() == "*\n"
    ws = state.load_workspace(tmp_path)
    assert ws.project == "acme"


def test_init_workspace_returns_prior_on_rebind(tmp_path: Path) -> None:
    state.init_workspace(tmp_path, "acme")
    prior = state.init_workspace(tmp_path, "blue")
    assert prior is not None
    assert prior.project == "acme"
    ws = state.load_workspace(tmp_path)
    assert ws.project == "blue"


def test_init_workspace_preserves_last_on_rebind(tmp_path: Path) -> None:
    state.init_workspace(tmp_path, "acme")
    state.update_workspace(tmp_path, "acme:abcdefg:5")
    state.init_workspace(tmp_path, "blue")
    ws = state.load_workspace(tmp_path)
    # last entries are intact (they're not project-scoped at write time).
    assert ws.last.epic == "acme:abcdefg"
    assert ws.last.story == "acme:abcdefg:5"


def test_init_workspace_returns_none_when_same_project(tmp_path: Path) -> None:
    state.init_workspace(tmp_path, "acme")
    prior = state.init_workspace(tmp_path, "acme")
    assert prior is None


# ---------------------------------------------------------------------------
# update_workspace
# ---------------------------------------------------------------------------


def test_update_workspace_records_ancestors(tmp_path: Path) -> None:
    state.init_workspace(tmp_path, "acme")
    state.update_workspace(tmp_path, "acme:abcdefg:5:9")
    ws = state.load_workspace(tmp_path)
    assert ws.last.epic == "acme:abcdefg"
    assert ws.last.story == "acme:abcdefg:5"
    assert ws.last.task == "acme:abcdefg:5:9"


def test_update_workspace_clears_inconsistent_deeper_levels(tmp_path: Path) -> None:
    state.init_workspace(tmp_path, "acme")
    state.update_workspace(tmp_path, "acme:abcdefg:5:9")
    # Touch a different epic — story/task no longer descend from it.
    state.update_workspace(tmp_path, "acme:zzzzzzz")
    ws = state.load_workspace(tmp_path)
    assert ws.last.epic == "acme:zzzzzzz"
    assert ws.last.story is None
    assert ws.last.task is None


def test_update_workspace_keeps_consistent_deeper_levels(tmp_path: Path) -> None:
    state.init_workspace(tmp_path, "acme")
    state.update_workspace(tmp_path, "acme:abcdefg:5:9")
    # Touch the epic of the same chain — story/task still descend.
    state.update_workspace(tmp_path, "acme:abcdefg")
    ws = state.load_workspace(tmp_path)
    assert ws.last.story == "acme:abcdefg:5"
    assert ws.last.task == "acme:abcdefg:5:9"


def test_update_workspace_invalid_qid_silently_ignored(tmp_path: Path) -> None:
    state.init_workspace(tmp_path, "acme")
    state.update_workspace(tmp_path, "not a qid!")
    ws = state.load_workspace(tmp_path)
    assert ws.project == "acme"
    assert ws.last == state.WorkspaceLast()


def test_update_workspace_does_not_change_project_binding(tmp_path: Path) -> None:
    state.init_workspace(tmp_path, "acme")
    state.update_workspace(tmp_path, "blue:zzzzzzz")  # qid in a different project
    ws = state.load_workspace(tmp_path)
    assert ws.project == "acme"  # binding unchanged
    assert ws.last.epic == "blue:zzzzzzz"


# ---------------------------------------------------------------------------
# defaults_for + most_specific
# ---------------------------------------------------------------------------


def test_defaults_for_none_returns_empty() -> None:
    assert state.defaults_for(None) == state.Defaults()


def test_defaults_for_consistent_chain(tmp_path: Path) -> None:
    state.init_workspace(tmp_path, "acme")
    state.update_workspace(tmp_path, "acme:abcdefg:5:9")
    d = state.defaults_for(state.load_workspace(tmp_path))
    assert d.project == "acme"
    assert d.epic == "acme:abcdefg"
    assert d.story == "acme:abcdefg:5"
    assert d.task == "acme:abcdefg:5:9"


def test_defaults_for_drops_mismatched_deeper(tmp_path: Path) -> None:
    # Manually craft a workspace with inconsistent last (e.g. via a previous
    # release that didn't enforce consistency).
    (tmp_path / ".loom").mkdir()
    payload = {
        "schema_version": 1,
        "project": "acme",
        "last": {"epic": "blue:zzzzzzz", "story": "acme:abcdefg:5", "task": None},
    }
    (tmp_path / ".loom" / "state.json").write_text(json.dumps(payload), encoding="utf-8")
    d = state.defaults_for(state.load_workspace(tmp_path))
    assert d.project == "acme"
    # epic doesn't descend from project → drop epic and below
    assert d.epic is None
    assert d.story is None


def test_most_specific_picks_deepest() -> None:
    assert state.most_specific(state.Defaults(project="p")) == "p"
    assert state.most_specific(state.Defaults(project="p", epic="p:e")) == "p:e"
    assert (
        state.most_specific(state.Defaults(project="p", epic="p:e", story="p:e:1", task="p:e:1:2"))
        == "p:e:1:2"
    )
    assert state.most_specific(state.Defaults()) is None


# ---------------------------------------------------------------------------
# Atomic write under failure
# ---------------------------------------------------------------------------


def test_init_workspace_atomic_under_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    state.init_workspace(tmp_path, "acme")
    original = (tmp_path / ".loom" / "state.json").read_text()

    import loom.storage as storage_mod

    def _boom(*_a, **_kw):
        raise OSError("boom")

    monkeypatch.setattr(storage_mod.os, "replace", _boom)
    with pytest.raises(OSError):
        state.init_workspace(tmp_path, "blue")

    assert (tmp_path / ".loom" / "state.json").read_text() == original
