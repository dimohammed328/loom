"""Structural test: pyproject.toml must not contain web-only entries after pruning."""
from __future__ import annotations

from pathlib import Path

import tomllib


def _load_pyproject() -> dict:
    pyproject_path = Path(__file__).parent.parent / "pyproject.toml"
    with pyproject_path.open("rb") as f:
        return tomllib.load(f)


def test_no_loom_web_script() -> None:
    """pyproject.toml must not declare a loom-web console_scripts entry."""
    data = _load_pyproject()
    scripts = data.get("project", {}).get("scripts", {})
    assert "loom-web" not in scripts, (
        "loom-web script entry must be removed from pyproject.toml"
    )


def test_no_fastapi_dependency() -> None:
    """fastapi must not appear in runtime dependencies."""
    data = _load_pyproject()
    deps = data.get("project", {}).get("dependencies", [])
    for dep in deps:
        assert not dep.lower().startswith("fastapi"), (
            f"fastapi is a web-only dep and must be removed: {dep}"
        )


def test_no_uvicorn_dependency() -> None:
    """uvicorn must not appear in runtime dependencies."""
    data = _load_pyproject()
    deps = data.get("project", {}).get("dependencies", [])
    for dep in deps:
        assert not dep.lower().startswith("uvicorn"), (
            f"uvicorn is a web-only dep and must be removed: {dep}"
        )


def test_no_httpx_dependency() -> None:
    """httpx must not appear in runtime dependencies (was only for web tests)."""
    data = _load_pyproject()
    deps = data.get("project", {}).get("dependencies", [])
    for dep in deps:
        assert not dep.lower().startswith("httpx"), (
            f"httpx is a web-only dep and must be removed: {dep}"
        )
