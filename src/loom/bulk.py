"""Bulk item creation: loom apply.

Library logic for plan parsing, validation, and in-order item creation.
The CLI command (``loom apply``) is a thin wrapper over :func:`apply`.

Nested plan schema
------------------
Items form a tree: root items carry a ``parent`` qid (must be an existing
store item), and nest children via the ``children`` list.  Tasks may not
have children.  The ``parent`` field is forbidden on nested children.

Error reporting
---------------
:func:`load_plan` is the single entry point that collects **all** errors —
both structural field errors and semantic errors — in one combined pass and
raises :class:`PlanValidationError` carrying a list of :class:`PlanError`
objects sorted in document (pre-order) position.  Each error has:

- ``path``    — JSON-path into the plan (``items[0].children[2]``)
- ``code``    — stable machine constant (``CODE_*`` below)
- ``message`` — human/model-readable; names the offending value and expected form

:func:`parse_plan` and :func:`validate_plan` remain available for callers that
need them separately, but callers should prefer :func:`load_plan`.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING

from .errors import LoomError

if TYPE_CHECKING:
    pass

# ---------------------------------------------------------------------------
# Error code constants  (stable public contract)
# ---------------------------------------------------------------------------

CODE_BAD_TYPE = "bad_type"
"""``type`` value is not one of ``epic``, ``story``, ``task``."""

CODE_EMPTY_TITLE = "empty_title"
"""``title`` is present but empty or whitespace-only."""

CODE_DUPLICATE_REF = "duplicate_ref"
"""A ``ref`` value appears more than once across the whole plan tree."""

CODE_UNKNOWN_PARENT = "unknown_parent"
"""The ``parent`` qid on a root item does not exist in the store."""

CODE_MISSING_PARENT = "missing_parent"
"""A root item has no ``parent`` field (it is absent)."""

CODE_PARENT_ON_CHILD = "parent_on_child"
"""A nested child item has a ``parent`` field set (forbidden; nesting is the relationship)."""

CODE_CHILDREN_ON_TASK = "children_on_task"
"""A task item has a non-empty ``children`` list (tasks are leaves)."""

CODE_BAD_NESTING = "bad_nesting"
"""``type`` is incompatible with the enclosing item type."""

CODE_NON_OBJECT = "non_object"
"""An item in the ``items`` or ``children`` list is not a JSON object / dict."""

CODE_UNKNOWN_FIELD = "unknown_field"
"""An item contains a field not in the allowed set."""

CODE_MISSING_FIELD = "missing_field"
"""An item is missing a required field (e.g. ``type`` or ``title``)."""

CODE_WRONG_TYPE = "wrong_type"
"""A field has the wrong JSON type (e.g. ``tags`` must be a list)."""

CODE_MISSING_ITEMS = "missing_items"
"""The top-level plan object is missing the ``items`` key."""

# ---------------------------------------------------------------------------
# Plan schema
# ---------------------------------------------------------------------------

_ALLOWED_TYPES = frozenset({"epic", "story", "task"})

# parent_type -> allowed child types (for both store-parented and nesting)
_VALID_CHILDREN: dict[str, set[str]] = {
    "project": {"epic", "story"},  # story on project -> targets backlog
    "epic": {"story"},
    "story": {"task"},
    # task has no children
}

# Fields allowed on a plan item dict
_ITEM_FIELDS = frozenset(
    {"ref", "type", "title", "parent", "body", "assignee", "tags", "status", "children"}
)


# ---------------------------------------------------------------------------
# Dataclasses
# ---------------------------------------------------------------------------


@dataclass
class PlanError:
    """One error from plan parsing or validation."""

    path: str
    code: str
    message: str


@dataclass
class PlanValidationError(LoomError):
    """Raised when load_plan / parse_plan / validate_plan finds errors.

    Carries every collected error so callers can act on all problems at once.
    Errors are sorted in document (pre-order walk) position order.
    """

    errors: list[PlanError]

    def __init__(self, errors: list[PlanError]) -> None:
        first = errors[0] if errors else None
        msg = f"{len(errors)} plan error(s)"
        if first:
            msg += f"; first: [{first.code}] {first.path}: {first.message}"
        super().__init__(msg)
        self.errors = errors


@dataclass
class PlanItem:
    """One item to create in a bulk plan (nested schema)."""

    type: str
    title: str | None = None  # None means absent from raw dict; "" means explicit empty
    parent: str | None = None  # required on roots, forbidden on children
    ref: str | None = None
    body: str = ""
    assignee: str | None = None
    tags: list[str] = field(default_factory=list)
    status: str = "ready"
    children: list[PlanItem] = field(default_factory=list)


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
# Document-order sort key for error paths
# ---------------------------------------------------------------------------


def _path_sort_key(path: str) -> tuple:
    """Convert a path like 'items[0].children[2]' to a tuple of ints for sorting.

    Plan-level paths (empty or no bracket) sort before item paths.
    """
    parts = re.findall(r"\d+", path)
    return tuple(int(p) for p in parts)


def _sort_errors(errors: list[PlanError]) -> list[PlanError]:
    """Return errors sorted in document (pre-order) position."""
    return sorted(errors, key=lambda e: _path_sort_key(e.path))


# ---------------------------------------------------------------------------
# Combined entry point (preferred)
# ---------------------------------------------------------------------------


def load_plan(
    data: object,
    *,
    get_item_type: Callable[[str], str | None],
) -> ApplyPlan:
    """Parse and fully validate a raw plan dict in one combined pass.

    Collects **all** structural field errors AND semantic errors in one run,
    merges them, sorts in document order, and raises
    :class:`PlanValidationError` if any errors exist.

    This is the preferred entry point for both the CLI and :meth:`Loom.apply`.

    :param data: Raw plan object (from JSON deserialization).
    :param get_item_type: Callable that resolves an existing qid to its
        type string (``"project"``, ``"epic"``, etc.) or ``None`` when
        not found.  Called only for ``parent`` values on root items.
    :raises PlanValidationError: if any errors are found (combined report,
        sorted in document order).
    """
    structural_errors: list[PlanError] = []

    # Top-level structural checks — these are fatal; can't build a tree at all
    if not isinstance(data, dict):
        raise PlanValidationError(
            [PlanError(path="", code=CODE_NON_OBJECT, message="plan must be a JSON object")]
        )

    if "items" not in data:
        raise PlanValidationError(
            [
                PlanError(
                    path="",
                    code=CODE_MISSING_ITEMS,
                    message="plan must have an 'items' key",
                )
            ]
        )

    raw_items = data["items"]
    if not isinstance(raw_items, list):
        raise PlanValidationError(
            [
                PlanError(
                    path="items",
                    code=CODE_WRONG_TYPE,
                    message="'items' must be a list",
                )
            ]
        )

    # Parse best-effort tree (collecting structural errors)
    items = _parse_item_list(raw_items, "items", is_root=True, errors=structural_errors)
    plan = ApplyPlan(items=items)

    # Run semantic validation on the best-effort tree (collecting semantic errors)
    semantic_errors: list[PlanError] = []
    seen_refs: set[str] = set()
    for idx, item in enumerate(plan.items):
        _validate_item(
            item,
            path=f"items[{idx}]",
            parent_type=None,
            is_root=True,
            errors=semantic_errors,
            seen_refs=seen_refs,
            get_item_type=get_item_type,
        )

    all_errors = _sort_errors(structural_errors + semantic_errors)
    if all_errors:
        raise PlanValidationError(all_errors)

    return plan


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------


def parse_plan(data: object) -> ApplyPlan:
    """Parse a raw plan dict into an :class:`ApplyPlan`.

    Performs structural field checking (unknown/missing fields, wrong JSON
    types).  Collects **all** structural errors before raising.

    Prefer :func:`load_plan` which also runs semantic validation in one pass.

    :raises PlanValidationError: if any structural errors are found.
    """
    errors: list[PlanError] = []

    if not isinstance(data, dict):
        errors.append(
            PlanError(path="", code=CODE_NON_OBJECT, message="plan must be a JSON object")
        )
        raise PlanValidationError(errors)

    if "items" not in data:
        errors.append(
            PlanError(
                path="",
                code=CODE_MISSING_ITEMS,
                message="plan must have an 'items' key",
            )
        )
        raise PlanValidationError(errors)

    raw_items = data["items"]
    if not isinstance(raw_items, list):
        errors.append(
            PlanError(
                path="items",
                code=CODE_WRONG_TYPE,
                message="'items' must be a list",
            )
        )
        raise PlanValidationError(errors)

    items = _parse_item_list(raw_items, "items", is_root=True, errors=errors)

    if errors:
        raise PlanValidationError(errors)

    return ApplyPlan(items=items)


def _parse_item_list(
    raw_list: list,
    path_prefix: str,
    *,
    is_root: bool,
    errors: list[PlanError],
) -> list[PlanItem]:
    """Parse a list of raw item dicts, collecting errors."""
    items: list[PlanItem] = []
    for idx, raw in enumerate(raw_list):
        item_path = f"{path_prefix}[{idx}]"
        item = _parse_one_item(raw, item_path, is_root=is_root, errors=errors)
        if item is not None:
            items.append(item)
    return items


def _parse_one_item(
    raw: object,
    path: str,
    *,
    is_root: bool,
    errors: list[PlanError],
) -> PlanItem | None:
    """Parse one item dict.  Returns None if the item itself is not parseable."""
    if not isinstance(raw, dict):
        errors.append(
            PlanError(
                path=path,
                code=CODE_NON_OBJECT,
                message=f"item must be a JSON object, got {type(raw).__name__!r}",
            )
        )
        return None

    # Unknown fields
    unknown = sorted(set(raw) - _ITEM_FIELDS)
    if unknown:
        errors.append(
            PlanError(
                path=path,
                code=CODE_UNKNOWN_FIELD,
                message=f"unknown field(s): {', '.join(unknown)}; allowed: {sorted(_ITEM_FIELDS)}",
            )
        )

    # Missing required fields: type and title must be present (not just non-empty)
    missing = [f for f in ("type", "title") if f not in raw]
    if missing:
        errors.append(
            PlanError(
                path=path,
                code=CODE_MISSING_FIELD,
                message=f"missing required field(s): {', '.join(missing)}",
            )
        )

    # Wrong JSON types for specific fields
    if "tags" in raw and not isinstance(raw["tags"], list):
        errors.append(
            PlanError(
                path=path,
                code=CODE_WRONG_TYPE,
                message=f"tags must be a list, got {type(raw['tags']).__name__!r}",
            )
        )

    if "children" in raw and not isinstance(raw["children"], list):
        errors.append(
            PlanError(
                path=path,
                code=CODE_WRONG_TYPE,
                message=f"children must be a list, got {type(raw['children']).__name__!r}",
            )
        )

    # Parse children recursively (even if there are field errors above)
    children: list[PlanItem] = []
    raw_children = raw.get("children")
    if isinstance(raw_children, list):
        children = _parse_item_list(raw_children, f"{path}.children", is_root=False, errors=errors)

    # Build PlanItem — use defaults for missing/bad fields so we can continue
    item_type = raw.get("type", "")
    item_title = raw.get("title")  # None when absent; "" when explicit empty
    item_ref = raw.get("ref")
    item_parent = raw.get("parent")  # preserved for all items; validate_plan checks children
    item_body = raw.get("body", "")
    item_assignee = raw.get("assignee")
    item_tags = raw.get("tags", []) if isinstance(raw.get("tags", []), list) else []
    item_status = raw.get("status", "ready")

    return PlanItem(
        type=item_type,
        title=item_title,
        parent=item_parent,
        ref=item_ref,
        body=item_body,
        assignee=item_assignee,
        tags=item_tags,
        status=item_status,
        children=children,
    )


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


def validate_plan(
    plan: ApplyPlan,
    *,
    get_item_type: Callable[[str], str | None],
) -> None:
    """Validate *plan* without writing anything.

    Collects **all** errors in one pass and raises
    :class:`PlanValidationError` if any are found.

    Prefer :func:`load_plan` which combines structural and semantic validation.

    :param get_item_type: Callable that resolves an existing qid to its
        type string (``"project"``, ``"epic"``, etc.) or ``None`` when
        not found.  Called only for ``parent`` values on root items.
    """
    errors: list[PlanError] = []
    seen_refs: set[str] = set()

    for idx, item in enumerate(plan.items):
        _validate_item(
            item,
            path=f"items[{idx}]",
            parent_type=None,  # None means "root" — must supply own parent
            is_root=True,
            errors=errors,
            seen_refs=seen_refs,
            get_item_type=get_item_type,
        )

    if errors:
        raise PlanValidationError(errors)


def _validate_item(
    item: PlanItem,
    path: str,
    parent_type: str | None,
    *,
    is_root: bool,
    errors: list[PlanError],
    seen_refs: set[str],
    get_item_type: Callable[[str], str | None],
) -> None:
    """Recursively validate one item, appending to *errors*.

    If item.type is empty string (absent from raw dict — missing_field already
    reported by parse), skip type-dependent semantic checks to avoid cascade
    noise, but still validate other fields and recurse into children.
    """

    # --- type ---
    if item.type not in _ALLOWED_TYPES:
        if item.type:
            # Non-empty bad type value — report bad_type
            errors.append(
                PlanError(
                    path=path,
                    code=CODE_BAD_TYPE,
                    message=(
                        f"invalid type {item.type!r}; must be one of {sorted(_ALLOWED_TYPES)}"
                    ),
                )
            )
        # item.type == "" means it was absent (missing_field already reported by parse);
        # skip the bad_type error to avoid double-reporting.
        effective_type = None
    else:
        effective_type = item.type

    # --- title ---
    # Absent title: parse_plan already reported missing_field; title is None.
    #   Skip the empty_title semantic check for absent titles to avoid double-reporting
    #   one defect as two errors.  empty_title fires only when title is present-but-blank
    #   (explicit "" or whitespace-only string).
    if item.title is not None and not item.title.strip():
        errors.append(
            PlanError(
                path=path,
                code=CODE_EMPTY_TITLE,
                message="title must be a non-empty string",
            )
        )

    # --- ref uniqueness ---
    if item.ref is not None:
        if item.ref in seen_refs:
            errors.append(
                PlanError(
                    path=path,
                    code=CODE_DUPLICATE_REF,
                    message=(
                        f"duplicate ref {item.ref!r}; refs must be unique across the whole plan"
                    ),
                )
            )
        else:
            seen_refs.add(item.ref)

    # --- parent rules ---
    if is_root:
        # Root items MUST have a parent qid
        if item.parent is None:
            errors.append(
                PlanError(
                    path=path,
                    code=CODE_MISSING_PARENT,
                    message="root item must have a 'parent' field (an existing qid)",
                )
            )
            resolved_parent_type = None
        else:
            # Resolve to a store type
            resolved = get_item_type(item.parent)
            if resolved is None:
                errors.append(
                    PlanError(
                        path=path,
                        code=CODE_UNKNOWN_PARENT,
                        message=(
                            f"unknown parent qid {item.parent!r}; "
                            "must be an existing item qid in the store"
                        ),
                    )
                )
                resolved_parent_type = None
            else:
                resolved_parent_type = resolved
    else:
        # Nested children must NOT have a parent field
        if item.parent is not None:
            errors.append(
                PlanError(
                    path=path,
                    code=CODE_PARENT_ON_CHILD,
                    message=(
                        f"child item must not have a 'parent' field "
                        f"(got {item.parent!r}); nesting is the parent relationship"
                    ),
                )
            )
        resolved_parent_type = parent_type

    # --- nesting / children validation ---
    # Only check nesting if we have a valid effective_type (not absent/bad)
    if effective_type is not None and resolved_parent_type is not None:
        allowed = _VALID_CHILDREN.get(resolved_parent_type, set())
        if effective_type not in allowed:
            errors.append(
                PlanError(
                    path=path,
                    code=CODE_BAD_NESTING,
                    message=(
                        f"type {effective_type!r} cannot be nested under "
                        f"{resolved_parent_type!r}; allowed children: {sorted(allowed) or 'none'}"
                    ),
                )
            )

    # --- children on task ---
    # Report at the path of the task that CARRIES the children field, not at the
    # children themselves.  One error per offending task; do not cascade into the
    # task's children (the defect is on the task, not on what it contains).
    if effective_type == "task" and item.children:
        errors.append(
            PlanError(
                path=path,
                code=CODE_CHILDREN_ON_TASK,
                message="tasks cannot have children; tasks are leaf items",
            )
        )
        # Don't recurse into invalid children of tasks
        return

    # --- recurse into children ---
    child_parent_type = effective_type  # children's enclosure type
    for ci, child in enumerate(item.children):
        child_path = f"{path}.children[{ci}]"
        _validate_item(
            child,
            path=child_path,
            parent_type=child_parent_type,
            is_root=False,
            errors=errors,
            seen_refs=seen_refs,
            get_item_type=get_item_type,
        )


# ---------------------------------------------------------------------------
# Execution
# ---------------------------------------------------------------------------


def execute_plan(
    plan: ApplyPlan,
    root: Path,
    *,
    get_item: Callable[[str], object],  # returns Item or raises NotFound
) -> ApplyResult:
    """Execute *plan* depth-first, creating items one by one.

    Returns :class:`ApplyResult` on full success.
    Raises :class:`PartialApplyError` if any creation fails mid-plan —
    items already created remain (no rollback), and the partial list is
    attached to the exception.

    :param plan: A validated :class:`ApplyPlan`.
    :param root: The loom root directory (``$LOOM_DIR``).
    :param get_item: Callable that resolves a qid to an Item.
    """
    created: list[dict] = []
    # ref -> created qid (populated as we go)
    ref_to_qid: dict[str, str] = {}

    for item in plan.items:
        _execute_item(
            item,
            parent_qid=item.parent,  # root items supply their own parent qid
            created=created,
            ref_to_qid=ref_to_qid,
            get_item=get_item,
        )

    return ApplyResult(created=created)


def _execute_item(
    item: PlanItem,
    parent_qid: str,
    *,
    created: list[dict],
    ref_to_qid: dict[str, str],
    get_item: Callable[[str], object],
) -> None:
    """Create one item depth-first, then recurse into children."""
    from .ids import BACKLOG_EPIC_ID
    from .items import Epic, Project, Story

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

    # Recurse depth-first into children
    for child in item.children:
        _execute_item(
            child,
            parent_qid=created_item.qualified_id,
            created=created,
            ref_to_qid=ref_to_qid,
            get_item=get_item,
        )
