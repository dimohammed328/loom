"""Atomic markdown I/O with order-preserving YAML frontmatter.

The on-disk format is::

    ---
    <yaml frontmatter>
    ---
    <markdown body>

Files always end with exactly one trailing newline. Writes go via a temp
file in the destination directory followed by :func:`os.replace`, so a
``Ctrl-C`` mid-write can never leave a partially written file in place.
"""

from __future__ import annotations

import io
import os
import tempfile
from pathlib import Path
from typing import Any

from ruamel.yaml import YAML
from ruamel.yaml.error import YAMLError

from .errors import ValidationError

FENCE = "---"

_yaml = YAML(typ="rt")
_yaml.preserve_quotes = True
_yaml.default_flow_style = False


def load(path: Path) -> tuple[dict[str, Any], str]:
    """Read a markdown file, returning ``(frontmatter, body)``.

    Files without an opening ``---`` fence have an empty frontmatter and
    the entire content as body. A file that opens a fence but never
    closes one raises :class:`ValidationError`.
    """
    text = path.read_text(encoding="utf-8")
    return parse(text, source=str(path))


def dump(path: Path, frontmatter: dict[str, Any], body: str) -> None:
    """Atomically write ``frontmatter`` + ``body`` to *path*."""
    _atomic_write(path, render(frontmatter, body))


def parse(text: str, source: str | None = None) -> tuple[dict[str, Any], str]:
    """Parse a markdown string into ``(frontmatter, body)``.

    The body starts at the line *after* the closing fence; the closing
    fence is the first ``---`` line found after the opening one (so a
    body containing a horizontal rule does not confuse the parser).
    """
    lines = text.splitlines(keepends=True)

    if not lines or lines[0].rstrip("\r\n") != FENCE:
        return {}, text

    close_idx: int | None = None
    for i in range(1, len(lines)):
        if lines[i].rstrip("\r\n") == FENCE:
            close_idx = i
            break

    if close_idx is None:
        suffix = f" (source: {source})" if source else ""
        raise ValidationError(
            None,
            f"frontmatter opening '---' has no closing fence{suffix}",
        )

    yaml_text = "".join(lines[1:close_idx])
    body = "".join(lines[close_idx + 1 :])

    try:
        loaded = _yaml.load(yaml_text) if yaml_text.strip() else None
    except YAMLError as e:
        suffix = f" (source: {source})" if source else ""
        raise ValidationError(None, f"frontmatter is not valid YAML{suffix}: {e}") from e
    if loaded is None:
        loaded = {}
    if not isinstance(loaded, dict):
        raise ValidationError(
            None,
            f"frontmatter must be a YAML mapping, got {type(loaded).__name__}",
        )

    return loaded, body


def render(frontmatter: dict[str, Any], body: str) -> str:
    """Serialize ``frontmatter`` + ``body`` to the canonical on-disk form."""
    parts: list[str] = []

    if frontmatter:
        buf = io.StringIO()
        _yaml.dump(frontmatter, buf)
        yaml_text = buf.getvalue()
        if not yaml_text.endswith("\n"):
            yaml_text += "\n"
        parts.append(FENCE + "\n")
        parts.append(yaml_text)
        parts.append(FENCE + "\n")

    if body:
        parts.append(body.rstrip("\n") + "\n")

    out = "".join(parts)
    if not out.endswith("\n"):
        out += "\n"
    return out


def _atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_str = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    tmp = Path(tmp_str)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(content)
        os.replace(tmp, path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
