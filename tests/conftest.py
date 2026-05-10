"""Shared test helpers."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from loom.bootstrap import init
from loom.ids import QualifiedId, path_from_qid
from loom.storage import dump


@pytest.fixture
def loom_dir(tmp_path: Path) -> Path:
    """A freshly initialized $LOOM_DIR rooted at tmp_path."""
    init(tmp_path)
    return tmp_path


def write_item(
    root: Path,
    qid: QualifiedId,
    *,
    archived: bool = False,
    body: str = "",
    **overrides: Any,
) -> Path:
    """Write a syntactically valid item file at the canonical path.

    Frontmatter defaults can be overridden by keyword args; pass
    ``status=None`` to omit the status field entirely.
    """
    fm: dict[str, Any] = {
        "schema_version": 1,
        "id": qid.local_id,
        "qualified_id": str(qid),
        "type": qid.type.value,
        "title": overrides.pop("title", f"Item {qid}"),
        "created_at": overrides.pop("created_at", "2026-01-01T00:00:00+00:00"),
        "updated_at": overrides.pop("updated_at", "2026-01-01T00:00:00+00:00"),
    }
    if qid.type.value != "project":
        status = overrides.pop("status", "ready")
        if status is not None:
            fm["status"] = status
    fm.update({k: v for k, v in overrides.items() if v is not None})

    path = path_from_qid(qid, root, archived=archived)
    dump(path, fm, body)
    return path
