"""Dependency operations: cycle detection, blockers, ready, add/remove.

The ``dependencies`` table is derived from each item's ``depends_on``
frontmatter list. Mutations here go through the same write-then-sync
pattern as the rest of :mod:`loom.items` — frontmatter is the source of
truth, the index is rebuilt from it.

Per PLAN.md §3.2:
* Any non-project item may depend on any other non-project item.
* A dependency is satisfied iff the target's status is the literal
  string ``'done'``. Custom statuses do not satisfy.
* Depending on a project is forbidden (§2.8); a project has no status
  to satisfy.
"""

from __future__ import annotations

import json
from collections import deque
from dataclasses import dataclass
from pathlib import Path

from .errors import LoomError, NotFound
from .ids import ItemType, parse_qid
from .index import Index, IndexRecord
from .scan import build_record
from .storage import dump, load

DONE_STATUS = "done"
MISSING_TYPE = "missing"


@dataclass(frozen=True, slots=True)
class ItemRef:
    """Lightweight summary of an item for list returns.

    Per PLAN.md §8.1 — exists so callers can list ``dependencies()`` /
    ``dependents()`` without forcing a full file read for each.
    """

    qualified_id: str
    type: str
    title: str
    status: str | None

    @classmethod
    def from_record(cls, record: IndexRecord) -> ItemRef:
        return cls(
            qualified_id=record.qualified_id,
            type=record.type,
            title=record.title,
            status=record.status,
        )


# ---------------------------------------------------------------------------
# Read-side computations
# ---------------------------------------------------------------------------


def compute_dependencies(idx: Index, qualified_id: str) -> list[ItemRef]:
    """Return refs for every target *qualified_id* depends on."""
    return _refs_for(idx, idx.dependencies_of(qualified_id))


def compute_dependents(idx: Index, qualified_id: str) -> list[ItemRef]:
    """Return refs for every source that depends on *qualified_id*."""
    return _refs_for(idx, idx.dependents_of(qualified_id))


def compute_blockers(idx: Index, qualified_id: str) -> list[ItemRef]:
    """Return refs for the not-yet-satisfied dependencies of *qualified_id*.

    Reads declared deps from the source's stored frontmatter (the source
    of truth), not the dependencies table — so a broken dep (target
    deleted out from under the source) is still surfaced as a blocker.
    Missing targets are returned as a placeholder ItemRef with
    type='missing'.
    """
    record = idx.get(qualified_id)
    if record is None:
        raise NotFound(qualified_id)
    out: list[ItemRef] = []
    for dep_qid in _declared_deps(record):
        target = idx.get(dep_qid)
        if target is None:
            out.append(
                ItemRef(
                    qualified_id=dep_qid,
                    type=MISSING_TYPE,
                    title="(missing target)",
                    status=None,
                )
            )
        elif target.status != DONE_STATUS:
            out.append(ItemRef.from_record(target))
    return out


def is_pickable(idx: Index, qualified_id: str) -> bool:
    """True iff status=='ready', not archived, and every declared dep is done.

    A missing dep target counts as a blocker — a broken dep can never
    be satisfied, so the source isn't safe to pick up.
    """
    record = idx.get(qualified_id)
    if record is None:
        raise NotFound(qualified_id)
    if record.archived:
        return False
    if record.status != "ready":
        return False
    return not compute_blockers(idx, qualified_id)


def _declared_deps(record: IndexRecord) -> list[str]:
    """Read this item's declared deps from its stored frontmatter snapshot."""
    fm = json.loads(record.frontmatter_json)
    return [str(x) for x in (fm.get("depends_on") or ())]


def _refs_for(idx: Index, qids: tuple[str, ...]) -> list[ItemRef]:
    """Materialize index records for *qids*, dropping any that are missing.

    A missing target shouldn't normally happen (ON DELETE CASCADE would
    have removed the edge), but we tolerate it rather than crash on a
    half-rebuilt index.
    """
    out: list[ItemRef] = []
    for qid in qids:
        rec = idx.get(qid)
        if rec is not None:
            out.append(ItemRef.from_record(rec))
    return out


# ---------------------------------------------------------------------------
# Cycle detection
# ---------------------------------------------------------------------------


