"""Qualified identifiers and the path↔ID bijection.

A qualified id has the form ``project[:epic[:story[:task]]]``.

Constraints (all enforced by :func:`parse_qid`):

* Project name matches ``^[a-z][a-z0-9_-]{0,63}$`` and is not in the
  reserved set.
* Epic local id is either the literal ``backlog`` (the auto-created
  default epic on every project) or exactly seven characters from
  :data:`EPIC_ALPHABET`.
* Story / task indices are positive decimal integers with no leading
  zeros (``01`` → reject) and no whitespace.
* No empty segments (``foo::1`` → reject).
"""

from __future__ import annotations

import re
import secrets
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path

from .errors import InvalidQualifiedId, ReservedName

PROJECT_NAME_RE = re.compile(r"^[a-z][a-z0-9_-]{0,63}$")

EPIC_ALPHABET = "abcdefghjkmnpqrstvwxyz23456789"
EPIC_ID_LEN = 7
EPIC_ID_RE = re.compile(rf"^[{EPIC_ALPHABET}]{{{EPIC_ID_LEN}}}$")
BACKLOG_EPIC_ID = "backlog"


def _is_valid_epic_id(s: str) -> bool:
    """True iff *s* is either the literal `backlog` or a 7-char alphabet id."""
    return s == BACKLOG_EPIC_ID or bool(EPIC_ID_RE.match(s))


RESERVED_NAMES = frozenset({"projects", "loom", "_archive"})

ARCHIVE_DIRNAME = "_archive"
PROJECTS_DIRNAME = "projects"
EPICS_DIRNAME = "epics"
STORIES_DIRNAME = "stories"
TASKS_DIRNAME = "tasks"

PROJECT_FILENAME = "project.md"
EPIC_FILENAME = "epic.md"
STORY_FILENAME = "story.md"


class ItemType(StrEnum):
    PROJECT = "project"
    EPIC = "epic"
    STORY = "story"
    TASK = "task"


@dataclass(frozen=True, slots=True)
class QualifiedId:
    """The canonical reference to any item in loom.

    Construct via :func:`parse_qid` or :func:`qid_from_path`; direct
    construction is allowed but unchecked beyond field types.
    """

    project: str
    epic: str | None = None
    story: int | None = None
    task: int | None = None

    @property
    def type(self) -> ItemType:
        if self.task is not None:
            return ItemType.TASK
        if self.story is not None:
            return ItemType.STORY
        if self.epic is not None:
            return ItemType.EPIC
        return ItemType.PROJECT

    @property
    def local_id(self) -> str:
        """The local id segment for this item (the ``id`` frontmatter field)."""
        if self.task is not None:
            return str(self.task)
        if self.story is not None:
            return str(self.story)
        if self.epic is not None:
            return self.epic
        return self.project

    @property
    def parent(self) -> QualifiedId | None:
        match self.type:
            case ItemType.TASK:
                return QualifiedId(self.project, self.epic, self.story)
            case ItemType.STORY:
                return QualifiedId(self.project, self.epic)
            case ItemType.EPIC:
                return QualifiedId(self.project)
            case ItemType.PROJECT:
                return None

    def __str__(self) -> str:
        parts: list[str] = [self.project]
        if self.epic is not None:
            parts.append(self.epic)
        if self.story is not None:
            parts.append(str(self.story))
        if self.task is not None:
            parts.append(str(self.task))
        return ":".join(parts)


def validate_project_name(name: str) -> None:
    """Raise if *name* is not a legal project slug."""
    if name in RESERVED_NAMES or name.startswith("_"):
        raise ReservedName(name)
    if not PROJECT_NAME_RE.match(name):
        raise InvalidQualifiedId(
            name,
            "project name must match ^[a-z][a-z0-9_-]{0,63}$",
        )


def _parse_index(raw: str, segment: str) -> int:
    if not raw or not raw.isascii() or not raw.isdigit():
        raise InvalidQualifiedId(
            raw,
            f"{segment} segment must be a positive decimal integer",
        )
    n = int(raw)
    if str(n) != raw:
        raise InvalidQualifiedId(raw, f"{segment} segment has leading zeros")
    if n < 1:
        raise InvalidQualifiedId(raw, f"{segment} segment must be >= 1")
    return n


