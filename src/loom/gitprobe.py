"""Thin subprocess wrappers around ``git`` for CLI ergonomics.

Used by ``loom project create`` to discover the cwd's origin URL and the
git toplevel (where the ``.loom/`` workspace is anchored). Nothing here
mutates state; all functions are pure probes.
"""

from __future__ import annotations

import subprocess
from pathlib import Path


def is_git_repo(cwd: Path) -> bool:
    """Return True iff *cwd* is inside a git work tree."""
    try:
        proc = subprocess.run(
            ["git", "-C", str(cwd), "rev-parse", "--is-inside-work-tree"],
            capture_output=True,
            text=True,
            check=False,
        )
    except (FileNotFoundError, OSError):
        return False
    return proc.returncode == 0 and proc.stdout.strip() == "true"


def discover_remote(cwd: Path, *, remote: str = "origin") -> str | None:
    """Return the URL for *remote* (default ``origin``), or None."""
    try:
        proc = subprocess.run(
            ["git", "-C", str(cwd), "config", "--get", f"remote.{remote}.url"],
            capture_output=True,
            text=True,
            check=False,
        )
    except (FileNotFoundError, OSError):
        return None
    if proc.returncode != 0:
        return None
    url = proc.stdout.strip()
    return url or None


def git_toplevel(cwd: Path) -> Path | None:
    """Return the toplevel of *cwd*'s git repository, or None."""
    try:
        proc = subprocess.run(
            ["git", "-C", str(cwd), "rev-parse", "--show-toplevel"],
            capture_output=True,
            text=True,
            check=False,
        )
    except (FileNotFoundError, OSError):
        return None
    if proc.returncode != 0:
        return None
    out = proc.stdout.strip()
    return Path(out) if out else None
