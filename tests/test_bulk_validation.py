"""Tests for loom apply plan schema + pre-write validation.

RED phase: all tests must fail before any implementation is written.
"""

from __future__ import annotations

import pytest

from loom.bulk import (
    ApplyPlan,
    PlanItem,
    validate_plan,
)
from loom.errors import (
    Duplicate,
    LoomError,
    NotFound,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _plan(*items: dict) -> ApplyPlan:
    return ApplyPlan(items=[PlanItem(**i) for i in items])


# ---------------------------------------------------------------------------
# PlanItem construction
# ---------------------------------------------------------------------------


def test_plan_item_required_fields() -> None:
    item = PlanItem(type="epic", parent="myproj", title="My Epic")
    assert item.type == "epic"
    assert item.parent == "myproj"
    assert item.title == "My Epic"
    assert item.ref is None
    assert item.body == ""
    assert item.assignee is None
    assert item.tags == []
    assert item.status == "ready"


def test_plan_item_with_ref_and_optional_fields() -> None:
    item = PlanItem(
        ref="e1",
        type="epic",
        parent="proj",
        title="Epic",
        body="body text",
        assignee="alice",
        tags=["tag1", "tag2"],
        status="blocked",
    )
    assert item.ref == "e1"
    assert item.assignee == "alice"
    assert item.tags == ["tag1", "tag2"]
    assert item.status == "blocked"


# ---------------------------------------------------------------------------
# validate_plan: happy-path (no loom store needed)
# ---------------------------------------------------------------------------


def test_validate_plan_empty_list_ok() -> None:
    """Empty plan is valid."""
    plan = ApplyPlan(items=[])
    validate_plan(plan, get_item_type=lambda qid: None)  # no store calls expected


def test_validate_plan_single_epic_against_existing_project(loom_dir) -> None:
    """Epic whose parent is an existing project qid passes."""
    from loom.api import Loom

    loom = Loom(root=loom_dir)
    loom.create_project("myproj", title="My Project")

    plan = _plan(
        {"ref": "e1", "type": "epic", "parent": "myproj", "title": "An Epic"},
    )

    # Should not raise
    def _get_type(qid: str) -> str | None:
        item = loom.get_or_none(qid)
        return item.type if item else None

    validate_plan(plan, get_item_type=_get_type)


# ---------------------------------------------------------------------------
# validate_plan: duplicate ref
# ---------------------------------------------------------------------------


def test_validate_plan_rejects_duplicate_ref() -> None:
    plan = _plan(
        {"ref": "e1", "type": "epic", "parent": "myproj", "title": "Epic 1"},
        {"ref": "e1", "type": "epic", "parent": "myproj", "title": "Epic 2"},
    )
    with pytest.raises(Duplicate):
        validate_plan(plan, get_item_type=lambda qid: "project" if qid == "myproj" else None)


# ---------------------------------------------------------------------------
# validate_plan: missing / empty title
# ---------------------------------------------------------------------------


def test_validate_plan_rejects_empty_title() -> None:
    plan = _plan({"type": "epic", "parent": "myproj", "title": ""})
    with pytest.raises(LoomError, match="title"):
        validate_plan(plan, get_item_type=lambda qid: "project" if qid == "myproj" else None)


def test_validate_plan_rejects_whitespace_only_title() -> None:
    plan = _plan({"type": "epic", "parent": "myproj", "title": "   "})
    with pytest.raises(LoomError, match="title"):
        validate_plan(plan, get_item_type=lambda qid: "project" if qid == "myproj" else None)


# ---------------------------------------------------------------------------
# validate_plan: bad type
# ---------------------------------------------------------------------------


def test_validate_plan_rejects_project_type() -> None:
    plan = _plan({"type": "project", "parent": "myproj", "title": "Oops"})
    with pytest.raises(LoomError, match="type"):
        validate_plan(plan, get_item_type=lambda qid: "project" if qid == "myproj" else None)


def test_validate_plan_rejects_unknown_type() -> None:
    plan = _plan({"type": "bogus", "parent": "myproj", "title": "Oops"})
    with pytest.raises(LoomError, match="type"):
        validate_plan(plan, get_item_type=lambda qid: "project" if qid == "myproj" else None)


# ---------------------------------------------------------------------------
# validate_plan: type/parent incompatibility
# ---------------------------------------------------------------------------


def test_validate_plan_rejects_epic_with_epic_parent() -> None:
    """Epics must be parented on projects, not other epics."""
    plan = _plan(
        {"ref": "e1", "type": "epic", "parent": "myproj", "title": "E1"},
        {"type": "epic", "parent": "e1", "title": "Nested epic"},
    )
    with pytest.raises(LoomError, match=r"[Pp]arent|[Tt]ype"):
        validate_plan(plan, get_item_type=lambda qid: "project" if qid == "myproj" else None)


def test_validate_plan_rejects_story_with_task_parent() -> None:
    """Stories must be parented on epics or projects (via backlog), not tasks."""
    plan = _plan(
        {"ref": "e1", "type": "epic", "parent": "myproj", "title": "E"},
        {"ref": "s1", "type": "story", "parent": "e1", "title": "S"},
        {"ref": "t1", "type": "task", "parent": "s1", "title": "T"},
        {"type": "story", "parent": "t1", "title": "Bad story"},
    )
    with pytest.raises(LoomError, match=r"[Pp]arent|[Tt]ype"):
        validate_plan(plan, get_item_type=lambda qid: "project" if qid == "myproj" else None)


def test_validate_plan_rejects_task_with_epic_parent() -> None:
    """Tasks must be parented on stories only."""
    plan = _plan(
        {"ref": "e1", "type": "epic", "parent": "myproj", "title": "E"},
        {"type": "task", "parent": "e1", "title": "Bad task"},
    )
    with pytest.raises(LoomError, match=r"[Pp]arent|[Tt]ype"):
        validate_plan(plan, get_item_type=lambda qid: "project" if qid == "myproj" else None)


def test_validate_plan_rejects_task_with_project_parent() -> None:
    """Tasks cannot be directly parented on projects."""
    plan = _plan({"type": "task", "parent": "myproj", "title": "Bad task"})
    with pytest.raises(LoomError, match=r"[Pp]arent|[Tt]ype"):
        validate_plan(plan, get_item_type=lambda qid: "project" if qid == "myproj" else None)


def test_validate_plan_story_with_project_parent_ok() -> None:
    """A story parented on a project targets the backlog epic (valid)."""
    plan = _plan(
        {"type": "story", "parent": "myproj", "title": "Story on backlog"},
    )
    # Should not raise - project parent for story is allowed (backlog targeting).
    validate_plan(plan, get_item_type=lambda qid: "project" if qid == "myproj" else None)


# ---------------------------------------------------------------------------
# validate_plan: unknown parent ref / qid
# ---------------------------------------------------------------------------


def test_validate_plan_rejects_unknown_parent_ref() -> None:
    """Parent ref that was never defined in the plan is rejected."""
    plan = _plan({"type": "story", "parent": "nonexistent_ref", "title": "Story"})
    with pytest.raises(NotFound):
        validate_plan(plan, get_item_type=lambda qid: None)


def test_validate_plan_rejects_unknown_parent_qid() -> None:
    """Parent qid that doesn't exist in the store is rejected."""
    plan = _plan({"type": "epic", "parent": "ghost-proj", "title": "Epic"})
    with pytest.raises(NotFound):
        validate_plan(plan, get_item_type=lambda qid: None)


# ---------------------------------------------------------------------------
# validate_plan: forward ref (parent ref defined later in list)
# ---------------------------------------------------------------------------


def test_validate_plan_rejects_forward_ref_parent() -> None:
    """Parent ref defined later in the list (forward reference) is rejected."""
    plan = _plan(
        # s1 references e1 which comes AFTER it
        {"ref": "s1", "type": "story", "parent": "e1", "title": "Story"},
        {"ref": "e1", "type": "epic", "parent": "myproj", "title": "Epic"},
    )
    with pytest.raises(NotFound):
        validate_plan(plan, get_item_type=lambda qid: "project" if qid == "myproj" else None)


# ---------------------------------------------------------------------------
# validate_plan: chained refs (story -> epic ref -> project qid)
# ---------------------------------------------------------------------------


def test_validate_plan_chained_refs_ok() -> None:
    """story -> epic ref -> project qid chain resolves correctly."""
    plan = _plan(
        {"ref": "e1", "type": "epic", "parent": "myproj", "title": "E"},
        {"ref": "s1", "type": "story", "parent": "e1", "title": "S"},
        {"type": "task", "parent": "s1", "title": "T"},
    )
    # Should not raise
    validate_plan(plan, get_item_type=lambda qid: "project" if qid == "myproj" else None)


# ---------------------------------------------------------------------------
# validate_plan: existing qid as parent
# ---------------------------------------------------------------------------


def test_validate_plan_story_with_existing_epic_qid_parent(loom_dir) -> None:
    """Story parented on an existing epic qid is valid."""
    from loom.api import Loom

    loom = Loom(root=loom_dir)
    proj = loom.create_project("p", title="P")
    epic = proj.create_epic(title="E")

    plan = _plan(
        {"type": "story", "parent": epic.qualified_id, "title": "S"},
    )

    def _get_type(qid: str) -> str | None:
        item = loom.get_or_none(qid)
        return item.type if item else None

    validate_plan(plan, get_item_type=_get_type)
