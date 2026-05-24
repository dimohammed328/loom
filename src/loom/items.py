"""Item classes: Project, Epic, Story, Task.

``Project`` exposes only operations valid for a project
(``create_epic``, ``set_repo``, ...), and so on down the tree. Status
setters live on a ``_Statused`` mixin so projects don't get them by
accident.

Every mutator follows the same shape (the "mutator contract" in
CLAUDE.md):

1. Read the file from disk (preserving unknown frontmatter keys).
2. Apply the change in-memory.
3. Atomically rewrite the file via :mod:`loom.storage`.
4. Re-derive the :class:`IndexRecord` and apply it to the index.
5. Update ``self._record`` so the *same* instance reflects the change.

Step 5 matters: the "detached snapshot" rule applies to *other*
in-memory copies of the same item, not the one you just mutated.
"""

from __future__ import annotations

import shutil
from collections.abc import Iterable
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any

from .errors import Duplicate, LoomError, NotFound
from .ids import (
    STORIES_DIRNAME,
    TASKS_DIRNAME,
    ItemType,
    QualifiedId,
    path_from_qid,
    random_epic_id,
)
from .index import Index, IndexRecord
from .scan import build_record
from .storage import dump, load

if TYPE_CHECKING:
    from collections.abc import Sequence

EPIC_ID_MAX_ATTEMPTS = 8


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def _qid_path_exists_anywhere(root: Path, qid: QualifiedId) -> bool:
    """True if a file for *qid* exists in either the live or archive tree."""
    return (
        path_from_qid(qid, root, archived=False).exists()
        or path_from_qid(qid, root, archived=True).exists()
    )


def _next_sequential_id(root: Path, parent: QualifiedId, child_type: ItemType) -> int:
    """Compute the next sequential id under *parent* for *child_type*.

    Scans both the live and archived parent directories so that an
    archived sibling is never reused. Names that don't parse as canonical
    positive decimal integers are ignored (those become stray-file
    issues during validate / rebuild).
    """
    if child_type == ItemType.STORY:
        subdir = STORIES_DIRNAME
        is_match = _is_int_dir
    elif child_type == ItemType.TASK:
        subdir = TASKS_DIRNAME
        is_match = _is_int_md_file
    else:  # pragma: no cover - guarded by callers
        raise ValueError(f"sequential allocation not supported for {child_type}")

    max_id = 0
    for archived in (False, True):
        parent_path = path_from_qid(parent, root, archived=archived).parent / subdir
        if not parent_path.exists():
            continue
        for entry in parent_path.iterdir():
            n = is_match(entry)
            if n is not None and n > max_id:
                max_id = n
    return max_id + 1


def _is_int_dir(entry: Path) -> int | None:
    if not entry.is_dir():
        return None
    name = entry.name
    if not (name.isascii() and name.isdigit()):
        return None
    n = int(name)
    return n if str(n) == name and n >= 1 else None


def _is_int_md_file(entry: Path) -> int | None:
    if not entry.is_file() or not entry.name.endswith(".md"):
        return None
    stem = entry.name.removesuffix(".md")
    if not (stem.isascii() and stem.isdigit()):
        return None
    n = int(stem)
    return n if str(n) == stem and n >= 1 else None


