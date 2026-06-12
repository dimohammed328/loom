"""Phase 4 tests: dependencies, cycle detection, ready, close-if-done."""

from __future__ import annotations

from pathlib import Path

import pytest

from loom import (
    CycleError,
    Loom,
    LoomError,
    NotFound,
)
from loom.deps import (
    ItemRef,
    add_dependency,
    batch_would_create_cycle,
    compute_blockers,
    compute_dependencies,
    compute_dependents,
    descendants,
    is_pickable,
    remove_dependency,
    would_create_cycle,
)
from loom.index import Index

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _build_chain(loom_dir: Path) -> tuple[Loom, str, str, str, str, str]:
    """Build acme/epic/story/(task1, task2). Returns qids."""
    loom = Loom(root=loom_dir)
    project = loom.create_project("acme", title="Acme")
    epic = project.create_epic(title="Auth")
    story = epic.create_story(title="Backend")
    t1 = story.create_task(title="T1")
    t2 = story.create_task(title="T2")
    return (
        loom,
        project.qualified_id,
        epic.qualified_id,
        story.qualified_id,
        t1.qualified_id,
        t2.qualified_id,
    )


# ---------------------------------------------------------------------------
# Add / remove dependency
# ---------------------------------------------------------------------------


def test_add_dependency_round_trip(loom_dir: Path) -> None:
    loom, _proj, _epic, _story, t1, t2 = _build_chain(loom_dir)
    task2 = loom.get(t2)
    task2.depends_on(t1)  # type: ignore[union-attr]
    assert [r.qualified_id for r in task2.dependencies()] == [t1]  # type: ignore[union-attr]

    # Round-trip through frontmatter (source of truth).
    fresh = loom.get(t2)
    assert [r.qualified_id for r in fresh.dependencies()] == [t1]  # type: ignore[union-attr]


def test_add_dependency_idempotent(loom_dir: Path) -> None:
    loom, _proj, _epic, _story, t1, t2 = _build_chain(loom_dir)
    task2 = loom.get(t2)
    task2.depends_on(t1)  # type: ignore[union-attr]
    # Adding again is a no-op, not an error.
    task2.depends_on(t1)  # type: ignore[union-attr]
    assert [r.qualified_id for r in task2.dependencies()] == [t1]  # type: ignore[union-attr]


def test_self_loop_rejected_with_clear_error(loom_dir: Path) -> None:
    loom, _proj, _epic, _story, t1, _t2 = _build_chain(loom_dir)
    task1 = loom.get(t1)
    with pytest.raises(LoomError) as excinfo:
        task1.depends_on(t1)  # type: ignore[union-attr]
    assert "cannot depend on itself" in str(excinfo.value)


def test_simple_cycle_rejected(loom_dir: Path) -> None:
    loom, _proj, _epic, _story, t1, t2 = _build_chain(loom_dir)
    loom.get(t2).depends_on(t1)  # type: ignore[union-attr]
    # Now t1 -> t2 would close the cycle t1 -> t2 -> t1.
    with pytest.raises(CycleError):
        loom.get(t1).depends_on(t2)  # type: ignore[union-attr]


def test_transitive_cycle_rejected(loom_dir: Path) -> None:
    loom = Loom(root=loom_dir)
    p = loom.create_project("acme", title="A")
    e = p.create_epic(title="E")
    s = e.create_story(title="S")
    a = s.create_task(title="ta")
    b = s.create_task(title="tb")
    c = s.create_task(title="tc")
    # a -> b -> c, then c -> a is the closing edge.
    loom.get(a.qualified_id).depends_on(b.qualified_id)  # type: ignore[union-attr]
    loom.get(b.qualified_id).depends_on(c.qualified_id)  # type: ignore[union-attr]
    # Sanity-check the index state before triggering the cycle.
    idx = Index(loom_dir)
    assert idx.dependencies_of(a.qualified_id) == (b.qualified_id,)
    assert idx.dependencies_of(b.qualified_id) == (c.qualified_id,)
    with pytest.raises(CycleError) as excinfo:
        loom.get(c.qualified_id).depends_on(a.qualified_id)  # type: ignore[union-attr]
    assert excinfo.value.cycle[0] == c.qualified_id


def test_depending_on_project_rejected(loom_dir: Path) -> None:
    loom, proj, _epic, _story, t1, _t2 = _build_chain(loom_dir)
    with pytest.raises(LoomError) as excinfo:
        loom.get(t1).depends_on(proj)  # type: ignore[union-attr]
    assert "depending on a project" in str(excinfo.value)


