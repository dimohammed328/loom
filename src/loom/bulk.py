"""Bulk item creation: loom apply.

Library logic for plan validation and in-order item creation.
The CLI command (``loom apply``) is a thin wrapper over :func:`apply`.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable

from .errors import Duplicate, LoomError, NotFound

# ---------------------------------------------------------------------------
# Plan schema
# ---------------------------------------------------------------------------

_ALLOWED_TYPES = frozenset({"epic", "story", "task"})

# parent_type -> allowed child types
_VALID_PARENT_TYPES: dict[str, set[str]] = {
    "project": {"epic", "story"},  # story on project -> targets backlog
    "epic": {"story"},
    "story": {"task"},
    # task has no children
}


@dataclass
class PlanItem:
    """One item to create in a bulk plan."""

    type: str
    parent: str
    title: str
    ref: str | None = None
    body: str = ""
    assignee: str | None = None
    tags: list[str] = field(default_factory=list)
    status: str = "ready"


@dataclass
class ApplyPlan:
    """A parsed apply plan ready for validation + execution."""

    items: list[PlanItem]


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


def validate_plan(
    plan: ApplyPlan,
    *,
    get_item_type: Callable[[str], str | None],
) -> None:
    """Validate *plan* without writing anything.

    Raises on the first error found:

    - :class:`~loom.errors.LoomError` for bad type, empty title,
      type/parent incompatibility.
    - :class:`~loom.errors.Duplicate` for duplicate ``ref`` values.
    - :class:`~loom.errors.NotFound` for unknown parent refs/qids or
      forward references.

    :param get_item_type: Callable that resolves an existing qid to its
        type string (``"project"``, ``"epic"``, etc.) or ``None`` when
        not found.  Only called for parent values that are not local refs
        defined earlier in the plan.
    """
    # Maps ref -> resolved type (from already-seen plan items)
    seen_refs: dict[str, str] = {}

    for idx, item in enumerate(plan.items):
        # --- type ---
        if item.type not in _ALLOWED_TYPES:
            raise LoomError(
                f"item {idx}: invalid type {item.type!r}; "
                f"must be one of {sorted(_ALLOWED_TYPES)}"
            )

        # --- title ---
        if not item.title or not item.title.strip():
            raise LoomError(f"item {idx}: title must be a non-empty string")

        # --- duplicate ref ---
        if item.ref is not None:
            if item.ref in seen_refs:
                raise Duplicate(item.ref)

        # --- resolve parent type ---
        parent_type = _resolve_parent_type(item.parent, seen_refs, get_item_type, idx)

        # --- type/parent compatibility ---
        allowed_children = _VALID_PARENT_TYPES.get(parent_type, set())
        if item.type not in allowed_children:
            raise LoomError(
                f"item {idx}: type {item.type!r} cannot be parented on a "
                f"{parent_type!r} item"
            )

        # Register this item's ref so later entries can reference it.
        if item.ref is not None:
            seen_refs[item.ref] = item.type


def _resolve_parent_type(
    parent: str,
    seen_refs: dict[str, str],
    get_item_type: Callable[[str], str | None],
    item_idx: int,
) -> str:
    """Return the type of *parent*, or raise :class:`NotFound`.

    Checks (in order):
    1. Already-seen local refs.
    2. Store lookup via *get_item_type*.
    """
    # 1. Local ref (already seen — forward refs are not allowed)
    if parent in seen_refs:
        return seen_refs[parent]

    # 2. Store lookup — could be an existing qid
    resolved = get_item_type(parent)
    if resolved is not None:
        return resolved

    # Unknown: not a seen ref and not in the store.
    raise NotFound(parent)
