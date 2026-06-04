"""Structural test: src/loom_web must not exist after backend removal."""

from __future__ import annotations

import importlib
import sys
from pathlib import Path


def test_loom_web_directory_does_not_exist() -> None:
    """src/loom_web/ must have been deleted."""
    src_root = Path(__file__).parent.parent / "src"
    loom_web_dir = src_root / "loom_web"
    assert not loom_web_dir.exists(), (
        f"src/loom_web/ still exists at {loom_web_dir} — must be deleted"
    )


def test_loom_web_not_importable() -> None:
    """loom_web must not be importable after backend removal."""
    # Remove from sys.modules if it somehow got imported
    for key in list(sys.modules):
        if key == "loom_web" or key.startswith("loom_web."):
            del sys.modules[key]
    try:
        importlib.import_module("loom_web")
        raise AssertionError("loom_web is still importable — src/loom_web/ must be deleted")
    except ImportError:
        pass  # Expected