def test_project_cannot_have_dependencies(loom_dir: Path) -> None:
    """Projects don't expose `depends_on` at all (Project class has no method)."""
    loom = Loom(root=loom_dir)
    project = loom.create_project("acme", title="A")
    assert not hasattr(project, "depends_on")
    assert not hasattr(project, "blockers")


def test_remove_nonexistent_dep_raises(loom_dir: Path) -> None:
    loom, _proj, _epic, _story, t1, t2 = _build_chain(loom_dir)
    with pytest.raises(NotFound):
        loom.get(t2).remove_dependency(t1)  # type: ignore[union-attr]


def test_remove_dependency_round_trip(loom_dir: Path) -> None:
    loom, _proj, _epic, _story, t1, t2 = _build_chain(loom_dir)
    task2 = loom.get(t2)
    task2.depends_on(t1)  # type: ignore[union-attr]
    task2.remove_dependency(t1)  # type: ignore[union-attr]
    assert task2.dependencies() == []  # type: ignore[union-attr]
    # depends_on key is removed from frontmatter when list goes empty.
    fresh = loom.get(t2)
    assert fresh.dependencies() == []  # type: ignore[union-attr]


def test_add_dep_to_missing_target_raises(loom_dir: Path) -> None:
    loom, _proj, _epic, _story, t1, _t2 = _build_chain(loom_dir)
    with pytest.raises(NotFound):
        loom.get(t1).depends_on("acme:abcdefg:9:9")  # type: ignore[union-attr]


# ---------------------------------------------------------------------------
# Cross-project dependencies
# ---------------------------------------------------------------------------


def test_cross_project_dependency_allowed(loom_dir: Path) -> None:
    loom = Loom(root=loom_dir)
    p1 = loom.create_project("p1", title="P1")
    p2 = loom.create_project("p2", title="P2")
    e1 = p1.create_epic(title="E1")
    e2 = p2.create_epic(title="E2")
    s1 = e1.create_story(title="S1")
    s2 = e2.create_story(title="S2")

    loom.get(s1.qualified_id).depends_on(s2.qualified_id)  # type: ignore[union-attr]
    deps = loom.get(s1.qualified_id).dependencies()  # type: ignore[union-attr]
    assert [r.qualified_id for r in deps] == [s2.qualified_id]


# ---------------------------------------------------------------------------
# Blockers / dependents / pickability
# ---------------------------------------------------------------------------


def test_blockers_filters_out_done(loom_dir: Path) -> None:
    loom, _proj, _epic, _story, t1, t2 = _build_chain(loom_dir)
    loom.get(t2).depends_on(t1)  # type: ignore[union-attr]
    task2 = loom.get(t2)
    assert [r.qualified_id for r in task2.blockers()] == [t1]  # type: ignore[union-attr]
    loom.get(t1).complete()  # type: ignore[union-attr]
    assert loom.get(t2).blockers() == []  # type: ignore[union-attr]


def test_dependents_reverse_lookup(loom_dir: Path) -> None:
    loom, _proj, _epic, _story, t1, t2 = _build_chain(loom_dir)
    loom.get(t2).depends_on(t1)  # type: ignore[union-attr]
    refs = loom.get(t1).dependents()  # type: ignore[union-attr]
    assert [r.qualified_id for r in refs] == [t2]


def test_is_pickable_no_deps(loom_dir: Path) -> None:
    """Item with status='ready' and zero deps is trivially pickable."""
    loom, _proj, _epic, _story, t1, _t2 = _build_chain(loom_dir)
    assert loom.get(t1).is_pickable() is True  # type: ignore[union-attr]


def test_is_pickable_blocked_by_dep(loom_dir: Path) -> None:
    loom, _proj, _epic, _story, t1, t2 = _build_chain(loom_dir)
    loom.get(t2).depends_on(t1)  # type: ignore[union-attr]
    assert loom.get(t2).is_pickable() is False  # type: ignore[union-attr]
    loom.get(t1).complete()  # type: ignore[union-attr]
    assert loom.get(t2).is_pickable() is True  # type: ignore[union-attr]


def test_is_pickable_blocked_status(loom_dir: Path) -> None:
    loom, _proj, _epic, _story, t1, _t2 = _build_chain(loom_dir)
    loom.get(t1).block()  # type: ignore[union-attr]
    assert loom.get(t1).is_pickable() is False  # type: ignore[union-attr]


