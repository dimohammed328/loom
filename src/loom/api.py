"""Public Loom facade.

The library entrypoint. Wraps :class:`loom.index.Index` in a typed,
hierarchy-aware API and is the only thing most callers need to import.

Example:

    from loom import Loom
    loom = Loom()                                # uses $LOOM_DIR
    project = loom.create_project("acme", title="Acme")
    epic    = project.create_epic(title="OAuth")
    story   = epic.create_story(title="Backend pieces")
    task    = story.create_task(title="Wire Google")

    task.complete()
    blocked = loom.find(type="task", status="blocked")
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

from .errors import Duplicate, LoomError, NotFound
from .ids import (
    BACKLOG_EPIC_ID,
    QualifiedId,
    parse_qid,
    path_from_qid,
    validate_project_name,
)
from .index import (
    SCHEMA_VERSION,
    Index,
    current_version,
    set_version,
)
from .items import (
    Item,
    Project,
    _build_frontmatter,
    _create_item_file,
    item_from_record,
)
from .paths import loom_root
from .rebuild import RebuildResult
from .rebuild import rebuild as _rebuild
from .rebuild import sync_one as _sync_one
from .validation import ValidationIssue
from .validation import validate as _validate


class Loom:
    """Top-level handle. ``Loom()`` resolves $LOOM_DIR; ``Loom(root=...)`` overrides.

    Does NOT create the directory — that is :func:`loom.bootstrap.init`'s
    job. If the DB exists at ``user_version=0`` (e.g. from a prior
    accidental Loom-only flow that bypassed init), the version is
    stamped on construction so the bootstrap version-check stays in
    sync.
    """

    def __init__(self, root: Path | str | None = None) -> None:
        resolved = loom_root() if root is None else Path(root)
        if not resolved.exists():
            raise LoomError(
                f"loom root does not exist: {resolved}. "
                "Run `loom init` (or `loom.bootstrap.init`) to create it."
            )
        self._root = resolved
        self._index = Index(resolved)
        # If a previous Loom-only flow created the DB without going
        # through bootstrap.init(), it left user_version=0. Stamp it
        # so subsequent init() / version checks behave consistently.
        # Only acts when the DB exists and is unstamped.
        db = self._index.db_path
        if db.exists() and current_version(db) == 0:
            set_version(db, SCHEMA_VERSION)

    @property
    def root(self) -> Path:
        return self._root

    @property
    def index(self) -> Index:
        return self._index

    # ----- create -------------------------------------------------------

    def create_project(
        self,
        name: str,
        *,
        title: str,
        body: str = "",
        repo: str | None = None,
        default_branch: str | None = None,
    ) -> Project:
        """Create a new project. Raises :class:`Duplicate` if it exists.

        Every project is created with a default ``backlog`` epic, the
        canonical home for one-off work that doesn't warrant a dedicated
        epic. See ``docs/MARKDOWN_SPEC.md`` for details.
        """
        validate_project_name(name)
        qid = QualifiedId(project=name)
        if (
            path_from_qid(qid, self._root, archived=False).exists()
            or path_from_qid(qid, self._root, archived=True).exists()
        ):
            raise Duplicate(str(qid))

        fm = _build_frontmatter(
            qid,
            title=title,
            status=None,  # projects have no status
            extras={"repo": repo, "default_branch": default_branch},
        )
        record = _create_item_file(self._root, qid, fm, body)
        project = Project(self._root, record)
        project.create_epic(title="Backlog", epic_id=BACKLOG_EPIC_ID)
        return project

    # ----- read ---------------------------------------------------------

    def get(self, qualified_id: str) -> Item:
        """Look up one item by qualified id. Raises :class:`NotFound` if absent."""
        # Validate the format first; raise InvalidQualifiedId on garbage.
        parse_qid(qualified_id)
        record = self._index.get(qualified_id)
        if record is None:
            raise NotFound(qualified_id)
        return item_from_record(self._root, record)

    def get_or_none(self, qualified_id: str) -> Item | None:
        """Like :meth:`get` but returns ``None`` instead of raising."""
        parse_qid(qualified_id)
        record = self._index.get(qualified_id)
        return None if record is None else item_from_record(self._root, record)

    def find(
        self,
        *,
        type: str | None = None,
        status: str | None = None,
        project: str | None = None,
        assignee: str | None = None,
        tag: str | None = None,
        archived: bool | None = None,
    ) -> list[Item]:
        """Filter items by exact-match on indexed columns."""
        records = self._index.find(
            type=type,
            status=status,
            project=project,
            assignee=assignee,
            tag=tag,
            archived=archived,
        )
        return [item_from_record(self._root, r) for r in records]

    def projects(self) -> list[Project]:
        return [item for item in self.find(type="project") if isinstance(item, Project)]

    def tree(
        self,
        qualified_id: str,
        *,
        depth: int | None = None,
        status: str | None = None,
    ) -> dict:
        """Return a flat-array tree rooted at *qualified_id*.

        The shape is::

            {
              "root": "<qid>",
              "items": [
                {"qid": "...", "type": "...", "status": "...",
                 "branch": "...", "pr_url": "...", "assignee": "...",
                 "deps": ["..."], "children": ["<qid>", ...]},
                ...
              ]
            }

        ``depth`` limits descent (``depth=1`` -> root + direct children).
        ``status`` filters items to a single status string.
        """
        from .deps import compute_dependencies, descendants

        root_record = self._index.get(qualified_id)
        if root_record is None:
            raise NotFound(qualified_id)

        # Collect all descendant records; filter by depth if requested.
        all_records = [root_record, *descendants(self._index, qualified_id)]

        def _depth_below_root(qid: str) -> int:
            return qid.count(":") - qualified_id.count(":")

        if depth is not None:
            all_records = [r for r in all_records if _depth_below_root(r.qualified_id) <= depth]

        if status is not None:
            all_records = [r for r in all_records if r.status == status]

        # Build children index: for each record, list direct-child qids
        # within our (possibly depth-trimmed) record set.
        present_qids = {r.qualified_id for r in all_records}
        items_out = []
        for record in sorted(all_records, key=lambda r: r.qualified_id):
            prefix = record.qualified_id + ":"
            children = sorted(
                q for q in present_qids if q.startswith(prefix) and ":" not in q[len(prefix) :]
            )
            deps = [
                ref.qualified_id for ref in compute_dependencies(self._index, record.qualified_id)
            ]
            items_out.append(
                {
                    "qid": record.qualified_id,
                    "type": record.type,
                    "status": record.status,
                    "branch": record.branch,
                    "pr_url": record.pr_url,
                    "assignee": record.assignee,
                    "deps": deps,
                    "children": children,
                }
            )
        return {"root": qualified_id, "items": items_out}

    def order(
        self,
        qualified_id: str,
        *,
        recursive: bool = False,
        include_done: bool = False,
    ) -> list[Item]:
        """Return descendants of *qualified_id* in topological dep-order.

        Default scope is direct children (e.g. tasks for a story, stories
        for an epic). With ``recursive=True``, all descendants at any depth.
        Done items are excluded by default; pass ``include_done=True`` to
        include them.
        """
        from .deps import descendants, topological_sort

        root_record = self._index.get(qualified_id)
        if root_record is None:
            raise NotFound(qualified_id)
        all_records = descendants(self._index, qualified_id)

        # Filter by depth scope
        if not recursive:
            prefix = qualified_id + ":"

            def _is_direct_child(qid: str) -> bool:
                rest = qid.removeprefix(prefix)
                return rest != qid and ":" not in rest

            all_records = [r for r in all_records if _is_direct_child(r.qualified_id)]

        if not include_done:
            all_records = [r for r in all_records if r.status != "done"]

        ordered = topological_sort(all_records, self._index)
        return [item_from_record(self._root, r) for r in ordered]

    def statuses(self) -> list[str]:
        return self._index.statuses()

    def project_status(self, project: str) -> dict:
        """Return open/closed counts per item type for *project*.

        Raises :class:`~loom.errors.NotFound` when *project* does not exist.

        The returned dict has the shape::

            {
              "project": "<project-name>",
              "epics":   {"open": <int>, "closed": <int>},
              "stories": {"open": <int>, "closed": <int>},
              "tasks":   {"open": <int>, "closed": <int>},
            }

        *closed* means ``status == "done"``; everything else counts as *open*.
        The project item itself is excluded from counts.
        """
        # Verify the project exists.
        project_record = self._index.get(project)
        if project_record is None or project_record.type != "project":
            raise NotFound(project)

        result: dict = {"project": project}
        for item_type, key in (("epic", "epics"), ("story", "stories"), ("task", "tasks")):
            all_records = self._index.find(type=item_type, project=project, archived=False)
            closed = sum(1 for r in all_records if r.status == "done")
            open_ = len(all_records) - closed
            result[key] = {"open": open_, "closed": closed}
        return result

    # ----- Phase 4: ready + close ---------------------------------------

    def ready(
        self,
        *,
        type: str | None = None,
        tag: str | None = None,
        limit: int | None = None,
        parent: str | None = None,
        recursive: bool = False,
    ) -> list[Item]:
        """Return pickable items: status='ready', not archived, all deps done.

        The SQL fast-path uses the dependencies table; we then post-filter
        through :meth:`Item.is_pickable` so a broken dep (target deleted
        out from under the source — see :mod:`loom.deps`) doesn't sneak
        in. Apply ``limit`` after filtering so it bounds the visible
        result count.

        If ``parent`` is provided, scope to items directly under that qid
        (or, with ``recursive=True``, all descendants at any depth). With
        ``parent=None`` (default), returns global ready items (existing
        behavior).
        """
        from .items import _Statused

        candidates = self._index.find_pickable(type=type, tag=tag, limit=None)
        out: list[Item] = []
        for record in candidates:
            if parent is not None:
                if recursive:
                    # All descendants at any depth.
                    if not record.qualified_id.startswith(parent + ":"):
                        continue
                else:
                    # Direct children only: qid must be parent + ":" + exactly one segment.
                    rest = record.qualified_id.removeprefix(parent + ":")
                    if rest == record.qualified_id or ":" in rest:
                        continue
            item = item_from_record(self._root, record)
            if isinstance(item, _Statused) and item.is_pickable():
                out.append(item)
                if limit is not None and len(out) >= limit:
                    break
        return out

    def reopen(self, qualified_id: str) -> None:
        """Reset *qualified_id* and all live descendants to status=ready.

        Also clears the ``assignee`` field on each. Archived items are
        untouched (they live under ``_archive/`` and are out of the live
        tree). Tasks (which lack ``set_assignee`` semantically in the
        workflow convention) get status reset; ``set_assignee(None)`` on
        them is a harmless no-op clear of an absent field.
        """
        from .deps import descendants
        from .items import _Statused

        root_record = self._index.get(qualified_id)
        if root_record is None:
            raise NotFound(qualified_id)

        all_records = [root_record, *descendants(self._index, qualified_id)]
        # Filter out archived (descendants may include archived items).
        all_records = [r for r in all_records if not r.archived]

        for record in all_records:
            item = item_from_record(self._root, record)
            if isinstance(item, _Statused):
                # Reset status then clear assignee. Refresh between to avoid
                # stale-record writes.
                item.set_status("ready")
                item.refresh().set_assignee(None)

    def close_if_children_done(self, qualified_id: str) -> bool:
        """Close *qualified_id* (set status='done') iff every descendant is done.

        Tasks have no children — raises. Projects have no status — raises.
        Items with an empty subtree return ``False`` (the helper refuses
        to vacuously close empty containers; use the explicit
        :meth:`Item.complete` for that).
        """
        from .deps import descendants
        from .errors import LoomError
        from .ids import ItemType

        record = self._index.get(qualified_id)
        if record is None:
            raise NotFound(qualified_id)
        if record.type == ItemType.PROJECT.value:
            raise LoomError("projects do not have a status to close")
        if record.type == ItemType.TASK.value:
            raise LoomError("tasks have no children; use .complete() directly")

        kids = descendants(self._index, qualified_id)
        if not kids:
            return False
        if not all(r.status == "done" for r in kids):
            return False

        item = item_from_record(self._root, record)
        # Only _Statused has set_status, but type checks above guarantee it.
        item.set_status("done")  # type: ignore[union-attr]
        return True

    # ----- watch --------------------------------------------------------

    def get_updates(
        self,
        *,
        timeout: float | None = None,
        debounce_delay: float = 0.05,
    ) -> Iterator[str]:
        """Yield the qualified id of each item whose ``.md`` file changes.

        Starts a ``watchdog`` observer in a background thread that watches
        ``$LOOM_DIR`` recursively for ``.md`` create / modify / delete /
        move events.  For each event the index is synced via
        :func:`~loom.rebuild.sync_one` before the qid is yielded.

        :param timeout: Per-iteration ``queue.get`` timeout in seconds.
            ``None`` (default) blocks indefinitely until an event arrives.
            Pass a small positive float to allow the caller to do periodic
            work between yields (the generator raises ``StopIteration``
            when the observer stops).
        :param debounce_delay: Window in seconds during which duplicate
            events for the same path are collapsed (default 0.05 s).

        The generator is interruptible: closing it (or breaking out of
        the loop) stops and joins the observer cleanly::

            gen = loom.get_updates()
            try:
                for qid in gen:
                    ...
            finally:
                gen.close()  # stops the background thread
        """
        import queue as _queue

        from .watch import _STOP, _start_observer

        q: _queue.Queue[object] = _queue.Queue()
        observer, debouncer = _start_observer(self._root, q, debounce_delay=debounce_delay)
        try:
            while observer.is_alive():
                try:
                    item = q.get(block=True, timeout=timeout if timeout is not None else 1.0)
                except _queue.Empty:
                    if timeout is not None:
                        # Caller requested a finite timeout — stop iteration.
                        return
                    continue
                if item is _STOP:
                    return
                yield str(item)
        finally:
            observer.stop()
            debouncer.cancel()
            observer.join()

    # ----- maintenance --------------------------------------------------

    def sync(self, qualified_id: str) -> None:
        """Re-read one item from disk into the index."""
        _sync_one(self._root, qualified_id)

    def rebuild(self) -> RebuildResult:
        """Drop and rebuild the index from the markdown tree."""
        return _rebuild(self._root)

    def validate(self) -> list[ValidationIssue]:
        """Return every inconsistency between the index and the filesystem."""
        return _validate(self._root)
