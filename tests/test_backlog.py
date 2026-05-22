"""Tests for the default `backlog` epic feature."""

from __future__ import annotations

from pathlib import Path

import pytest

from loom import Duplicate, Loom


def test_create_epic_with_explicit_id(loom_dir: Path) -> None:
    loom = Loom(root=loom_dir)
    project = loom.create_project("acme", title="A")
    # The auto-created backlog already occupies "backlog"; create a
    # fresh project to exercise the explicit-id path without colliding.
    other = loom.create_project("other", title="O")
    epic = other.create_epic(title="X", epic_id="abcdefg")
    assert epic.qualified_id == "other:abcdefg"


def test_create_epic_explicit_id_duplicate_raises(loom_dir: Path) -> None:
    loom = Loom(root=loom_dir)
    project = loom.create_project("acme", title="A")
    # The backlog already exists from create_project's auto-creation.
    with pytest.raises(Duplicate):
        project.create_epic(title="Backlog 2", epic_id="backlog")


def test_create_epic_invalid_explicit_id_raises(loom_dir: Path) -> None:
    loom = Loom(root=loom_dir)
    project = loom.create_project("acme", title="A")
    # 'BAD' has uppercase chars; not in the alphabet and not the literal 'backlog'.
    with pytest.raises(Exception):  # InvalidQualifiedId — path build will catch it
        project.create_epic(title="X", epic_id="BAD")