def test_is_pickable_archived_excluded(loom_dir: Path) -> None:
    loom, _proj, _epic, _story, t1, _t2 = _build_chain(loom_dir)
    task1 = loom.get(t1)
    task1.archive()
    assert task1.is_pickable() is False  # type: ignore[union-attr]


def test_custom_status_does_not_satisfy_dep(loom_dir: Path) -> None:
    """Only the literal 'done' satisfies. 'completed' (custom) does not."""
    loom, _proj, _epic, _story, t1, t2 = _build_chain(loom_dir)
    loom.get(t2).depends_on(t1)  # type: ignore[union-attr]
    loom.get(t1).set_status("completed")  # custom; not 'done'
    assert loom.get(t2).is_pickable() is False  # type: ignore[union-attr]
    assert [r.qualified_id for r in loom.get(t2).blockers()] == [t1]  # type: ignore[union-attr]


# ---------------------------------------------------------------------------
# Loom.ready
# ---------------------------------------------------------------------------


def test_ready_includes_zero_dep_ready_items(loom_dir: Path) -> None:
    loom, _proj, _epic, _story, t1, t2 = _build_chain(loom_dir)
    ready = {x.qualified_id for x in loom.ready()}
    assert {t1, t2} <= ready


def test_ready_excludes_blocked_by_dep(loom_dir: Path) -> None:
    loom, _proj, _epic, _story, t1, t2 = _build_chain(loom_dir)
    loom.get(t2).depends_on(t1)  # type: ignore[union-attr]
    ready = {x.qualified_id for x in loom.ready(type="task")}
    assert t1 in ready
    assert t2 not in ready

    loom.get(t1).complete()  # type: ignore[union-attr]
    ready_after = {x.qualified_id for x in loom.ready(type="task")}
    assert t2 in ready_after
    assert t1 not in ready_after  # done, not ready


def test_ready_filters_by_type_and_tag_and_limit(loom_dir: Path) -> None:
    loom, _proj, _epic, _story, t1, t2 = _build_chain(loom_dir)
    loom.get(t1).add_tag("hot")  # type: ignore[union-attr]
    typed = {x.qualified_id for x in loom.ready(type="task")}
    assert {t1, t2} <= typed
    tagged = {x.qualified_id for x in loom.ready(tag="hot")}
    assert t1 in tagged and t2 not in tagged
    limited = loom.ready(type="task", limit=1)
    assert len(limited) == 1


def test_ready_excludes_archived(loom_dir: Path) -> None:
    loom, _proj, _epic, _story, t1, _t2 = _build_chain(loom_dir)
    loom.get(t1).archive()  # type: ignore[union-attr]
    qids = {x.qualified_id for x in loom.ready(type="task")}
    assert t1 not in qids


# ---------------------------------------------------------------------------
# close_if_children_done
# ---------------------------------------------------------------------------


def test_close_if_children_done_when_all_done(loom_dir: Path) -> None:
    loom, _proj, epic, story, t1, t2 = _build_chain(loom_dir)
    loom.get(t1).complete()  # type: ignore[union-attr]
    loom.get(t2).complete()  # type: ignore[union-attr]

    # Closing the story closes it (its task children are all done).
    assert loom.close_if_children_done(story) is True
    assert loom.get(story).status == "done"  # type: ignore[union-attr]

    # Now closing the epic closes it (its only descendant — the story — is done).
    assert loom.close_if_children_done(epic) is True
    assert loom.get(epic).status == "done"  # type: ignore[union-attr]


def test_close_if_children_done_partial_no_op(loom_dir: Path) -> None:
    loom, _proj, _epic, story, t1, _t2 = _build_chain(loom_dir)
    loom.get(t1).complete()  # type: ignore[union-attr]
    # t2 not done — story stays open.
    assert loom.close_if_children_done(story) is False
    assert loom.get(story).status != "done"  # type: ignore[union-attr]


def test_close_if_children_done_empty_subtree_returns_false(loom_dir: Path) -> None:
    """Empty containers don't auto-close — caller must use complete() explicitly.

    Locks down the documented behavior so a future "fix" doesn't make
    empty containers close vacuously.
    """
    loom = Loom(root=loom_dir)
    p = loom.create_project("acme", title="A")
    e = p.create_epic(title="E")  # no children
    assert loom.close_if_children_done(e.qualified_id) is False
    assert loom.get(e.qualified_id).status != "done"  # type: ignore[union-attr]


