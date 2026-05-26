"""Tests for topological order utility and Loom.order()."""

from __future__ import annotations

from pathlib import Path

from loom.api import Loom


def test_topo_sort_respects_deps(loom_dir: Path) -> None:
    loom = Loom(root=loom_dir)
    p = loom.create_project(name="p", title="P")
    e = p.create_epic(title="E")
    s = e.create_story(title="s")
    t1 = s.create_task(title="t1")
    t2 = s.create_task(title="t2")
    t3 = s.create_task(title="t3")
    # t3 depends on t2, t2 depends on t1
    t2.depends_on(t1.qualified_id)
    t3.depends_on(t2.qualified_id)
    ordered = loom.order(s.qualified_id)
    qids = [item.qualified_id for item in ordered]
    # t1 must precede t2 must precede t3
    assert qids.index(t1.qualified_id) < qids.index(t2.qualified_id)
    assert qids.index(t2.qualified_id) < qids.index(t3.qualified_id)


def test_topo_sort_same_rank_orders_by_qid(loom_dir: Path) -> None:
    loom = Loom(root=loom_dir)
    p = loom.create_project(name="p", title="P")
    e = p.create_epic(title="E")
    s = e.create_story(title="s")
    # All three independent
    s.create_task(title="t1")
    s.create_task(title="t2")
    s.create_task(title="t3")
    ordered = loom.order(s.qualified_id)
    qids = [item.qualified_id for item in ordered]
    assert qids == sorted(qids)


def test_order_excludes_done_by_default(loom_dir: Path) -> None:
    loom = Loom(root=loom_dir)
    p = loom.create_project(name="p", title="P")
    e = p.create_epic(title="E")
    s = e.create_story(title="s")
    t1 = s.create_task(title="t1")
    s.create_task(title="t2")
    t1.complete()
    ordered = loom.order(s.qualified_id)
    assert all(item.qualified_id != t1.qualified_id for item in ordered)


def test_order_include_done(loom_dir: Path) -> None:
    loom = Loom(root=loom_dir)
    p = loom.create_project(name="p", title="P")
    e = p.create_epic(title="E")
    s = e.create_story(title="s")
    t1 = s.create_task(title="t1")
    s.create_task(title="t2")
    t1.complete()
    ordered = loom.order(s.qualified_id, include_done=True)
    assert len(ordered) == 2
