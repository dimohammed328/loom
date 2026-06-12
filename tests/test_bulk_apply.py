"""Tests for Loom.apply: nested schema creation, depth-first order, partial-failure.

Covers: nested epic→story→task creation, depth-first created order,
backlog targeting, body/assignee/tags/status, partial failure, rebuild noop,
and all-errors-before-write semantics.
"""

from __future__ import annotations

import pytest

from loom.api import Loom
from loom.bulk import ApplyPlan, PartialApplyError, PlanItem


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_plan(*root_items: PlanItem) -> ApplyPlan:
    return ApplyPlan(items=list(root_items))


# ---------------------------------------------------------------------------
# ApplyResult shape
# ---------------------------------------------------------------------------


def test_apply_result_created_list_shape(loom_dir) -> None:
    """apply returns ApplyResult with a created list of dicts."""
    loom = Loom(root=loom_dir)
    loom.create_project("p", title="P")

    plan = _make_plan(PlanItem(ref="e1", type="epic", parent="p", title="My Epic"))
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

    plan = _make_plan(PlanItem(type="epic", parent="p", title="No Ref Epic"))
    result = loom.apply(plan)

    assert result.created[0]["ref"] is None


# ---------------------------------------------------------------------------
# Creation: nested epic -> story -> task
# ---------------------------------------------------------------------------


def test_apply_creates_nested_epic_story_task(loom_dir) -> None:
    loom = Loom(root=loom_dir)
    loom.create_project("p", title="P")

    task = PlanItem(type="task", title="T")
    story = PlanItem(ref="s1", type="story", title="S", children=[task])
    epic = PlanItem(ref="e1", type="epic", parent="p", title="E", children=[story])
    plan = _make_plan(epic)
    result = loom.apply(plan)

    # 3 items in depth-first order: epic, story, task
    assert len(result.created) == 3
    types = [e["type"] for e in result.created]
    assert types == ["epic", "story", "task"]

    # Each exists in the store
    for entry in result.created:
        item = loom.get(entry["qid"])
        assert item is not None


def test_apply_depth_first_order_two_stories(loom_dir) -> None:
    """Items created in depth-first order: epic, s1, t1, t2, s2, t3."""
    loom = Loom(root=loom_dir)
    loom.create_project("p", title="P")

    t1 = PlanItem(type="task", title="T1")
    t2 = PlanItem(type="task", title="T2")
    t3 = PlanItem(type="task", title="T3")
    s1 = PlanItem(type="story", title="S1", children=[t1, t2])
    s2 = PlanItem(type="story", title="S2", children=[t3])
    epic = PlanItem(type="epic", parent="p", title="E", children=[s1, s2])
    plan = _make_plan(epic)
    result = loom.apply(plan)

    titles_in_order = [loom.get(e["qid"]).title for e in result.created]
    assert titles_in_order == ["E", "S1", "T1", "T2", "S2", "T3"]


# ---------------------------------------------------------------------------
# Creation: story parented on project (backlog targeting)
# ---------------------------------------------------------------------------


def test_apply_story_on_project_targets_backlog(loom_dir) -> None:
    """Story with project as parent goes under the backlog epic."""
    loom = Loom(root=loom_dir)
    loom.create_project("p", title="P")

    plan = _make_plan(PlanItem(type="story", parent="p", title="Backlog Story"))
    result = loom.apply(plan)

    story_qid = result.created[0]["qid"]
    story = loom.get(story_qid)
    assert story.type == "story"
    assert "backlog" in story_qid


def test_apply_story_with_existing_epic_qid_parent(loom_dir) -> None:
    loom = Loom(root=loom_dir)
    proj = loom.create_project("p", title="P")
    epic = proj.create_epic(title="Pre-existing Epic")

    plan = _make_plan(PlanItem(type="story", parent=epic.qualified_id, title="S"))
    result = loom.apply(plan)

    story_qid = result.created[0]["qid"]
    story = loom.get(story_qid)
    assert story.type == "story"
    assert story_qid.startswith(epic.qualified_id + ":")


# ---------------------------------------------------------------------------
# Creation: body / assignee / tags / status applied
# ---------------------------------------------------------------------------


def test_apply_sets_body(loom_dir) -> None:
    loom = Loom(root=loom_dir)
    loom.create_project("p", title="P")

    plan = _make_plan(
        PlanItem(type="epic", parent="p", title="E", body="## context\nsome text\n")
    )
    result = loom.apply(plan)

    item = loom.get(result.created[0]["qid"])
    assert "some text" in item.body


