"""Idempotent ``loom init``: create the data directory layout.

Shaped like ``mkdir -p`` rather than ``git init``: re-running on an
already-initialized directory is a no-op and exits successfully. The
only error case is encountering a DB whose ``user_version`` is *newer*
than this binary supports.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from . import index
from .errors import LoomError
from .ids import PROJECTS_DIRNAME
from .paths import loom_root


@dataclass(frozen=True, slots=True)
class InitResult:
    root: Path
    created_root: bool
    created_projects: bool
    created_db: bool

    @property
    def created_anything(self) -> bool:
        return self.created_root or self.created_projects or self.created_db


def init(root: Path | None = None) -> InitResult:
    """Initialize *root* (or the resolved $LOOM_DIR) for use by loom.

    Idempotent. Never deletes or rewrites existing files.
    """
    if root is None:
        root = loom_root()

    created_root = not root.exists()
    root.mkdir(parents=True, exist_ok=True)

    projects = root / PROJECTS_DIRNAME
    created_projects = not projects.exists()
    projects.mkdir(exist_ok=True)

    db = index.db_path(root)
    created_db = not db.exists()
    if created_db:
        index.init_db(db)
    else:
        version = index.current_version(db)
        if version > index.SCHEMA_VERSION:
            raise LoomError(
                f"DB at {db} has schema version {version}; this binary supports "
                f"{index.SCHEMA_VERSION}. Upgrade loom or point at a different $LOOM_DIR."
            )

    return InitResult(
        root=root,
        created_root=created_root,
        created_projects=created_projects,
        created_db=created_db,
    )
