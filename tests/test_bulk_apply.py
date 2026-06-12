"""Tests for Loom.apply: creation in file order, created mapping, partial-failure.

RED phase: all tests must fail before apply() is implemented.
"""

from __future__ import annotations

import pytest

from loom.api import Loom
from loom.bulk import ApplyPlan, PartialApplyError, PlanItem

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _plan(*items: dict) -> ApplyPlan:
    return ApplyPlan(items=[PlanItem(**i) for i in items])


# ---------------------------------------------------------------------------
# ApplyResult shape
# ---------------------------------------------------------------------------


def test_apply_result_created_list_shape(loom_dir) -> None:
    """apply returns ApplyResult with a created list of dicts."""
    loom = Loom(root=loom_dir)
    loom.create_project("p", title="P")

    plan = _plan({"ref": "e1", "type": "epic", "parent": "p", "title": "My Epic"})
    result = loom.apply(plan)

    assert len(result.created) == 1
    entry = result.created[0]
    assert entry["ref"] == "e1"
    assert entry["type"] == "epic"
    assert "qid" in entry
    assert entry["qid"].startswith("p:")


def test_apply_result_ref_is_null_when_absent(loom_dir) -> None:
    """Items without ref produce ref=null in the created mapping."""
    loom = Loom(root=loom_dir)
    loom.create_project("p", title="P")

    plan = _plan({"type": "epic", "parent": "p", "title": "No Ref Epic"})
    result = loom.apply(plan)

    assert result.created[0]["ref"] is None


# ---------------------------------------------------------------------------
# Creation: single items
# ---------------------------------------------------------------------------


def test_apply_creates_epic(loom_dir) -> None:
    loom = Loom(root=loom_dir)
    loom.create_project("p", title="P")

    plan = _plan({"ref": "e1", "type": "epic", "parent": "p", "title": "New Epic"})
    result = loom.apply(plan)

    qid = result.created[0]["qid"]
    item = loom.get(qid)
    assert item.title == "New Epic"
    assert item.type == "epic"


def test_apply_creates_story_under_epic_ref(loom_dir) -> None:
    loom = Loom(root=loom_dir)
    loom.create_project("p", title="P")

    plan = _plan(
        {"ref": "e1", "type": "epic", "parent": "p", "title": "E"},
        {"ref": "s1", "type": "story", "parent": "e1", "title": "S"},
    )
    result = loom.apply(plan)

    story_qid = result.created[1]["qid"]
    story = loom.get(story_qid)
    assert story.title == "S"
    assert story.type == "story"


def test_apply_creates_task_under_story_ref(loom_dir) -> None:
    loom = Loom(root=loom_dir)
    loom.create_project("p", title="P")

    plan = _plan(
        {"ref": "e1", "type": "epic", "parent": "p", "title": "E"},
        {"ref": "s1", "type": "story", "parent": "e1", "title": "S"},
        {"type": "task", "parent": "s1", "title": "T"},
    )
    result = loom.apply(plan)

    assert len(result.created) == 3
    task_qid = result.created[2]["qid"]
    task = loom.get(task_qid)
    assert task.title == "T"
    assert task.type == "task"


# ---------------------------------------------------------------------------
# Creation: story parented on project (backlog targeting)
# ---------------------------------------------------------------------------


def test_apply_story_on_project_targets_backlog(loom_dir) -> None:
    """Story with project as parent goes under the backlog epic."""
    loom = Loom(root=loom_dir)
    loom.create_project("p", title="P")

    plan = _plan({"type": "story", "parent": "p", "title": "Backlog Story"})
    result = loom.apply(plan)

    story_qid = result.created[0]["qid"]
    story = loom.get(story_qid)
    assert story.type == "story"
    # backlog epic is "p:backlog"
    assert "backlog" in story_qid


# ---------------------------------------------------------------------------
# Creation: body / assignee / tags / status applied
# ---------------------------------------------------------------------------


def test_apply_sets_body(loom_dir) -> None:
    loom = Loom(root=loom_dir)
    loom.create_project("p", title="P")

    plan = _plan({"type": "epic", "parent": "p", "title": "E", "body": "## context\nsome text\n"})
    result = loom.apply(plan)

    item = loom.get(result.created[0]["qid"])
    assert "some text" in item.body


def test_apply_sets_assignee(loom_dir) -> None:
    loom = Loom(root=loom_dir)
    loom.create_project("p", title="P")

    plan = _plan({"type": "epic", "parent": "p", "title": "E", "assignee": "bob"})
    result = loom.apply(plan)

    item = loom.get(result.created[0]["qid"])
    assert item.assignee == "bob"


def test_apply_sets_tags(loom_dir) -> None:
    loom = Loom(root=loom_dir)
    loom.create_project("p", title="P")

    plan = _plan({"type": "epic", "parent": "p", "title": "E", "tags": ["foo", "bar"]})
    result = loom.apply(plan)

    item = loom.get(result.created[0]["qid"])
    assert set(item.tags) == {"foo", "bar"}