def parse_qid(s: str) -> QualifiedId:
    """Parse a colon-delimited qualified id, validating every segment."""
    if not isinstance(s, str):  # type: ignore[unreachable]
        raise InvalidQualifiedId(repr(s), "qualified id must be a string")
    if s != s.strip() or any(c.isspace() for c in s):
        raise InvalidQualifiedId(s, "qualified id must contain no whitespace")

    parts = s.split(":")
    if not 1 <= len(parts) <= 4:
        raise InvalidQualifiedId(s, "qualified id must have 1-4 colon-delimited segments")
    if any(p == "" for p in parts):
        raise InvalidQualifiedId(s, "qualified id must not contain empty segments")

    project = parts[0]
    validate_project_name(project)

    if len(parts) == 1:
        return QualifiedId(project=project)

    epic = parts[1]
    if not _is_valid_epic_id(epic):
        raise InvalidQualifiedId(
            s,
            f"epic segment {epic!r} must be {EPIC_ID_LEN} chars from the epic alphabet "
            f"or the literal {BACKLOG_EPIC_ID!r}",
        )

    if len(parts) == 2:
        return QualifiedId(project=project, epic=epic)

    story = _parse_index(parts[2], "story")
    if len(parts) == 3:
        return QualifiedId(project=project, epic=epic, story=story)

    task = _parse_index(parts[3], "task")
    return QualifiedId(project=project, epic=epic, story=story, task=task)


def random_epic_id() -> str:
    """Return a fresh random epic local id (uniform over EPIC_ALPHABET)."""
    return "".join(secrets.choice(EPIC_ALPHABET) for _ in range(EPIC_ID_LEN))


def path_from_qid(qid: QualifiedId, root: Path, *, archived: bool = False) -> Path:
    """Return the markdown file path for *qid* under *root*.

    If *archived* is true, the path is rooted at ``<root>/_archive/``;
    otherwise at ``<root>/`` directly.
    """
    base = root / ARCHIVE_DIRNAME if archived else root
    p = base / PROJECTS_DIRNAME / qid.project
    if qid.epic is None:
        return p / PROJECT_FILENAME
    p = p / EPICS_DIRNAME / qid.epic
    if qid.story is None:
        return p / EPIC_FILENAME
    p = p / STORIES_DIRNAME / str(qid.story)
    if qid.task is None:
        return p / STORY_FILENAME
    return p / TASKS_DIRNAME / f"{qid.task}.md"


def qid_from_path(path: Path, root: Path) -> tuple[QualifiedId, bool]:
    """Recover ``(qualified_id, archived)`` from a markdown file path.

    The path must be under *root* and match the canonical layout. This is
    a pure path computation; the file does not need to exist.
    """
    try:
        rel_parts = path.relative_to(root).parts
    except ValueError as e:
        raise InvalidQualifiedId(str(path), f"path is not under root {root}") from e

    parts = list(rel_parts)
    archived = False
    if parts and parts[0] == ARCHIVE_DIRNAME:
        archived = True
        parts = parts[1:]

    if len(parts) < 2 or parts[0] != PROJECTS_DIRNAME:
        raise InvalidQualifiedId(str(path), f"path must start with '{PROJECTS_DIRNAME}/'")

    project = parts[1]
    validate_project_name(project)
    rest = parts[2:]

    # Project file: <P>/project.md
    if rest == [PROJECT_FILENAME]:
        return QualifiedId(project=project), archived

    if len(rest) < 2 or rest[0] != EPICS_DIRNAME:
        raise InvalidQualifiedId(str(path), f"expected '{EPICS_DIRNAME}/<id>' after project")

    epic = rest[1]
    if not _is_valid_epic_id(epic):
        raise InvalidQualifiedId(str(path), f"invalid epic id segment {epic!r}")
    rest = rest[2:]

    # Epic file: <E>/epic.md
    if rest == [EPIC_FILENAME]:
        return QualifiedId(project=project, epic=epic), archived

    if len(rest) < 2 or rest[0] != STORIES_DIRNAME:
        raise InvalidQualifiedId(str(path), f"expected '{STORIES_DIRNAME}/<n>' after epic")

    story = _parse_index(rest[1], "story")
    rest = rest[2:]

    # Story file: <S>/story.md
    if rest == [STORY_FILENAME]:
        return QualifiedId(project=project, epic=epic, story=story), archived

    # Task file: tasks/<T>.md
    if len(rest) == 2 and rest[0] == TASKS_DIRNAME and rest[1].endswith(".md"):
        task = _parse_index(rest[1].removesuffix(".md"), "task")
        return QualifiedId(project=project, epic=epic, story=story, task=task), archived

    raise InvalidQualifiedId(str(path), "path does not match the canonical loom layout")