def _build_frontmatter(
    qid: QualifiedId,
    *,
    title: str,
    status: str | None,
    extras: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Return a fresh frontmatter dict for a newly created item."""
    now = _now_iso()
    fm: dict[str, Any] = {
        "schema_version": 3,
        "id": qid.local_id,
        "qualified_id": str(qid),
        "type": qid.type.value,
        "title": title,
        "created_at": now,
        "updated_at": now,
    }
    if status is not None:
        fm["status"] = status
    if extras:
        for k, v in extras.items():
            if v is not None:
                fm[k] = v
    return fm


def _create_item_file(
    root: Path,
    qid: QualifiedId,
    fm: dict[str, Any],
    body: str,
) -> IndexRecord:
    """Atomically create *qid*'s file and apply it to the index.

    Raises :class:`Duplicate` if a file already exists at the qid's path
    (live or archived).
    """
    if _qid_path_exists_anywhere(root, qid):
        raise Duplicate(str(qid))

    path = path_from_qid(qid, root)
    dump(path, fm, body)
    try:
        record = build_record(path, root)
        Index(root).apply_record(record)
    except BaseException:
        # Roll back the partial write so a failed create leaves no orphan.
        path.unlink(missing_ok=True)
        raise
    return record


# ---------------------------------------------------------------------------
# Item base
# ---------------------------------------------------------------------------


class Item:
    """Base for every loom item. Exposes shared metadata + setters.

    Constructed via :meth:`Loom.get` / :meth:`Loom.find` /
    ``Project.create_epic`` etc. Direct construction is allowed but the
    record must already exist in the index.
    """

    __slots__ = ("_body", "_record", "_root")

    def __init__(self, root: Path, record: IndexRecord) -> None:
        self._root = root
        self._record = record
        self._body: str | None = None

    # ----- identity -----------------------------------------------------

    @property
    def root(self) -> Path:
        return self._root

    @property
    def record(self) -> IndexRecord:
        return self._record

    @property
    def qualified_id(self) -> str:
        return self._record.qualified_id

    @property
    def qid(self) -> QualifiedId:
        return QualifiedId(
            project=self._record.project,
            epic=self._record.epic,
            story=self._record.story,
            task=self._record.task,
        )

    @property
    def type(self) -> str:
        return self._record.type

    @property
    def parent_id(self) -> str | None:
        return self._record.parent_id

    @property
    def file_path(self) -> Path:
        return self._root / self._record.file_path

    # ----- metadata snapshot -------------------------------------------

    @property
    def title(self) -> str:
        return self._record.title

    @property
    def assignee(self) -> str | None:
        return self._record.assignee

    @property
    def branch(self) -> str | None:
        return self._record.branch

    @property
    def pr_url(self) -> str | None:
        return self._record.pr_url

    @property
    def archived(self) -> bool:
        return self._record.archived

    @property
    def created_at(self) -> str:
        return self._record.created_at

    @property
    def updated_at(self) -> str:
        return self._record.updated_at

    @property
    def tags(self) -> tuple[str, ...]:
        return self._record.tags

    @property
    def body(self) -> str:
        """The free-form markdown body. Lazily loaded on first access."""
        if self._body is None:
            _fm, body = load(self.file_path)
            self._body = body
        return self._body

    # ----- repr ---------------------------------------------------------

    def __repr__(self) -> str:
        return f"<{type(self).__name__} {self.qualified_id!r}>"

    def __eq__(self, other: object) -> bool:
        return (
            isinstance(other, Item)
            and self.qualified_id == other.qualified_id
            and self._root == other._root
        )

    def __hash__(self) -> int:
        return hash((self._root, self.qualified_id))

    # ----- mutation primitives -----------------------------------------

    def _mutate_frontmatter(self, **changes: Any) -> None:
        """Merge *changes* into the file's frontmatter and re-index.

        ``None`` values delete the corresponding key. ``updated_at`` is
        bumped automatically.
        """
        path = self.file_path
        fm, body = load(path)
        for key, value in changes.items():
            if value is None:
                fm.pop(key, None)
            else:
                fm[key] = value
        fm["updated_at"] = _now_iso()
        dump(path, fm, body)
        # Invalidate the body cache rather than caching the unnormalized
        # input — render() may add a trailing newline on dump.
        self._body = None
        new_record = build_record(path, self._root)
        Index(self._root).apply_record(new_record)
        self._record = new_record

    def _replace_tags(self, new_tags: Iterable[str]) -> None:
        path = self.file_path
        fm, body = load(path)
        unique = list(dict.fromkeys(str(t) for t in new_tags))
        if unique:
            fm["tags"] = unique
        else:
            fm.pop("tags", None)
        fm["updated_at"] = _now_iso()
        dump(path, fm, body)
        # Invalidate the body cache rather than caching the unnormalized
        # input — render() may add a trailing newline on dump.
        self._body = None
        new_record = build_record(path, self._root)
        Index(self._root).apply_record(new_record)
        self._record = new_record

    # ----- universal setters -------------------------------------------

    def set_title(self, title: str) -> Item:
        self._mutate_frontmatter(title=str(title))
        return self

    def set_body(self, body: str) -> Item:
        path = self.file_path
        fm, _old_body = load(path)
        fm["updated_at"] = _now_iso()
        dump(path, fm, body)
        # Invalidate the body cache rather than caching the unnormalized
        # input — render() may add a trailing newline on dump.
        self._body = None
        new_record = build_record(path, self._root)
        Index(self._root).apply_record(new_record)
        self._record = new_record
        return self

    def set_body_from_file(self, path: Path) -> Item:
        """Read *path* as utf-8 and use its contents as this item's body.

        Raises ``FileNotFoundError`` if *path* doesn't exist. Otherwise
        delegates to :meth:`set_body`.
        """
        body = Path(path).read_text(encoding="utf-8")
        return self.set_body(body)

    def add_tag(self, tag: str) -> Item:
        if tag in self._record.tags:
            return self
        self._replace_tags((*self._record.tags, str(tag)))
        return self

    def remove_tag(self, tag: str) -> Item:
        if tag not in self._record.tags:
            return self
        self._replace_tags(t for t in self._record.tags if t != tag)
        return self

    # ----- refresh / archive --------------------------------------------

    def refresh(self) -> Item:
        """Reload this item from the index, dropping any cached body."""
        rec = Index(self._root).get(self.qualified_id)
        if rec is None:
            raise NotFound(self.qualified_id)
        self._record = rec
        self._body = None
        return self

    def archive(self) -> Item:
        """Move this item (and any subtree) to the parallel ``_archive/`` tree.

        Raises :class:`LoomError` if the item is already archived or if
        the destination path is occupied. After archiving, the affected
        index entries (this item and any descendants) are re-synced and
        ``self._record`` reflects the new file_path / archived flag.
        """
        if self._record.archived:
            raise LoomError(f"{self.qualified_id} is already archived")

        src = self.file_path
        dst = path_from_qid(self.qid, self._root, archived=True)
        # For containers, we move the parent directory (which holds the
        # type-named file plus any children). For tasks (leaf .md files
        # in tasks/), we move just the file.
        if self.type == ItemType.TASK.value:
            move_src = src
            move_dst = dst
        else:
            move_src = src.parent
            move_dst = dst.parent

        if move_dst.exists():
            raise LoomError(
                f"cannot archive {self.qualified_id}: destination already exists at "
                f"{move_dst.relative_to(self._root)}"
            )

        move_dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(move_src), str(move_dst))

        # Re-sync every file under the moved subtree (or just this one
        # for tasks). The qids are unchanged; only file_path + archived
        # flip.
        from .rebuild import sync_one  # avoid import cycle at module load

        if self.type == ItemType.TASK.value:
            sync_one(self._root, self.qualified_id)
        else:
            for md_path in sorted(move_dst.parent.rglob("*.md")):
                from .ids import qid_from_path

                affected_qid, _ = qid_from_path(md_path, self._root)
                sync_one(self._root, str(affected_qid))

        self.refresh()
        return self


# ---------------------------------------------------------------------------
# Status mixin
# ---------------------------------------------------------------------------


class _Statused(Item):
    """Mixin for non-project items that carry a status field."""

    __slots__ = ()

    @property
    def status(self) -> str:
        # status is non-null for non-project rows; the cast is safe.
        return self._record.status  # type: ignore[return-value]

    def set_status(self, status: str) -> Item:
        if not isinstance(status, str) or not status:  # type: ignore[unreachable]
            raise ValueError("status must be a non-empty string")
        self._mutate_frontmatter(status=status)
        return self

    def complete(self) -> Item:
        return self.set_status("done")

    def block(self) -> Item:
        return self.set_status("blocked")

    def mark_ready(self) -> Item:
        return self.set_status("ready")

    def set_assignee(self, assignee: str | None) -> Item:
        self._mutate_frontmatter(assignee=assignee)
        return self

    def set_branch(self, branch: str | None) -> Item:
        self._mutate_frontmatter(branch=branch)
        return self

    def set_pr_url(self, pr_url: str | None) -> Item:
        self._mutate_frontmatter(pr_url=pr_url)
        return self

    # ----- dependencies (Phase 4) --------------------------------------

    def depends_on(self, target_qid: str) -> Item:
        """Add ``target_qid`` to this item's dependencies. Validates and
        rejects cycles. Idempotent if the edge already exists.
        """
        from .deps import add_dependency

        add_dependency(self._root, self.qualified_id, target_qid)
        self.refresh()
        return self

    def remove_dependency(self, target_qid: str) -> Item:
        """Drop ``target_qid`` from this item's dependencies."""
        from .deps import remove_dependency as _remove

        _remove(self._root, self.qualified_id, target_qid)
        self.refresh()
        return self

    def dependencies(self) -> list:
        """Return :class:`ItemRef` for every target this item depends on."""
        from .deps import compute_dependencies

        return compute_dependencies(Index(self._root), self.qualified_id)

    def dependents(self) -> list:
        """Return :class:`ItemRef` for every item that depends on this one."""
        from .deps import compute_dependents

        return compute_dependents(Index(self._root), self.qualified_id)

    def blockers(self) -> list:
        """Return :class:`ItemRef` for the not-yet-done deps of this item."""
        from .deps import compute_blockers

        return compute_blockers(Index(self._root), self.qualified_id)

    def is_pickable(self) -> bool:
        """True iff status='ready', not archived, and every dep is done."""
        from .deps import is_pickable

        return is_pickable(Index(self._root), self.qualified_id)


# ---------------------------------------------------------------------------
# Concrete item classes
# ---------------------------------------------------------------------------


class Project(Item):
    """Top-level container. No status; carries optional repo metadata."""

    __slots__ = ()

    @property
    def repo(self) -> str | None:
        return self._record.repo

    @property
    def default_branch(self) -> str | None:
        return self._record.default_branch

    def set_repo(self, repo: str | None) -> Project:
        self._mutate_frontmatter(repo=repo)
        return self

    def set_default_branch(self, branch: str | None) -> Project:
        self._mutate_frontmatter(default_branch=branch)
        return self

    def create_epic(self, *, title: str, body: str = "", epic_id: str | None = None) -> Epic:
        """Create an epic under this project.

        If *epic_id* is given, it is used directly (after a duplicate check);
        otherwise a fresh random id is allocated.
        """
        if epic_id is not None:
            qid = QualifiedId(self._record.project, epic_id)
            fm = _build_frontmatter(qid, title=title, status="ready")
            record = _create_item_file(self._root, qid, fm, body)
            return Epic(self._root, record)
        for _attempt in range(EPIC_ID_MAX_ATTEMPTS):
            random_id = random_epic_id()
            qid = QualifiedId(self._record.project, random_id)
            if not _qid_path_exists_anywhere(self._root, qid):
                fm = _build_frontmatter(qid, title=title, status="ready")
                record = _create_item_file(self._root, qid, fm, body)
                return Epic(self._root, record)
        raise LoomError(
            f"could not allocate a unique epic id for project {self._record.project!r} "
            f"after {EPIC_ID_MAX_ATTEMPTS} attempts"
        )

    def epics(self) -> list[Epic]:
        records = Index(self._root).find(type="epic", project=self._record.project)
        return [Epic(self._root, r) for r in records]


class Epic(_Statused):
    """A unit of work under a project. May contain stories."""

    __slots__ = ()

    def create_story(self, *, title: str, body: str = "") -> Story:
        next_id = _next_sequential_id(self._root, self.qid, ItemType.STORY)
        qid = QualifiedId(self._record.project, self._record.epic, next_id)
        fm = _build_frontmatter(qid, title=title, status="ready")
        record = _create_item_file(self._root, qid, fm, body)
        return Story(self._root, record)

    def stories(self) -> list[Story]:
        records = Index(self._root).find(type="story", project=self._record.project)
        return [Story(self._root, r) for r in records if r.epic == self._record.epic]


class Story(_Statused):
    """A coherent slice of work under an epic. May contain tasks."""

    __slots__ = ()

    def create_task(self, *, title: str, body: str = "") -> Task:
        next_id = _next_sequential_id(self._root, self.qid, ItemType.TASK)
        qid = QualifiedId(
            self._record.project,
            self._record.epic,
            self._record.story,
            next_id,
        )
        fm = _build_frontmatter(qid, title=title, status="ready")
        record = _create_item_file(self._root, qid, fm, body)
        return Task(self._root, record)

    def tasks(self) -> list[Task]:
        records = Index(self._root).find(type="task", project=self._record.project)
        return [
            Task(self._root, r)
            for r in records
            if r.epic == self._record.epic and r.story == self._record.story
        ]


class Task(_Statused):
    """The leaf level. No children."""

    __slots__ = ()


# ---------------------------------------------------------------------------
# Dispatcher
# ---------------------------------------------------------------------------


_TYPE_TO_CLASS: dict[str, type[Item]] = {
    ItemType.PROJECT.value: Project,
    ItemType.EPIC.value: Epic,
    ItemType.STORY.value: Story,
    ItemType.TASK.value: Task,
}


def item_from_record(root: Path, record: IndexRecord) -> Item:
    """Construct the appropriate Item subclass for *record*."""
    cls = _TYPE_TO_CLASS[record.type]
    return cls(root, record)


def items_from_records(root: Path, records: Sequence[IndexRecord]) -> list[Item]:
    return [item_from_record(root, r) for r in records]
