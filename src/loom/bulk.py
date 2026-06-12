"""Bulk item creation: loom apply.

Library logic for plan validation and in-order item creation.
The CLI command (``loom apply``) is a thin wrapper over :func:`apply`.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING

from .errors import Duplicate, LoomError, NotFound

if TYPE_CHECKING:
    pass

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


@dataclass
class ApplyResult:
    """Returned by a successful :func:`apply` call."""

    created: list[dict]  # [{"ref": str|None, "qid": str, "type": str}, ...]


class PartialApplyError(LoomError):
    """Raised when creation fails mid-plan.

    Carries the items that were successfully created before the failure so
    the caller (CLI) can print a partial mapping before exiting nonzero.
    No rollback is performed.
    """

    def __init__(self, cause: Exception, created: list[dict]) -> None:
        super().__init__(f"apply failed after {len(created)} item(s): {cause}")
        self.cause = cause
        self.created = created


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
                f"item {idx}: invalid type {item.type!r}; must be one of {sorted(_ALLOWED_TYPES)}"
            )

        # --- title ---
        if not item.title or not item.title.strip():
            raise LoomError(f"item {idx}: title must be a non-empty string")

        # --- duplicate ref ---
        if item.ref is not None and item.ref in seen_refs:
            raise Duplicate(item.ref)

        # --- resolve parent type ---
        parent_type = _resolve_parent_type(item.parent, seen_refs, get_item_type, idx)

        # --- type/parent compatibility ---
        allowed_children = _VALID_PARENT_TYPES.get(parent_type, set())
        if item.type not in allowed_children:
            raise LoomError(
                f"item {idx}: type {item.type!r} cannot be parented on a {parent_type!r} item"
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


# ---------------------------------------------------------------------------
# Execution
# ---------------------------------------------------------------------------


def execute_plan(
    plan: ApplyPlan,
    root: Path,
    *,
    get_item: Callable[[str], object],  # returns Item or raises NotFound
) -> ApplyResult:
    """Execute *plan* in file order, creating items one by one.

    Returns :class:`ApplyResult` on full success.
    Raises :class:`PartialApplyError` if any creation fails mid-plan —
    items already created remain (no rollback), and the partial list is
    attached to the exception.

    :param plan: A validated :class:`ApplyPlan`.
    :param root: The loom root directory (``$LOOM_DIR``).
    :param get_item: Callable that resolves a qid to an Item.  Used to
        fetch existing parent items during execution.
    """
    from .ids import BACKLOG_EPIC_ID
    from .items import Epic, Project, Story

    # ref -> created qid (for resolving local ref parents during execution)
    ref_to_qid: dict[str, str] = {}

    created: list[dict] = []

    for item in plan.items:
        # Resolve parent qid: local ref or raw qid.
        parent_qid = ref_to_qid.get(item.parent, item.parent)

        try:
            parent_item = get_item(parent_qid)

            if item.type == "epic":
                assert isinstance(parent_item, Project)
                created_item = parent_item.create_epic(
                    title=item.title,
                    body=item.body,
                )
            elif item.type == "story":
                if isinstance(parent_item, Project):
                    # Target the backlog epic (auto-created by create_project).
                    backlog_qid = f"{parent_qid}:{BACKLOG_EPIC_ID}"
                    backlog = get_item(backlog_qid)
                    assert isinstance(backlog, Epic)
                    created_item = backlog.create_story(
                        title=item.title,
                        body=item.body,
                    )
                else:
                    assert isinstance(parent_item, Epic)
                    created_item = parent_item.create_story(
                        title=item.title,
                        body=item.body,
                    )
            elif item.type == "task":
                assert isinstance(parent_item, Story)
                created_item = parent_item.create_task(
                    title=item.title,
                    body=item.body,
                )
            else:  # pragma: no cover — validated before this point
                raise LoomError(f"unexpected type {item.type!r}")

            # Apply optional post-create mutators.
            if item.assignee is not None:
                created_item.set_assignee(item.assignee)  # type: ignore[union-attr]
            for tag in item.tags:
                created_item.add_tag(tag)
            if item.status != "ready":
                created_item.set_status(item.status)  # type: ignore[union-attr]

        except Exception as exc:
            raise PartialApplyError(exc, created) from exc

        entry = {
            "ref": item.ref,
            "qid": created_item.qualified_id,
            "type": created_item.type,
        }
        created.append(entry)

        if item.ref is not None:
            ref_to_qid[item.ref] = created_item.qualified_id

    return ApplyResult(created=created)