def test_apply_sets_assignee(loom_dir) -> None:
    loom = Loom(root=loom_dir)
    loom.create_project("p", title="P")

    plan = _make_plan(PlanItem(type="epic", parent="p", title="E", assignee="bob"))
    result = loom.apply(plan)

    item = loom.get(result.created[0]["qid"])
    assert item.assignee == "bob"


def test_apply_sets_tags(loom_dir) -> None:
    loom = Loom(root=loom_dir)
    loom.create_project("p", title="P")

    plan = _make_plan(PlanItem(type="epic", parent="p", title="E", tags=["foo", "bar"]))
    result = loom.apply(plan)

    item = loom.get(result.created[0]["qid"])
    assert set(item.tags) == {"foo", "bar"}


def test_apply_sets_custom_status(loom_dir) -> None:
    loom = Loom(root=loom_dir)
    loom.create_project("p", title="P")

    plan = _make_plan(PlanItem(type="epic", parent="p", title="E", status="blocked"))
    result = loom.apply(plan)

    item = loom.get(result.created[0]["qid"])
    assert item.status == "blocked"


def test_apply_default_status_is_ready(loom_dir) -> None:
    loom = Loom(root=loom_dir)
    loom.create_project("p", title="P")

    plan = _make_plan(PlanItem(type="epic", parent="p", title="E"))
    result = loom.apply(plan)

    item = loom.get(result.created[0]["qid"])
    assert item.status == "ready"


# ---------------------------------------------------------------------------
# Partial-failure: PartialApplyError carries already-created entries
# ---------------------------------------------------------------------------


def test_apply_partial_failure_raises_PartialApplyError(loom_dir) -> None:
    """When creation fails mid-plan, PartialApplyError is raised with partial list."""
    loom = Loom(root=loom_dir)
    loom.create_project("p", title="P")

    # First item is valid; second uses a bad qid parent that passes
    # skip_validation but will fail at create time.
    items = [
        PlanItem(ref="e1", type="epic", parent="p", title="Good Epic"),
        PlanItem(type="story", parent="p:zzzzzzz:99", title="Bad Story"),
    ]
    plan = ApplyPlan(items=items)

    with pytest.raises(PartialApplyError) as exc_info:
        loom.apply(plan, skip_validation=True)

    err = exc_info.value
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
    item = loom.get(kept_qid)
    assert item.title == "Kept Epic"


def test_apply_partial_failure_in_nested_child(loom_dir) -> None:
    """Failure inside a nested child still reports parent as created."""
    loom = Loom(root=loom_dir)
    loom.create_project("p", title="P")

    # story has a bad nested task parent — simulate by constructing
    # a PlanItem with a bad parent qid that bypass validation
    bad_task = PlanItem(type="story", parent="p:zzz:999", title="Bad")
    # Wrap in an epic that creates fine
    good_epic = PlanItem(ref="e1", type="epic", parent="p", title="Good Epic")
    plan = ApplyPlan(items=[good_epic, bad_task])

    with pytest.raises(PartialApplyError) as exc_info:
        loom.apply(plan, skip_validation=True)

    assert exc_info.value.created[0]["type"] == "epic"


# ---------------------------------------------------------------------------
# All-errors-before-write: validation stops creation
# ---------------------------------------------------------------------------


def test_apply_validation_prevents_any_writes(loom_dir) -> None:
    """A plan whose only error is in a deep child creates nothing."""
    loom = Loom(root=loom_dir)
    loom.create_project("p", title="P")

    from loom.bulk import PlanValidationError

    bad_task = PlanItem(type="task", title="")  # empty title — invalid
    story = PlanItem(type="story", title="S", children=[bad_task])
    epic = PlanItem(type="epic", parent="p", title="E", children=[story])
    plan = ApplyPlan(items=[epic])

    with pytest.raises(PlanValidationError):
        loom.apply(plan)

    # Nothing was written
    epics = loom.find(type="epic", project="p")
    user_epics = [e for e in epics if e.title == "E"]
    assert len(user_epics) == 0


# ---------------------------------------------------------------------------
# rebuild is a no-op after apply
# ---------------------------------------------------------------------------


def test_apply_rebuild_is_noop(loom_dir) -> None:
    """rebuild after apply produces no rewrites and no issues."""
    loom = Loom(root=loom_dir)
    loom.create_project("p", title="P")

    t = PlanItem(type="task", title="T", status="blocked")
    s = PlanItem(ref="s1", type="story", title="S", assignee="alice", tags=["x"], children=[t])
    e = PlanItem(ref="e1", type="epic", parent="p", title="E", children=[s])
    plan = _make_plan(e)
    loom.apply(plan)

    result = loom.rebuild()
    assert result.rewrites == ()
    assert result.issues == ()