def would_create_cycle(
    idx: Index,
    source_qid: str,
    target_qid: str,
) -> list[str] | None:
    """If adding ``source -> target`` would close a cycle, return the cycle path.

    The path lists nodes in traversal order, starting and ending at
    ``source_qid``. Returns ``None`` if no cycle would form.

    Self-loops are *not* handled here — callers should reject
    ``source == target`` with a dedicated error.
    """
    if source_qid == target_qid:
        # Defensive: callers should reject earlier with a clearer error.
        return [source_qid, source_qid]

    # BFS forward from target through existing dep edges. If we reach
    # source, the new edge source->target would close source -> target ->
    # ... -> source.
    visited: set[str] = set()
    queue: deque[tuple[str, list[str]]] = deque([(target_qid, [target_qid])])
    while queue:
        node, path = queue.popleft()
        if node in visited:
            continue
        visited.add(node)
        for nxt in idx.dependencies_of(node):
            if nxt == source_qid:
                # Cycle found: source -> target -> ... -> nxt(=source)
                return [source_qid, *path, nxt]
            queue.append((nxt, [*path, nxt]))
    return None


# ---------------------------------------------------------------------------
# Mutations
# ---------------------------------------------------------------------------


def add_dependency(root: Path, source_qid: str, target_qid: str) -> None:
    """Edit the source's ``depends_on`` list to include *target_qid*.

    Validates: source exists; target exists; neither is a project;
    they are distinct; no cycle would form. Existing duplicate edges are
    a no-op.
    """
    parse_qid(source_qid)
    parse_qid(target_qid)
    idx = Index(root)

    source = idx.get(source_qid)
    if source is None:
        raise NotFound(source_qid)
    target = idx.get(target_qid)
    if target is None:
        raise NotFound(target_qid)

    if source.type == ItemType.PROJECT.value:
        raise LoomError(f"projects cannot have dependencies (source: {source_qid})")
    if target.type == ItemType.PROJECT.value:
        raise LoomError(f"depending on a project is forbidden (target: {target_qid})")
    if source_qid == target_qid:
        raise LoomError(f"an item cannot depend on itself: {source_qid}")

    if target_qid in source.depends_on:
        return  # idempotent — already present

    cycle = would_create_cycle(idx, source_qid, target_qid)
    if cycle is not None:
        from .errors import CycleError

        raise CycleError(source_qid, target_qid, cycle)

    _rewrite_depends_on(root, source, lambda existing: [*existing, target_qid])


def remove_dependency(root: Path, source_qid: str, target_qid: str) -> None:
    """Strip *target_qid* from the source's ``depends_on`` list.

    Raises :class:`NotFound` if the edge is not present — silent no-op
    would mask typos.
    """
    parse_qid(source_qid)
    parse_qid(target_qid)
    idx = Index(root)

    source = idx.get(source_qid)
    if source is None:
        raise NotFound(source_qid)
    if target_qid not in source.depends_on:
        raise NotFound(f"{source_qid} -> {target_qid}")

    _rewrite_depends_on(root, source, lambda existing: [t for t in existing if t != target_qid])


def _rewrite_depends_on(
    root: Path,
    source: IndexRecord,
    transform,
) -> None:
    """Apply *transform* to the source's ``depends_on`` list and resync."""
    from datetime import UTC, datetime

    path = root / source.file_path
    fm, body = load(path)
    existing = [str(x) for x in (fm.get("depends_on") or ())]
    new_list = list(transform(existing))
    if new_list:
        fm["depends_on"] = new_list
    else:
        fm.pop("depends_on", None)
    fm["updated_at"] = datetime.now(UTC).isoformat(timespec="seconds")
    dump(path, fm, body)
    record = build_record(path, root)
    Index(root).apply_record(record)


# ---------------------------------------------------------------------------
# Subtree close
# ---------------------------------------------------------------------------


def descendants(idx: Index, parent_qid: str) -> list[IndexRecord]:
    """Return every item below *parent_qid* in the hierarchy.

    Uses Python-side prefix matching to avoid SQL ``LIKE`` wildcard
    issues with project names that contain ``_``.
    """
    project = parent_qid.split(":", 1)[0]
    prefix = parent_qid + ":"
    return [r for r in idx.find(project=project) if r.qualified_id.startswith(prefix)]
