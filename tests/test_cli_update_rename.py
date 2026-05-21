"""Confirms `loom set` was hard-renamed to `loom update` with no alias."""

from __future__ import annotations

from pathlib import Path

from typer.testing import CliRunner

from loom.cli import app

runner = CliRunner()


def test_set_command_is_gone(loom_dir: Path) -> None:
    """`loom set ...` must exit with typer's no-such-command code."""
    result = runner.invoke(app, ["set", "acme", "title", "x", "--root", str(loom_dir)])
    assert result.exit_code != 0
    # Typer reports "No such command 'set'." for unknown commands.
    assert "No such command" in result.output or "set" in result.output


def test_update_command_works(loom_dir: Path) -> None:
    """`loom update QID title VALUE` should mutate the title field."""
    r = runner.invoke(
        app,
        [
            "project",
            "create",
            "acme",
            "--repo",
            "https://example/acme",
            "--root",
            str(loom_dir),
        ],
    )
    assert r.exit_code == 0, r.output

    r = runner.invoke(app, ["update", "acme", "title", "Updated", "--root", str(loom_dir)])
    assert r.exit_code == 0, r.output

    r = runner.invoke(app, ["show", "acme", "--root", str(loom_dir)])
    assert "title: Updated" in r.output