def test_apply_sets_custom_status(loom_dir) -> None:
    loom = Loom(root=loom_dir)
    loom.create_project("p", title="P")

    plan = _plan({"type": "epic", "parent": "p", "title": "E", "status": "blocked"})
    result = loom.apply(plan)

    item = loom.get(result.created[0]["qid"])
    assert item.status == "blocked"


def test_apply_default_status_is_ready(loom_dir) -> None:
    loom = Loom(root=loom_dir)
    loom.create_project("p", title="P")

    plan = _plan({"type": "epic", "parent": "p", "title": "E"})
    result = loom.apply(plan)

    item = loom.get(result.created[0]["qid"])
    assert item.status == "ready"


# ---------------------------------------------------------------------------
# Creation: full epic->story->task chain in file order
# ---------------------------------------------------------------------------


def test_apply_full_chain_in_file_order(loom_dir) -> None:
    """apply creates 3 items in the order listed and each is findable."""
    loom = Loom(root=loom_dir)
    loom.create_project("p", title="P")

    plan = _plan(
        {"ref": "epic", "type": "epic", "parent": "p", "title": "Epic"},
        {"ref": "s1", "type": "story", "parent": "epic", "title": "Story 1"},
        {"type": "task", "parent": "s1", "title": "Task 1"},
    )
    result = loom.apply(plan)

    assert len(result.created) == 3
    types = [e["type"] for e in result.created]
    assert types == ["epic", "story", "task"]

    # Each item actually exists in the store.
    for entry in result.created:
        item = loom.get(entry["qid"])
        assert item is not None


# ---------------------------------------------------------------------------
# Creation: story -> existing epic qid as parent
# ---------------------------------------------------------------------------


def test_apply_story_with_existing_epic_qid_parent(loom_dir) -> None:
    loom = Loom(root=loom_dir)
    proj = loom.create_project("p", title="P")
    epic = proj.create_epic(title="Pre-existing Epic")

    plan = _plan({"type": "story", "parent": epic.qualified_id, "title": "S"})
    result = loom.apply(plan)

    story_qid = result.created[0]["qid"]
    story = loom.get(story_qid)
    assert story.type == "story"
    # Story lives under the pre-existing epic
    assert story_qid.startswith(epic.qualified_id + ":")


# ---------------------------------------------------------------------------
# Partial-failure: PartialApplyError carries already-created entries
# ---------------------------------------------------------------------------


def test_apply_partial_failure_raises_PartialApplyError(loom_dir) -> None:
    """When creation fails mid-plan, PartialApplyError is raised with partial list."""
    loom = Loom(root=loom_dir)
    loom.create_project("p", title="P")

    # First item is valid; second references a ref that resolves to the first
    # but we'll simulate failure by using a bad parent qid for the third item.
    # We construct the plan manually to smuggle in an unknown qid at position 2.
    items = [
        PlanItem(ref="e1", type="epic", parent="p", title="Good Epic"),
        # This item has a bad qid parent that passes validation (we bypass validate)
        # but will fail at create time — we use a ghost qid for story parent.
        PlanItem(type="story", parent="p:zzzzzzz:99", title="Bad Story"),
    ]
    plan = ApplyPlan(items=items)

    with pytest.raises(PartialApplyError) as exc_info:
        loom.apply(plan, skip_validation=True)

    err = exc_info.value
    # The epic was created before the failure.
    assert len(err.created) == 1
    assert err.created[0]["type"] == "epic"


def test_apply_partial_failure_no_rollback(loom_dir) -> None:
    """Items created before the failure stay in the store (no rollback)."""
    loom = Loom(root=loom_dir)
    loom.create_project("p", title="P")

    items = [
        PlanItem(ref="e1", type="epic", parent="p", title="Kept Epic"),
        PlanItem(type="story", parent="p:zzzzzzz:99", title="Bad"),
    ]
    plan = ApplyPlan(items=items)

    with pytest.raises(PartialApplyError) as exc_info:
        loom.apply(plan, skip_validation=True)

    kept_qid = exc_info.value.created[0]["qid"]
    # The already-created epic still exists.
    item = loom.get(kept_qid)
    assert item.title == "Kept Epic"


# ---------------------------------------------------------------------------
# rebuild is a no-op after apply
# ---------------------------------------------------------------------------


def test_apply_rebuild_is_noop(loom_dir) -> None:
    """rebuild after apply produces no rewrites and no issues."""
    loom = Loom(root=loom_dir)
    loom.create_project("p", title="P")

    plan = _plan(
        {"ref": "e1", "type": "epic", "parent": "p", "title": "E"},
        {
            "ref": "s1",
            "type": "story",
            "parent": "e1",
            "title": "S",
            "assignee": "alice",
            "tags": ["x"],
        },
        {"type": "task", "parent": "s1", "title": "T", "status": "blocked"},
    )
    loom.apply(plan)

    result = loom.rebuild()
    assert result.rewrites == ()
    assert result.issues == ()