def test_close_if_children_done_treats_empty_child_as_not_done(
    loom_dir: Path,
) -> None:
    """An epic with one empty story is *not* closed (the story isn't done)."""
    loom = Loom(root=loom_dir)
    p = loom.create_project("acme", title="A")
    e = p.create_epic(title="E")
    e.create_story(title="empty")  # ready, no tasks
    assert loom.close_if_children_done(e.qualified_id) is False


def test_close_if_children_done_rejects_task(loom_dir: Path) -> None:
    loom, _proj, _epic, _story, t1, _t2 = _build_chain(loom_dir)
    with pytest.raises(LoomError):
        loom.close_if_children_done(t1)


def test_close_if_children_done_rejects_project(loom_dir: Path) -> None:
    loom, proj, _epic, _story, _t1, _t2 = _build_chain(loom_dir)
    with pytest.raises(LoomError):
        loom.close_if_children_done(proj)


def test_close_if_children_done_unknown_qid(loom_dir: Path) -> None:
    loom = Loom(root=loom_dir)
    with pytest.raises(NotFound):
        loom.close_if_children_done("nope")


# ---------------------------------------------------------------------------
# Lower-level deps helpers
# ---------------------------------------------------------------------------


def test_would_create_cycle_returns_path(loom_dir: Path) -> None:
    loom, _proj, _epic, _story, t1, t2 = _build_chain(loom_dir)
    loom.get(t2).depends_on(t1)  # type: ignore[union-attr]
    cycle = would_create_cycle(Index(loom_dir), t1, t2)
    assert cycle is not None
    assert cycle[0] == t1 and cycle[-1] == t1


def test_would_create_cycle_returns_none_for_safe_edge(loom_dir: Path) -> None:
    _loom, _proj, _epic, _story, t1, t2 = _build_chain(loom_dir)
    assert would_create_cycle(Index(loom_dir), t1, t2) is None


def test_compute_dependencies_dependents_blockers(loom_dir: Path) -> None:
    _loom, _proj, _epic, _story, t1, t2 = _build_chain(loom_dir)
    add_dependency(loom_dir, t2, t1)
    idx = Index(loom_dir)
    deps = compute_dependencies(idx, t2)
    assert all(isinstance(r, ItemRef) for r in deps)
    assert [r.qualified_id for r in deps] == [t1]
    assert [r.qualified_id for r in compute_dependents(idx, t1)] == [t2]
    assert [r.qualified_id for r in compute_blockers(idx, t2)] == [t1]


def test_descendants_of_project_returns_full_subtree(loom_dir: Path) -> None:
    _loom, proj, epic, story, t1, t2 = _build_chain(loom_dir)
    qids = {r.qualified_id for r in descendants(Index(loom_dir), proj)}
    # + backlog auto-creation: create_project also writes acme:backlog.
    assert qids == {epic, story, t1, t2, f"{proj}:backlog"}


def test_descendants_prefix_match_safe_for_underscore_project_names(
    loom_dir: Path,
) -> None:
    """A project named `acme_v2` shouldn't accidentally match `acme:...` items."""
    loom = Loom(root=loom_dir)
    a = loom.create_project("acme", title="A")
    a.create_epic(title="E")
    b = loom.create_project("acme_v2", title="B")
    b.create_epic(title="E")
    qids_a = {r.qualified_id for r in descendants(Index(loom_dir), "acme")}
    assert all(q.startswith("acme:") for q in qids_a)
    assert "acme_v2" not in qids_a


def test_is_pickable_unknown_qid_raises(loom_dir: Path) -> None:
    with pytest.raises(NotFound):
        is_pickable(Index(loom_dir), "no_such_thing")


def test_missing_dep_target_blocks_pickability(loom_dir: Path) -> None:
    """If a dep target was wiped from the index, the source is NOT pickable.

    The cascade-on-delete in the dependencies table can wipe an edge
    when a target item is deleted directly through `Index.delete`. The
    source's frontmatter still claims the dep, though — `is_pickable`
    must read that authoritative claim, not just the table.
    """
    _loom, _proj, _epic, _story, t1, t2 = _build_chain(loom_dir)
    add_dependency(loom_dir, t2, t1)
    idx = Index(loom_dir)
    assert is_pickable(idx, t2) is False  # blocked by t1
    # Out-of-band: drop t1 from the index. The dependencies table edge
    # cascades away too, but the source's frontmatter still claims it.
    idx.delete(t1)
    assert is_pickable(idx, t2) is False  # missing target = broken dep = blocker
    blockers = compute_blockers(idx, t2)
    assert any(b.qualified_id == t1 and b.type == "missing" for b in blockers)


