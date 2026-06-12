"""Tests for loom apply nested plan schema + collect-all path-indexed validation.

Tests cover: parse_plan, validate_plan, PlanError/PlanValidationError,
multi-error collection, every code constant, nesting cross-checks,
tree-wide ref uniqueness, parent-on-child and missing-parent rejections,
deep-child-error-creates-nothing, and backlog targeting.
"""

from __future__ import annotations

import pytest

from loom.bulk import (
    CODE_BAD_NESTING,
    CODE_BAD_TYPE,
    CODE_CHILDREN_ON_TASK,
    CODE_DUPLICATE_REF,
    CODE_EMPTY_TITLE,
    CODE_MISSING_PARENT,
    CODE_NON_OBJECT,
    CODE_PARENT_ON_CHILD,
    CODE_UNKNOWN_FIELD,
    CODE_UNKNOWN_PARENT,
    ApplyPlan,
    PlanError,
    PlanItem,
    PlanValidationError,
    parse_plan,
    validate_plan,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _project_resolver(proj_qids=("myproj",)):
    """Returns a get_item_type that resolves named projects as 'project'."""
    proj_set = set(proj_qids)
    return lambda qid: "project" if qid in proj_set else None


# ---------------------------------------------------------------------------
# PlanError / PlanValidationError dataclasses
# ---------------------------------------------------------------------------


def test_plan_error_fields() -> None:
    err = PlanError(path="items[0]", code=CODE_BAD_TYPE, message="bad type 'bogus'")
    assert err.path == "items[0]"
    assert err.code == CODE_BAD_TYPE
    assert "bogus" in err.message


def test_plan_validation_error_carries_list() -> None:
    errors = [
        PlanError(path="items[0]", code=CODE_BAD_TYPE, message="bad type"),
        PlanError(path="items[1]", code=CODE_EMPTY_TITLE, message="empty title"),
    ]
    exc = PlanValidationError(errors)
    assert len(exc.errors) == 2
    assert exc.errors[0].code == CODE_BAD_TYPE


# ---------------------------------------------------------------------------
# PlanItem nested shape
# ---------------------------------------------------------------------------


def test_plan_item_root_fields() -> None:
    item = PlanItem(type="epic", parent="myproj", title="My Epic")
    assert item.type == "epic"
    assert item.parent == "myproj"
    assert item.title == "My Epic"
    assert item.ref is None
    assert item.body == ""
    assert item.assignee is None
    assert item.tags == []
    assert item.status == "ready"
    assert item.children == []


def test_plan_item_child_no_parent() -> None:
    child = PlanItem(type="story", title="S", parent=None)
    assert child.parent is None


def test_plan_item_with_children() -> None:
    child = PlanItem(type="task", title="T")
    item = PlanItem(type="story", title="S", children=[child])
    assert len(item.children) == 1
    assert item.children[0].title == "T"


# ---------------------------------------------------------------------------
# parse_plan: structural parsing
# ---------------------------------------------------------------------------


def test_parse_plan_empty_items() -> None:
    plan = parse_plan({"items": []})
    assert isinstance(plan, ApplyPlan)
    assert plan.items == []


def test_parse_plan_nested_structure() -> None:
    data = {
        "items": [
            {
                "ref": "e1",
                "type": "epic",
                "parent": "myproj",
                "title": "Epic",
                "children": [
                    {
                        "type": "story",
                        "title": "Story",
                        "children": [{"type": "task", "title": "Task"}],
                    }
                ],
            }
        ]
    }
    plan = parse_plan(data)
    assert len(plan.items) == 1
    epic = plan.items[0]
    assert epic.type == "epic"
    assert epic.parent == "myproj"
    assert len(epic.children) == 1
    story = epic.children[0]
    assert story.type == "story"
    assert story.parent is None  # children have no parent field
    assert len(story.children) == 1
    assert story.children[0].type == "task"


def test_parse_plan_non_object_item_raises() -> None:
    with pytest.raises(PlanValidationError) as exc_info:
        parse_plan({"items": ["not an object"]})
    errors = exc_info.value.errors
    assert any(e.code == CODE_NON_OBJECT for e in errors)
    assert any("items[0]" in e.path for e in errors)


def test_parse_plan_unknown_field_raises() -> None:
    with pytest.raises(PlanValidationError) as exc_info:
        parse_plan({"items": [{"type": "epic", "parent": "p", "title": "E", "titel": "typo"}]})
    errors = exc_info.value.errors
    assert any(e.code == CODE_UNKNOWN_FIELD for e in errors)
    assert any("titel" in e.message for e in errors)


def test_parse_plan_missing_items_key_raises() -> None:
    """Top-level object missing 'items' key is a structural error."""
    with pytest.raises(PlanValidationError) as exc_info:
        parse_plan({"not_items": []})
    errors = exc_info.value.errors
    assert len(errors) >= 1


def test_parse_plan_tags_not_list_raises() -> None:
    with pytest.raises(PlanValidationError) as exc_info:
        parse_plan({"items": [{"type": "epic", "parent": "p", "title": "E", "tags": "foo"}]})
    errors = exc_info.value.errors
    assert len(errors) >= 1
    assert any("tags" in e.message for e in errors)


def test_parse_plan_children_not_list_raises() -> None:
    with pytest.raises(PlanValidationError) as exc_info:
        parse_plan(
            {"items": [{"type": "epic", "parent": "p", "title": "E", "children": "bad"}]}
        )
    errors = exc_info.value.errors
    assert len(errors) >= 1
    assert any("children" in e.message for e in errors)


def test_parse_plan_collects_multiple_field_errors() -> None:
    """parse_plan collects errors from multiple items in one pass."""
    data = {
        "items": [
            "not an object",  # items[0]
            {"type": "epic", "parent": "p", "title": "E", "titel": "typo"},  # items[1]: unknown
        ]
    }
    with pytest.raises(PlanValidationError) as exc_info:
        parse_plan(data)
    errors = exc_info.value.errors
    # Both errors collected
    assert len(errors) >= 2
    codes = [e.code for e in errors]
    assert CODE_NON_OBJECT in codes
    assert CODE_UNKNOWN_FIELD in codes


# ---------------------------------------------------------------------------
# validate_plan: happy paths
# ---------------------------------------------------------------------------


def test_validate_plan_empty_ok() -> None:
    plan = ApplyPlan(items=[])
    validate_plan(plan, get_item_type=lambda qid: None)  # no errors


def test_validate_plan_single_epic_on_project(loom_dir) -> None:
    from loom.api import Loom

    loom = Loom(root=loom_dir)
    loom.create_project("myproj", title="My Project")

    item = PlanItem(type="epic", parent="myproj", title="Epic")
    plan = ApplyPlan(items=[item])

    def _get_type(qid: str) -> str | None:
        i = loom.get_or_none(qid)
        return i.type if i else None

    validate_plan(plan, get_item_type=_get_type)  # no error


def test_validate_plan_nested_epic_story_task_ok(loom_dir) -> None:
    from loom.api import Loom

    loom = Loom(root=loom_dir)
    loom.create_project("p", title="P")

    task = PlanItem(type="task", title="T")
    story = PlanItem(type="story", title="S", children=[task])
    epic = PlanItem(type="epic", parent="p", title="E", children=[story])
    plan = ApplyPlan(items=[epic])

    def _get_type(qid: str) -> str | None:
        i = loom.get_or_none(qid)
        return i.type if i else None

    validate_plan(plan, get_item_type=_get_type)  # no error


def test_validate_plan_story_on_project_ok() -> None:
    """Story directly on a project is allowed (targets backlog)."""
    item = PlanItem(type="story", parent="p", title="S")
    plan = ApplyPlan(items=[item])
    validate_plan(plan, get_item_type=_project_resolver(["p"]))  # no error


# ---------------------------------------------------------------------------
# validate_plan: missing parent on root
# ---------------------------------------------------------------------------


def test_validate_plan_rejects_root_without_parent() -> None:
    item = PlanItem(type="epic", title="E", parent=None)
    plan = ApplyPlan(items=[item])
    with pytest.raises(PlanValidationError) as exc_info:
        validate_plan(plan, get_item_type=lambda qid: None)
    errors = exc_info.value.errors
    assert any(e.code == CODE_MISSING_PARENT for e in errors)
    assert any("items[0]" in e.path for e in errors)


# ---------------------------------------------------------------------------
# validate_plan: parent on child
# ---------------------------------------------------------------------------


def test_validate_plan_rejects_parent_on_child() -> None:
    """A child item with a 'parent' field set should be rejected."""
    child = PlanItem(type="story", title="S", parent="explicit-parent")
    epic = PlanItem(type="epic", parent="p", title="E", children=[child])
    plan = ApplyPlan(items=[epic])
    with pytest.raises(PlanValidationError) as exc_info:
        validate_plan(plan, get_item_type=_project_resolver(["p"]))
    errors = exc_info.value.errors
    assert any(e.code == CODE_PARENT_ON_CHILD for e in errors)
    assert any("items[0].children[0]" in e.path for e in errors)


# ---------------------------------------------------------------------------
# validate_plan: children on task
# ---------------------------------------------------------------------------


def test_validate_plan_rejects_children_on_task() -> None:
    grandchild = PlanItem(type="task", title="Inner Task")
    task = PlanItem(type="task", title="T", children=[grandchild])
    story = PlanItem(type="story", title="S", children=[task])
    epic = PlanItem(type="epic", parent="p", title="E", children=[story])
    plan = ApplyPlan(items=[epic])
    with pytest.raises(PlanValidationError) as exc_info:
        validate_plan(plan, get_item_type=_project_resolver(["p"]))
    errors = exc_info.value.errors
    assert any(e.code == CODE_CHILDREN_ON_TASK for e in errors)
    assert any("items[0].children[0].children[0]" in e.path for e in errors)


# ---------------------------------------------------------------------------
# validate_plan: bad nesting (type incompatible with enclosure)
# ---------------------------------------------------------------------------


def test_validate_plan_rejects_story_inside_story() -> None:
    inner_story = PlanItem(type="story", title="Inner")
    outer_story = PlanItem(type="story", title="S", children=[inner_story])
    epic = PlanItem(type="epic", parent="p", title="E", children=[outer_story])
    plan = ApplyPlan(items=[epic])
    with pytest.raises(PlanValidationError) as exc_info:
        validate_plan(plan, get_item_type=_project_resolver(["p"]))
    errors = exc_info.value.errors
    assert any(e.code == CODE_BAD_NESTING for e in errors)
    assert any("items[0].children[0].children[0]" in e.path for e in errors)


def test_validate_plan_rejects_epic_inside_epic() -> None:
    inner_epic = PlanItem(type="epic", title="Inner Epic")
    outer_epic = PlanItem(type="epic", parent="p", title="E", children=[inner_epic])
    plan = ApplyPlan(items=[outer_epic])
    with pytest.raises(PlanValidationError) as exc_info:
        validate_plan(plan, get_item_type=_project_resolver(["p"]))
    errors = exc_info.value.errors
    assert any(e.code == CODE_BAD_NESTING for e in errors)


def test_validate_plan_rejects_epic_inside_story() -> None:
    inner_epic = PlanItem(type="epic", title="E2")
    story = PlanItem(type="story", title="S", children=[inner_epic])
    epic = PlanItem(type="epic", parent="p", title="E1", children=[story])
    plan = ApplyPlan(items=[epic])
    with pytest.raises(PlanValidationError) as exc_info:
        validate_plan(plan, get_item_type=_project_resolver(["p"]))
    errors = exc_info.value.errors
    assert any(e.code == CODE_BAD_NESTING for e in errors)


# ---------------------------------------------------------------------------
# validate_plan: bad type value
# ---------------------------------------------------------------------------


def test_validate_plan_rejects_bad_type() -> None:
    item = PlanItem(type="bogus", parent="p", title="X")
    plan = ApplyPlan(items=[item])
    with pytest.raises(PlanValidationError) as exc_info:
        validate_plan(plan, get_item_type=_project_resolver(["p"]))
    errors = exc_info.value.errors
    assert any(e.code == CODE_BAD_TYPE for e in errors)
    assert any("bogus" in e.message for e in errors)


def test_validate_plan_rejects_project_type() -> None:
    item = PlanItem(type="project", parent="p", title="X")
    plan = ApplyPlan(items=[item])
    with pytest.raises(PlanValidationError) as exc_info:
        validate_plan(plan, get_item_type=_project_resolver(["p"]))
    errors = exc_info.value.errors
    assert any(e.code == CODE_BAD_TYPE for e in errors)


# ---------------------------------------------------------------------------
# validate_plan: empty title
# ---------------------------------------------------------------------------


def test_validate_plan_rejects_empty_title() -> None:
    item = PlanItem(type="epic", parent="p", title="")
    plan = ApplyPlan(items=[item])
    with pytest.raises(PlanValidationError) as exc_info:
        validate_plan(plan, get_item_type=_project_resolver(["p"]))
    errors = exc_info.value.errors
    assert any(e.code == CODE_EMPTY_TITLE for e in errors)


def test_validate_plan_rejects_whitespace_only_title() -> None:
    item = PlanItem(type="epic", parent="p", title="   ")
    plan = ApplyPlan(items=[item])
    with pytest.raises(PlanValidationError) as exc_info:
        validate_plan(plan, get_item_type=_project_resolver(["p"]))
    errors = exc_info.value.errors
    assert any(e.code == CODE_EMPTY_TITLE for e in errors)


# ---------------------------------------------------------------------------
# validate_plan: duplicate ref (tree-wide)
# ---------------------------------------------------------------------------


def test_validate_plan_rejects_duplicate_ref_flat() -> None:
    e1 = PlanItem(ref="e1", type="epic", parent="p", title="E1")
    e2 = PlanItem(ref="e1", type="epic", parent="p", title="E2")
    plan = ApplyPlan(items=[e1, e2])
    with pytest.raises(PlanValidationError) as exc_info:
        validate_plan(plan, get_item_type=_project_resolver(["p"]))
    errors = exc_info.value.errors
    assert any(e.code == CODE_DUPLICATE_REF for e in errors)
    assert any("e1" in e.message for e in errors)


def test_validate_plan_rejects_duplicate_ref_across_nesting() -> None:
    """Ref 'r1' appears at root and in a nested child."""
    task = PlanItem(ref="r1", type="task", title="T")
    story = PlanItem(type="story", title="S", children=[task])
    epic = PlanItem(ref="r1", type="epic", parent="p", title="E", children=[story])
    plan = ApplyPlan(items=[epic])
    with pytest.raises(PlanValidationError) as exc_info:
        validate_plan(plan, get_item_type=_project_resolver(["p"]))
    errors = exc_info.value.errors
    assert any(e.code == CODE_DUPLICATE_REF for e in errors)


# ---------------------------------------------------------------------------
# validate_plan: unknown parent qid
# ---------------------------------------------------------------------------


def test_validate_plan_rejects_unknown_parent_qid() -> None:
    item = PlanItem(type="epic", parent="ghost-proj", title="E")
    plan = ApplyPlan(items=[item])
    with pytest.raises(PlanValidationError) as exc_info:
        validate_plan(plan, get_item_type=lambda qid: None)
    errors = exc_info.value.errors
    assert any(e.code == CODE_UNKNOWN_PARENT for e in errors)
    assert any("ghost-proj" in e.message for e in errors)
    assert any("items[0]" in e.path for e in errors)


def test_validate_plan_rejects_ref_as_parent_on_root() -> None:
    """Using a ref as parent on a root item (ref-as-parent is deleted)."""
    # In the nested schema, a ref cannot be used as a root parent.
    # The root parent must be an existing qid.
    item = PlanItem(type="epic", parent="some-ref", title="E")
    plan = ApplyPlan(items=[item])
    # get_item_type returns None for "some-ref" -> unknown parent
    with pytest.raises(PlanValidationError) as exc_info:
        validate_plan(plan, get_item_type=lambda qid: None)
    errors = exc_info.value.errors
    assert any(e.code == CODE_UNKNOWN_PARENT for e in errors)


# ---------------------------------------------------------------------------
# validate_plan: multi-error collection (all errors in one pass)
# ---------------------------------------------------------------------------


def test_validate_plan_collects_all_errors_in_one_pass() -> None:
    """Multiple independent errors are all reported together."""
    # Error 1: bad type at items[0]
    e0 = PlanItem(type="bogus", parent="p", title="X")
    # Error 2: empty title at items[1]
    e1 = PlanItem(type="epic", parent="p", title="")
    # Error 3: unknown parent qid at items[2]
    e2 = PlanItem(type="epic", parent="nonexistent", title="Y")
    plan = ApplyPlan(items=[e0, e1, e2])

    with pytest.raises(PlanValidationError) as exc_info:
        validate_plan(plan, get_item_type=_project_resolver(["p"]))
    errors = exc_info.value.errors
    codes = [e.code for e in errors]
    assert CODE_BAD_TYPE in codes
    assert CODE_EMPTY_TITLE in codes
    assert CODE_UNKNOWN_PARENT in codes
    # All three errors in one pass
    assert len(errors) >= 3


def test_validate_plan_path_indexes_deep_errors() -> None:
    """Errors at different nesting depths carry exact paths."""
    # items[0].children[0].children[1]: story inside story is bad nesting
    task_ok = PlanItem(type="task", title="Good Task")
    bad_story = PlanItem(type="story", title="Wrong")  # story inside story
    story_container = PlanItem(type="story", title="S", children=[task_ok, bad_story])
    epic = PlanItem(type="epic", parent="p", title="E", children=[story_container])
    plan = ApplyPlan(items=[epic])

    with pytest.raises(PlanValidationError) as exc_info:
        validate_plan(plan, get_item_type=_project_resolver(["p"]))
    errors = exc_info.value.errors
    # The bad nesting is at items[0].children[0].children[1]
    paths = [e.path for e in errors]
    assert any("items[0].children[0].children[1]" in p for p in paths)


def test_validate_plan_deep_child_error_still_collects_all() -> None:
    """A deeply nested error is reported alongside shallow errors."""
    deep_task = PlanItem(type="task", title="")  # empty title deep
    story = PlanItem(type="story", title="S", children=[deep_task])
    epic = PlanItem(type="epic", parent="p", title="", children=[story])  # also empty title
    plan = ApplyPlan(items=[epic])
    with pytest.raises(PlanValidationError) as exc_info:
        validate_plan(plan, get_item_type=_project_resolver(["p"]))
    errors = exc_info.value.errors
    assert len(errors) >= 2
    # Root epic empty title
    assert any("items[0]" in e.path and e.code == CODE_EMPTY_TITLE for e in errors)
    # Deep task empty title
    assert any(
        "items[0].children[0].children[0]" in e.path and e.code == CODE_EMPTY_TITLE
        for e in errors
    )


# ---------------------------------------------------------------------------
# validate_plan: story under existing epic qid
# ---------------------------------------------------------------------------


def test_validate_plan_story_with_existing_epic_qid_parent(loom_dir) -> None:
    from loom.api import Loom

    loom = Loom(root=loom_dir)
    proj = loom.create_project("p", title="P")
    epic = proj.create_epic(title="E")

    item = PlanItem(type="story", parent=epic.qualified_id, title="S")
    plan = ApplyPlan(items=[item])

    def _get_type(qid: str) -> str | None:
        i = loom.get_or_none(qid)
        return i.type if i else None

    validate_plan(plan, get_item_type=_get_type)  # no error


# ---------------------------------------------------------------------------
# Code constants are exported
# ---------------------------------------------------------------------------


def test_code_constants_are_strings() -> None:
    codes = [
        CODE_BAD_TYPE,
        CODE_EMPTY_TITLE,
        CODE_DUPLICATE_REF,
        CODE_UNKNOWN_PARENT,
        CODE_MISSING_PARENT,
        CODE_PARENT_ON_CHILD,
        CODE_CHILDREN_ON_TASK,
        CODE_BAD_NESTING,
        CODE_NON_OBJECT,
        CODE_UNKNOWN_FIELD,
    ]
    for c in codes:
        assert isinstance(c, str), f"Expected str code, got {type(c)}: {c!r}"
        assert c  # non-empty
