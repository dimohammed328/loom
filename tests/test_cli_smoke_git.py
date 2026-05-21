"""End-to-end smoke for `loom project create`'s git-probe.

Uses a real `git init` in a tmp dir (not mocked) to exercise the
:mod:`loom.gitprobe` wrappers and the CLI integration.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest
from typer.testing import CliRunner

from loom.cli import app

runner = CliRunner()


pytestmark = pytest.mark.skipif(
    shutil.which("git") is None,
    reason="git not on PATH",
)


def _init_repo(path: Path, *, origin: str | None) -> None:
    subprocess.run(["git", "init", "-q", str(path)], check=True)
    subprocess.run(
        ["git", "-C", str(path), "config", "user.email", "test@example.com"],
        check=True,
    )
    subprocess.run(
        ["git", "-C", str(path), "config", "user.name", "Test"],
        check=True,
    )
    if origin is not None:
        subprocess.run(
            ["git", "-C", str(path), "remote", "add", "origin", origin],
            check=True,
        )


def test_project_create_discovers_repo_from_cwd(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    work = tmp_path / "work"
    work.mkdir()
    _init_repo(work, origin="https://github.com/acme/widget.git")

    loom_dir = tmp_path / "loom"
    subprocess.run(  # explicit init to keep CliRunner simple
        ["uv", "run", "loom", "init", "--root", str(loom_dir)],
        cwd=str(work),
        check=True,
    )
    monkeypatch.chdir(work)
    r = runner.invoke(app, ["project", "create", "acme", "--root", str(loom_dir)])
    assert r.exit_code == 0, r.output

    r = runner.invoke(app, ["project", "list", "--json", "--root", str(loom_dir)])
    payload = json.loads(r.output)
    assert payload[0]["qualified_id"] == "acme"
    assert payload[0]["repo"] == "https://github.com/acme/widget.git"


def test_project_create_explicit_repo_skips_probe(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An explicit --repo bypasses the cwd probe (and works outside a git tree)."""
    loom_dir = tmp_path / "loom"
    subprocess.run(
        ["uv", "run", "loom", "init", "--root", str(loom_dir)],
        check=True,
    )
    # cwd is plain tmp_path — NOT a git repo
    monkeypatch.chdir(tmp_path)
    r = runner.invoke(
        app,
        [
            "project",
            "create",
            "acme",
            "--repo",
            "ssh://example.com/foo.git",
            "--root",
            str(loom_dir),
        ],
    )
    assert r.exit_code == 0, r.output


def test_project_create_fails_outside_git_when_no_repo_flag(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    loom_dir = tmp_path / "loom"
    subprocess.run(
        ["uv", "run", "loom", "init", "--root", str(loom_dir)],
        check=True,
    )
    monkeypatch.chdir(tmp_path)
    r = runner.invoke(app, ["project", "create", "acme", "--root", str(loom_dir)])
    assert r.exit_code != 0
    assert "git" in r.output.lower()


def test_project_create_fails_in_git_repo_without_origin(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    work = tmp_path / "work"
    work.mkdir()
    _init_repo(work, origin=None)
    loom_dir = tmp_path / "loom"
    subprocess.run(
        ["uv", "run", "loom", "init", "--root", str(loom_dir)],
        cwd=str(work),
        check=True,
    )
    monkeypatch.chdir(work)
    r = runner.invoke(app, ["project", "create", "acme", "--root", str(loom_dir)])
    assert r.exit_code != 0
    assert "origin" in r.output.lower() or "remote" in r.output.lower()