def test_ready_excludes_items_with_broken_dep(loom_dir: Path) -> None:
    """Loom.ready post-filters via is_pickable so broken-dep items are excluded."""
    loom, _proj, _epic, _story, t1, t2 = _build_chain(loom_dir)
    add_dependency(loom_dir, t2, t1)
    Index(loom_dir).delete(t1)
    qids = {x.qualified_id for x in loom.ready(type="task")}
    assert t2 not in qids


def test_remove_dependency_idempotency_via_low_level(loom_dir: Path) -> None:
    _loom, _proj, _epic, _story, t1, t2 = _build_chain(loom_dir)
    add_dependency(loom_dir, t2, t1)
    remove_dependency(loom_dir, t2, t1)
    with pytest.raises(NotFound):
        remove_dependency(loom_dir, t2, t1)


# ---------------------------------------------------------------------------
# batch_would_create_cycle
# ---------------------------------------------------------------------------


def test_batch_cycle_visible_only_across_new_edges(loom_dir: Path) -> None:
    """Cycle only visible when all new edges are considered together.

    Existing graph: a -> b.
    New edges: b -> c, c -> a.
    Neither b->c nor c->a alone creates a cycle with the existing graph,
    but together they close a->b->c->a.
    """
    loom = Loom(root=loom_dir)
    p = loom.create_project("acme", title="A")
    e = p.create_epic(title="E")
    s = e.create_story(title="S")
    a = s.create_task(title="ta").qualified_id
    b = s.create_task(title="tb").qualified_id
    c = s.create_task(title="tc").qualified_id

    # Existing edge: a -> b
    loom.get(a).depends_on(b)  # type: ignore[union-attr]

    idx = Index(loom_dir)
    new_edges = [(b, c), (c, a)]

    # Both edges individually are safe against existing graph alone.
    assert would_create_cycle(idx, b, c) is None
    assert would_create_cycle(idx, c, a) is None

    # Batch check sees the cycle.
    cycle = batch_would_create_cycle(idx, new_edges)
    assert cycle is not None


def test_batch_cycle_edge_order_independent(loom_dir: Path) -> None:
    """Cycle detection result must not depend on edge order in input."""
    loom = Loom(root=loom_dir)
    p = loom.create_project("acme", title="A")
    e = p.create_epic(title="E")
    s = e.create_story(title="S")
    a = s.create_task(title="ta").qualified_id
    b = s.create_task(title="tb").qualified_id
    c = s.create_task(title="tc").qualified_id

    loom.get(a).depends_on(b)  # type: ignore[union-attr]
    idx = Index(loom_dir)

    # Same cycle, edges in reversed order.
    cycle1 = batch_would_create_cycle(idx, [(b, c), (c, a)])
    cycle2 = batch_would_create_cycle(idx, [(c, a), (b, c)])
    assert cycle1 is not None
    assert cycle2 is not None


def test_batch_no_cycle_returns_none(loom_dir: Path) -> None:
    """Safe batch of edges returns None."""
    loom = Loom(root=loom_dir)
    p = loom.create_project("acme", title="A")
    e = p.create_epic(title="E")
    s = e.create_story(title="S")
    a = s.create_task(title="ta").qualified_id
    b = s.create_task(title="tb").qualified_id
    c = s.create_task(title="tc").qualified_id

    idx = Index(loom_dir)
    # a->b, b->c: linear chain, no cycle.
    cycle = batch_would_create_cycle(idx, [(a, b), (b, c)])
    assert cycle is None


def test_batch_self_loop_detected(loom_dir: Path) -> None:
    """A self-loop in the new edges is reported as a cycle."""
    loom = Loom(root=loom_dir)
    p = loom.create_project("acme", title="A")
    e = p.create_epic(title="E")
    s = e.create_story(title="S")
    a = s.create_task(title="ta").qualified_id

    idx = Index(loom_dir)
    cycle = batch_would_create_cycle(idx, [(a, a)])
    assert cycle is not None


def test_batch_empty_edges_no_cycle(loom_dir: Path) -> None:
    """Empty edge list never produces a cycle."""
    # loom_dir is a freshly initialized LOOM_DIR (from conftest fixture).
    from loom.index import Index as _Index

    idx = _Index(loom_dir)
    assert batch_would_create_cycle(idx, []) is None
