"""Phase 5 polish: auto version-stamp, exit codes, new --json outputs."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from typer.testing import CliRunner

from loom import Loom
from loom.bootstrap import init as bootstrap_init
from loom.cli import (
    EXIT_CYCLE,
    EXIT_DUPLICATE,
    EXIT_GENERIC,
    EXIT_INVALID_ID,
    EXIT_NOT_FOUND,
    app,
)
from loom.index import SCHEMA_VERSION, current_version, db_path

runner = CliRunner()


# ---------------------------------------------------------------------------
# Loom() stamps user_version when the DB exists at version 0
# ---------------------------------------------------------------------------


def test_loom_stamps_user_version_on_unstamped_db(tmp_path: Path) -> None:
    """If the DB exists at version 0, constructing Loom stamps it.

    Before Phase 5 this was a silent carry-forward — a Loom() flow that
    happened to bypass bootstrap.init() would leave the DB unversioned,
    and a later init() wouldn't re-stamp it.
    """
    root = tmp_path / "store"
    root.mkdir()
    # Hand-create the schema at version 0 (mimics a Loom-only flow that
    # never touched bootstrap.init()).
    db = db_path(root)
    with sqlite3.connect(db) as conn:
        conn.execute("CREATE TABLE items (qualified_id TEXT)")  # any table
    assert current_version(db) == 0

    Loom(root=root)
    assert current_version(db) == SCHEMA_VERSION


def test_loom_rejects_missing_root(tmp_path: Path) -> None:
    """Constructing Loom against a non-existent root raises immediately.

    Locks down the choice to *not* auto-init in Loom.__init__ — typo'd
    paths surface as a clear LoomError instead of being silently
    materialized or producing a downstream sqlite OperationalError.
    """
    import pytest

    from loom import LoomError

    root = tmp_path / "does-not-exist"
    with pytest.raises(LoomError, match="does not exist"):
        Loom(root=root)
    assert not root.exists()


def test_loom_leaves_versioned_db_alone(tmp_path: Path) -> None:
    """A correctly-versioned DB is untouched."""
    root = tmp_path / "store"
    bootstrap_init(root)
    assert current_version(db_path(root)) == SCHEMA_VERSION
    Loom(root=root)
    assert current_version(db_path(root)) == SCHEMA_VERSION


def test_show_against_uninitialized_root_fails_cleanly(tmp_path: Path) -> None:
    """A typo'd --root must fail with a comprehensible error, not a traceback.

    Regression: previously a missing root produced a downstream sqlite
    OperationalError ("unable to open database file") that bubbled up
    as an uncaught exception. The CLI now routes through Loom() which
    raises a clear LoomError, caught by `_loom` and reported through
    the normal exit-code pathway.
    """
    root = tmp_path / "does-not-exist"
    r = runner.invoke(app, ["show", "foo", "--root", str(root)])
    assert r.exit_code == EXIT_GENERIC
    # No uncaught exception — the command exits cleanly.
    assert r.exception is None or isinstance(r.exception, SystemExit)
    assert "does not exist" in r.output
    assert not root.exists()


# ---------------------------------------------------------------------------
# Exit code contract
# ---------------------------------------------------------------------------


def test_exit_code_not_found(loom_dir: Path) -> None:
    r = runner.invoke(app, ["show", "no_such", "--root", str(loom_dir)])
    assert r.exit_code == EXIT_NOT_FOUND


def test_exit_code_duplicate(loom_dir: Path) -> None:
    runner.invoke(app, ["project", "create", "acme", "--title", "A", "--root", str(loom_dir)])
    r = runner.invoke(app, ["project", "create", "acme", "--title", "A", "--root", str(loom_dir)])
    assert r.exit_code == EXIT_DUPLICATE


def test_exit_code_invalid_id(loom_dir: Path) -> None:
    """Reserved/malformed project names route through EXIT_INVALID_ID."""
    r = runner.invoke(
        app,
        ["project", "create", "Bad-Name", "--title", "X", "--root", str(loom_dir)],
    )
    assert r.exit_code == EXIT_INVALID_ID


def test_exit_code_cycle(loom_dir: Path) -> None:
    loom = Loom(root=loom_dir)
    p = loom.create_project("acme", title="A")
    e = p.create_epic(title="E")
    s = e.create_story(title="S")
    t1 = s.create_task(title="T1")
    t2 = s.create_task(title="T2")
    runner.invoke(
        app,
        ["dep", "add", t2.qualified_id, "--on", t1.qualified_id, "--root", str(loom_dir)],
    )
    r = runner.invoke(
        app, ["dep", "add", t1.qualified_id, "--on", t2.qualified_id, "--root", str(loom_dir)]
    )
    assert r.exit_code == EXIT_CYCLE


def test_exit_code_validate_falls_back_to_generic(loom_dir: Path) -> None:
    """`validate` reporting issues stays at EXIT_GENERIC; this is part of
    the contract so existing scripts keep working."""
    loom = Loom(root=loom_dir)
    p = loom.create_project("foo", title="F")
    # Append text out-of-band to introduce drift.
    p.file_path.write_text(p.file_path.read_text() + "\nappended\n")
    r = runner.invoke(app, ["validate", "--root", str(loom_dir)])
    assert r.exit_code == EXIT_GENERIC


# ---------------------------------------------------------------------------
# rebuild --json
# ---------------------------------------------------------------------------


def test_rebuild_json_clean(loom_dir: Path) -> None:
    Loom(root=loom_dir).create_project("acme", title="A")
    r = runner.invoke(app, ["rebuild", "--json", "--root", str(loom_dir)])
    assert r.exit_code == 0
    payload = json.loads(r.output)
    assert payload["indexed_count"] == 1
    assert payload["rewrites"] == []
    assert payload["issues"] == []


def test_rebuild_json_with_issue(loom_dir: Path) -> None:
    """A stray file shows up as a JSON-encoded issue."""
    (loom_dir / "projects" / "stray.md").write_text("---\ntitle: x\n---\n")
    r = runner.invoke(app, ["rebuild", "--json", "--root", str(loom_dir)])
    assert r.exit_code == EXIT_GENERIC
    payload = json.loads(r.output)
    assert payload["indexed_count"] == 0
    assert any(i["kind"] == "stray_file" for i in payload["issues"])


# ---------------------------------------------------------------------------
# show --json
# ---------------------------------------------------------------------------


def test_show_json_emits_frontmatter_and_body(loom_dir: Path) -> None:
    loom = Loom(root=loom_dir)
    p = loom.create_project("acme", title="Acme", body="## about\n\nhello\n")
    p.set_repo("https://github.com/acme/acme")
    r = runner.invoke(app, ["show", "acme", "--json", "--root", str(loom_dir)])
    assert r.exit_code == 0
    payload = json.loads(r.output)
    assert payload["qualified_id"] == "acme"
    assert payload["type"] == "project"
    assert payload["frontmatter"]["title"] == "Acme"
    assert payload["frontmatter"]["repo"] == "https://github.com/acme/acme"
    assert "hello" in payload["body"]


def test_show_json_preserves_unknown_frontmatter_keys(loom_dir: Path) -> None:
    """Unknown keys round-trip through show --json."""
    from loom.storage import dump, load

    loom = Loom(root=loom_dir)
    p = loom.create_project("acme", title="A")
    fm, body = load(p.file_path)
    fm["custom"] = {"score": 7}
    dump(p.file_path, fm, body)
    loom.sync("acme")

    r = runner.invoke(app, ["show", "acme", "--json", "--root", str(loom_dir)])
    payload = json.loads(r.output)
    assert payload["frontmatter"]["custom"] == {"score": 7}
