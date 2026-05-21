"""Smoke tests for the root callback wiring (CliState on ctx.obj)."""

from __future__ import annotations

from pathlib import Path

import typer
from typer.testing import CliRunner

from loom.cli import CliState, _cli_state, app

runner = CliRunner()


def test_non_interactive_flag_accepted(loom_dir: Path) -> None:
    result = runner.invoke(app, ["-y", "project", "list", "--root", str(loom_dir)])
    assert result.exit_code == 0, result.output


def test_long_form_accepted(loom_dir: Path) -> None:
    result = runner.invoke(app, ["--non-interactive", "project", "list", "--root", str(loom_dir)])
    assert result.exit_code == 0, result.output


def test_root_callback_sets_ctx_obj() -> None:
    """Wire a child command that reads ctx.obj; ensure -y is reflected."""
    seen: list[CliState] = []

    sub = typer.Typer()
    app.add_typer(sub, name="_probe")

    @sub.command("show")
    def _show(ctx: typer.Context) -> None:
        seen.append(_cli_state(ctx))

    try:
        runner.invoke(app, ["-y", "_probe", "show"])
        assert seen and seen[-1].non_interactive is True

        seen.clear()
        runner.invoke(app, ["_probe", "show"])
        assert seen and seen[-1].non_interactive is False
    finally:
        # detach to keep app state clean for other tests
        app.registered_groups = [g for g in app.registered_groups if g.name != "_probe"]
