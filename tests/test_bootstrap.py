from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from loom import index
from loom.bootstrap import init
from loom.errors import LoomError


def test_init_creates_fresh_layout(tmp_path: Path) -> None:
    root = tmp_path / "loom"
    result = init(root)

    assert result.root == root
    assert result.created_root
    assert result.created_projects
    assert result.created_db
    assert result.created_anything

    assert root.is_dir()
    assert (root / "projects").is_dir()
    assert (root / "loom.db").is_file()


def test_init_sets_user_version(tmp_path: Path) -> None:
    root = tmp_path / "loom"
    init(root)
    assert index.current_version(root / "loom.db") == index.SCHEMA_VERSION


def test_init_is_idempotent(tmp_path: Path) -> None:
    root = tmp_path / "loom"
    init(root)
    second = init(root)

    assert not second.created_root
    assert not second.created_projects
    assert not second.created_db
    assert not second.created_anything


def test_init_fills_in_missing_pieces(tmp_path: Path) -> None:
    root = tmp_path / "loom"
    root.mkdir()
    # User has the root but neither projects/ nor the db.
    result = init(root)
    assert not result.created_root
    assert result.created_projects
    assert result.created_db


def test_init_doesnt_touch_existing_db(tmp_path: Path) -> None:
    root = tmp_path / "loom"
    init(root)
    db = root / "loom.db"
    # Stuff a marker table into the DB.
    with sqlite3.connect(db) as conn:
        conn.execute("CREATE TABLE marker (x INTEGER)")
        conn.execute("INSERT INTO marker VALUES (42)")
        conn.commit()

    init(root)  # second run

    with sqlite3.connect(db) as conn:
        (val,) = conn.execute("SELECT x FROM marker").fetchone()
        assert val == 42


def test_init_rejects_newer_db_version(tmp_path: Path) -> None:
    root = tmp_path / "loom"
    init(root)
    index.set_version(root / "loom.db", index.SCHEMA_VERSION + 5)

    with pytest.raises(LoomError, match="schema version"):
        init(root)


def test_init_uses_env_when_root_not_passed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    target = tmp_path / "from-env"
    monkeypatch.setenv("LOOM_DIR", str(target))
    monkeypatch.delenv("XDG_DATA_HOME", raising=False)

    result = init()
    assert result.root == target
    assert target.is_dir()
