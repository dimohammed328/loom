"""Loom exception hierarchy.

Only errors needed before the end of Phase 1 are fleshed out.
Later phases fill in the rest as the operations that raise them are built.
"""

from __future__ import annotations


class LoomError(Exception):
    """Base class for all loom-raised errors."""


class InvalidQualifiedId(LoomError):
    """A qualified-ID string failed to parse or validate."""

    def __init__(self, raw: str, reason: str) -> None:
        super().__init__(f"invalid qualified id {raw!r}: {reason}")
        self.raw = raw
        self.reason = reason


class ReservedName(LoomError):
    """A project name collides with a reserved identifier."""

    def __init__(self, name: str) -> None:
        super().__init__(
            f"project name {name!r} is reserved (cannot start with '_' or be one of "
            f"'projects', 'loom', '_archive')"
        )
        self.name = name


class NotFound(LoomError):
    """A qualified ID was not found in the store."""

    def __init__(self, qualified_id: str) -> None:
        super().__init__(f"item not found: {qualified_id}")
        self.qualified_id = qualified_id


class Duplicate(LoomError):
    """An item with the same qualified ID already exists."""

    def __init__(self, qualified_id: str) -> None:
        super().__init__(f"item already exists: {qualified_id}")
        self.qualified_id = qualified_id


class CycleError(LoomError):
    """Adding a dependency would create a cycle."""

    def __init__(self, source_id: str, target_id: str, cycle: list[str]) -> None:
        path = " -> ".join(cycle)
        super().__init__(f"dependency {source_id} -> {target_id} would create a cycle: {path}")
        self.source_id = source_id
        self.target_id = target_id
        self.cycle = cycle


class Drift(LoomError):
    """The on-disk file's hash disagrees with the index hash."""

    def __init__(self, qualified_id: str, file_path: str) -> None:
        super().__init__(
            f"drift detected for {qualified_id} at {file_path}: "
            f"on-disk content differs from indexed hash"
        )
        self.qualified_id = qualified_id
        self.file_path = file_path


class ValidationError(LoomError):
    """Frontmatter or item content failed validation."""

    def __init__(self, qualified_id: str | None, reason: str) -> None:
        prefix = f"{qualified_id}: " if qualified_id else ""
        super().__init__(f"{prefix}{reason}")
        self.qualified_id = qualified_id
        self.reason = reason
