"""Tests for the interactive prompt helpers."""

from __future__ import annotations

from pathlib import Path

import pytest

from loom import prompts
from loom.errors import LoomError


@pytest.fixture
def interactive(monkeypatch: pytest.MonkeyPatch) -> None:
    """Force is_interactive() True regardless of the test runner's stdin."""
    monkeypatch.setattr(prompts.sys.stdin, "isatty", lambda: True, raising=False)


def _cands() -> list[prompts.Candidate]:
    return [
        prompts.Candidate(qid="alpha", type="project", title="Alpha", status=None),
        prompts.Candidate(qid="bravo", type="project", title="Bravo", status=None),
        prompts.Candidate(qid="charlie", type="project", title="Charlie", status=None),
    ]


# ---------------------------------------------------------------------------
# is_interactive
# ---------------------------------------------------------------------------


def test_is_interactive_false_when_non_interactive_flag() -> None:
    assert prompts.is_interactive(non_interactive=True) is False


def test_is_interactive_false_when_no_tty(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(prompts.sys.stdin, "isatty", lambda: False, raising=False)
    assert prompts.is_interactive(non_interactive=False) is False


def test_is_interactive_true_when_tty_and_no_flag(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(prompts.sys.stdin, "isatty", lambda: True, raising=False)
    assert prompts.is_interactive(non_interactive=False) is True


# ---------------------------------------------------------------------------
# pick_one — error paths
# ---------------------------------------------------------------------------


def test_pick_one_empty_raises() -> None:
    with pytest.raises(LoomError, match="nothing to choose"):
        prompts.pick_one([], prompt="project", preselect=None, non_interactive=True)


def test_pick_one_non_interactive_raises() -> None:
    with pytest.raises(LoomError, match="required"):
        prompts.pick_one(_cands(), prompt="project", preselect=None, non_interactive=True)


def test_pick_one_no_tty_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(prompts.sys.stdin, "isatty", lambda: False, raising=False)
    with pytest.raises(LoomError, match="required"):
        prompts.pick_one(_cands(), prompt="project", preselect=None, non_interactive=False)


# ---------------------------------------------------------------------------
# pick_one — fallback path (no fzf)
# ---------------------------------------------------------------------------


def test_pick_one_fallback_picks_by_number(
    interactive: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(prompts.shutil, "which", lambda _: None)
    monkeypatch.setattr("builtins.input", lambda _prompt: "2")
    chosen = prompts.pick_one(_cands(), prompt="project", preselect=None, non_interactive=False)
    assert chosen == "bravo"


def test_pick_one_fallback_default_on_empty_input(
    interactive: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(prompts.shutil, "which", lambda _: None)
    monkeypatch.setattr("builtins.input", lambda _prompt: "")
    chosen = prompts.pick_one(
        _cands(), prompt="project", preselect="charlie", non_interactive=False
    )
    assert chosen == "charlie"


def test_pick_one_fallback_cancel(interactive: None, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(prompts.shutil, "which", lambda _: None)
    monkeypatch.setattr("builtins.input", lambda _prompt: "q")
    with pytest.raises(LoomError, match="cancelled"):
        prompts.pick_one(_cands(), prompt="project", preselect=None, non_interactive=False)


def test_pick_one_fallback_invalid_then_valid(
    interactive: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(prompts.shutil, "which", lambda _: None)
    inputs = iter(["nope", "99", "1"])
    monkeypatch.setattr("builtins.input", lambda _prompt: next(inputs))
    chosen = prompts.pick_one(_cands(), prompt="project", preselect=None, non_interactive=False)
    assert chosen == "alpha"


def test_pick_one_fallback_too_many_invalid_raises(
    interactive: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(prompts.shutil, "which", lambda _: None)
    monkeypatch.setattr("builtins.input", lambda _prompt: "nope")
    with pytest.raises(LoomError, match="3 invalid attempts"):
        prompts.pick_one(_cands(), prompt="project", preselect=None, non_interactive=False)


# ---------------------------------------------------------------------------
# pick_one — fzf path (stubbed)
# ---------------------------------------------------------------------------


def test_pick_one_fzf_path(interactive: None, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(prompts.shutil, "which", lambda _: "/usr/bin/fzf")

    class _FakePopen:
        def __init__(self, args, **_kw):
            self.args = args
            self.returncode = 0

        def communicate(self, payload: str) -> tuple[str, str]:
            assert "alpha\tproject" in payload
            assert "bravo\tproject" in payload
            return ("bravo\tproject\tBravo\t\n", "")

    monkeypatch.setattr(prompts.subprocess, "Popen", _FakePopen)
    chosen = prompts.pick_one(_cands(), prompt="project", preselect=None, non_interactive=False)
    assert chosen == "bravo"


def test_pick_one_fzf_cancel(interactive: None, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(prompts.shutil, "which", lambda _: "/usr/bin/fzf")

    class _FakePopen:
        def __init__(self, *_a, **_kw):
            self.returncode = 130

        def communicate(self, _payload: str) -> tuple[str, str]:
            return ("", "")

    monkeypatch.setattr(prompts.subprocess, "Popen", _FakePopen)
    with pytest.raises(LoomError, match="cancelled"):
        prompts.pick_one(_cands(), prompt="project", preselect=None, non_interactive=False)


# ---------------------------------------------------------------------------
# Editor helpers
# ---------------------------------------------------------------------------


def test_prompt_editor_template_round_trip(
    interactive: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    captured: dict[str, Path] = {}

    def fake_launch_editor(path: Path) -> int:
        captured["path"] = path
        path.write_text(
            "---\ntitle: My Story\n---\n# body\nLine one.\n",
            encoding="utf-8",
        )
        return 0

    monkeypatch.setattr(prompts, "launch_editor", fake_launch_editor)
    result = prompts.prompt_editor_template(prompts.CREATE_TEMPLATE, non_interactive=False)
    assert result["title"] == "My Story"
    assert "Line one." in result["body"]
    # temp file should have been removed
    assert not captured["path"].exists()


def test_prompt_editor_template_nonzero_raises(
    interactive: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(prompts, "launch_editor", lambda _p: 1)
    with pytest.raises(LoomError, match="editor exited"):
        prompts.prompt_editor_template(prompts.CREATE_TEMPLATE, non_interactive=False)


def test_prompt_editor_template_non_interactive_raises() -> None:
    with pytest.raises(LoomError, match="required"):
        prompts.prompt_editor_template(prompts.CREATE_TEMPLATE, non_interactive=True)


def test_prompt_editor_template_blank_title_returns_none(
    interactive: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    def fake(path: Path) -> int:
        path.write_text("---\ntitle:   \n---\nbody\n", encoding="utf-8")
        return 0

    monkeypatch.setattr(prompts, "launch_editor", fake)
    result = prompts.prompt_editor_template("ignored", non_interactive=False)
    assert result["title"] is None


def test_prompt_editor_file_passes_through(
    interactive: None,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    target = tmp_path / "x.md"
    target.write_text("hello\n", encoding="utf-8")
    seen: list[Path] = []

    def fake(path: Path) -> int:
        seen.append(path)
        return 0

    monkeypatch.setattr(prompts, "launch_editor", fake)
    prompts.prompt_editor_file(target, non_interactive=False)
    assert seen == [target]


def test_prompt_editor_file_non_interactive_raises(tmp_path: Path) -> None:
    with pytest.raises(LoomError, match="editor required"):
        prompts.prompt_editor_file(tmp_path / "x.md", non_interactive=True)
