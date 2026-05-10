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

from pathlib import Path

from .errors import Duplicate, LoomError, NotFound
from .ids import (
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
        """Create a new project. Raises :class:`Duplicate` if it exists."""
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
        return Project(self._root, record)

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

    def statuses(self) -> list[str]:
        return self._index.statuses()

    # ----- Phase 4: ready + close ---------------------------------------

    def ready(
        self,
        *,
        type: str | None = None,
        tag: str | None = None,
        limit: int | None = None,
    ) -> list[Item]:
        """Return pickable items: status='ready', not archived, all deps done.

        The SQL fast-path uses the dependencies table; we then post-filter
        through :meth:`Item.is_pickable` so a broken dep (target deleted
        out from under the source — see :mod:`loom.deps`) doesn't sneak
        in. Apply ``limit`` after filtering so it bounds the visible
        result count.
        """
        from .items import _Statused

        candidates = self._index.find_pickable(type=type, tag=tag, limit=None)
        out: list[Item] = []
        for record in candidates:
            item = item_from_record(self._root, record)
            if isinstance(item, _Statused) and item.is_pickable():
                out.append(item)
                if limit is not None and len(out) >= limit:
                    break
        return out

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
