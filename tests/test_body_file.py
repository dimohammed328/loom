"""Tests for --body-file flag and Item.set_body_from_file helper."""

from __future__ import annotations

from pathlib import Path

import pytest

from loom.api import Loom


def test_set_body_from_file_reads_file(loom_dir: Path, tmp_path: Path) -> None:
    body_path = tmp_path / "body.md"
    body_path.write_text("# Heading\n\nbody text.\n", encoding="utf-8")
    loom = Loom(root=loom_dir)
    project = loom.create_project(name="p", title="P")
    epic = project.create_epic(title="e")
    epic.set_body_from_file(body_path)
    assert epic.refresh().body.strip().startswith("# Heading")


def test_set_body_from_file_missing_raises(loom_dir: Path, tmp_path: Path) -> None:
    loom = Loom(root=loom_dir)
    project = loom.create_project(name="p", title="P")
    epic = project.create_epic(title="e")
    with pytest.raises(FileNotFoundError):
        epic.set_body_from_file(tmp_path / "does-not-exist.md")
