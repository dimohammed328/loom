"""Tests for the git probe helpers."""

from __future__ import annotations

import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

from loom import gitprobe


def _fake_run(stdout: str = "", returncode: int = 0):
    def _run(*_a, **_kw):
        return SimpleNamespace(stdout=stdout, stderr="", returncode=returncode)

    return _run


# ---------------------------------------------------------------------------
# is_git_repo
# ---------------------------------------------------------------------------


def test_is_git_repo_true(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(subprocess, "run", _fake_run("true\n", 0))
    assert gitprobe.is_git_repo(tmp_path) is True


def test_is_git_repo_false_returncode(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(subprocess, "run", _fake_run("", 128))
    assert gitprobe.is_git_repo(tmp_path) is False


def test_is_git_repo_handles_missing_git(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    def _raise(*_a, **_kw):
        raise FileNotFoundError("no git")

    monkeypatch.setattr(subprocess, "run", _raise)
    assert gitprobe.is_git_repo(tmp_path) is False


# ---------------------------------------------------------------------------
# discover_remote
# ---------------------------------------------------------------------------


def test_discover_remote_present(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(subprocess, "run", _fake_run("https://github.com/x/y.git\n", 0))
    assert gitprobe.discover_remote(tmp_path) == "https://github.com/x/y.git"


def test_discover_remote_empty_stdout(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(subprocess, "run", _fake_run("", 0))
    assert gitprobe.discover_remote(tmp_path) is None


def test_discover_remote_returncode_nonzero(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(subprocess, "run", _fake_run("", 1))
    assert gitprobe.discover_remote(tmp_path) is None


def test_discover_remote_named_remote(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    captured: dict[str, list[str]] = {}

    def _run(args, *_a, **_kw):
        captured["args"] = args
        return SimpleNamespace(stdout="https://example.org/r.git\n", stderr="", returncode=0)

    monkeypatch.setattr(subprocess, "run", _run)
    gitprobe.discover_remote(tmp_path, remote="upstream")
    assert "remote.upstream.url" in captured["args"]


# ---------------------------------------------------------------------------
# git_toplevel
# ---------------------------------------------------------------------------


def test_git_toplevel_returns_path(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(subprocess, "run", _fake_run("/repo/root\n", 0))
    assert gitprobe.git_toplevel(tmp_path) == Path("/repo/root")


def test_git_toplevel_none_when_not_in_git(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(subprocess, "run", _fake_run("", 128))
    assert gitprobe.git_toplevel(tmp_path) is None


def test_git_toplevel_none_when_git_missing(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    def _raise(*_a, **_kw):
        raise FileNotFoundError("no git")

    monkeypatch.setattr(subprocess, "run", _raise)
    assert gitprobe.git_toplevel(tmp_path) is None
