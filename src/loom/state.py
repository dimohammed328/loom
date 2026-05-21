"""Project-local workspace state for CLI ergonomics.

Each git project that owns a loom project gets a ``.loom/`` directory at
its toplevel (or at cwd when the user is outside git). Inside, a
``state.json`` records the bound loom project qid plus the most recently
touched epic / story / task.

Discovery is by walk-up from cwd: the first ancestor directory containing
a ``.loom/`` is the active workspace. This means subdirs of a workspace
inherit it for free, mirroring git's behavior.

Workspace state is not part of the markdown source-of-truth contract:
losing the ``.loom/`` directory only affects defaulting in the CLI.
Concurrency policy: best-effort, last writer wins; no locking.
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .errors import InvalidQualifiedId
from .ids import parse_qid
from .storage import atomic_write_text

WORKSPACE_DIRNAME = ".loom"
STATE_FILENAME = "state.json"
GITIGNORE_FILENAME = ".gitignore"
SCHEMA_VERSION = 1


@dataclass(frozen=True, slots=True)
class WorkspaceLast:
    """Most recently touched ids at each non-project level."""

    epic: str | None = None
    story: str | None = None
    task: str | None = None


@dataclass(frozen=True, slots=True)
class Workspace:
    """A loaded ``.loom/`` workspace."""

    dir: Path
    project: str | None
    last: WorkspaceLast = field(default_factory=WorkspaceLast)


# ---------------------------------------------------------------------------
# Discovery + I/O
# ---------------------------------------------------------------------------


def workspace_path(workspace_dir: Path) -> Path:
    return workspace_dir / WORKSPACE_DIRNAME / STATE_FILENAME


def find_workspace_dir(cwd: Path) -> Path | None:
    """Walk up from *cwd* looking for an ancestor containing ``.loom/``.

    Returns that ancestor (so ``workspace_path(result)`` is the state file),
    or None if no ``.loom/`` is found before the filesystem root.
    """
    cur = cwd.resolve()
    while True:
        if (cur / WORKSPACE_DIRNAME).is_dir():
            return cur
        if cur.parent == cur:
            return None
        cur = cur.parent


def load_workspace(workspace_dir: Path) -> Workspace:
    """Load workspace state from ``workspace_dir/.loom/state.json``.

    Returns a fresh ``Workspace`` with ``project=None`` if the file is
    missing, corrupt, or wrong-schema. Emits one stderr warning when the
    file exists but cannot be parsed.
    """
    path = workspace_path(workspace_dir)
    if not path.exists():
        return Workspace(dir=workspace_dir, project=None)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        print(
            f"warning: loom workspace state at {path} unreadable ({e}); ignoring",
            file=sys.stderr,
        )
        return Workspace(dir=workspace_dir, project=None)
    if not isinstance(data, dict) or data.get("schema_version") != SCHEMA_VERSION:
        print(
            f"warning: loom workspace state at {path} has unexpected schema; ignoring",
            file=sys.stderr,
        )
        return Workspace(dir=workspace_dir, project=None)

    project = data.get("project")
    if not isinstance(project, str):
        project = None
    last_raw = data.get("last") if isinstance(data.get("last"), dict) else {}

    def _get(level: str) -> str | None:
        v = last_raw.get(level)
        return v if isinstance(v, str) else None

    return Workspace(
        dir=workspace_dir,
        project=project,
        last=WorkspaceLast(epic=_get("epic"), story=_get("story"), task=_get("task")),
    )


def _save(workspace_dir: Path, project: str | None, last: WorkspaceLast) -> None:
    payload: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "project": project,
        "last": {"epic": last.epic, "story": last.story, "task": last.task},
    }
    atomic_write_text(
        workspace_path(workspace_dir),
        json.dumps(payload, indent=2, sort_keys=True) + "\n",
    )


def init_workspace(workspace_dir: Path, project: str) -> Workspace | None:
    """Bind *workspace_dir* to *project*. Returns the previous workspace if
    one existed with a different project (so the caller can warn), else None.

    Creates ``.loom/`` if absent, plus ``.loom/.gitignore`` (``*``) so the
    workspace stays out of the user's git index.
    """
    ws_root = workspace_dir / WORKSPACE_DIRNAME
    ws_root.mkdir(parents=True, exist_ok=True)
    gitignore = ws_root / GITIGNORE_FILENAME
    if not gitignore.exists():
        gitignore.write_text("*\n", encoding="utf-8")

    prior = load_workspace(workspace_dir)
    _save(workspace_dir, project, prior.last)
    if prior.project and prior.project != project:
        return prior
    return None


def update_workspace(workspace_dir: Path, qid: str) -> None:
    """Record *qid* as touched, updating ancestor levels in ``last``.

    Invalid qids are silently ignored. Touching a qid in a project other
    than the bound one does NOT change the binding; only ``last`` is
    affected. Deeper levels of ``last`` that don't descend from the new
    touch are cleared (consistency).
    """
    try:
        q = parse_qid(qid)
    except InvalidQualifiedId:
        return

    current = load_workspace(workspace_dir)
    new_epic = current.last.epic
    new_story = current.last.story
    new_task = current.last.task

    if q.epic is not None:
        new_epic = f"{q.project}:{q.epic}"
        # If the prior story/task no longer descend from this epic, clear them.
        if new_story and not new_story.startswith(new_epic + ":"):
            new_story = None
            new_task = None
    if q.story is not None:
        new_story = f"{q.project}:{q.epic}:{q.story}"
        if new_task and not new_task.startswith(new_story + ":"):
            new_task = None
    if q.task is not None:
        new_task = f"{q.project}:{q.epic}:{q.story}:{q.task}"

    _save(
        workspace_dir,
        current.project,
        WorkspaceLast(epic=new_epic, story=new_story, task=new_task),
    )


# ---------------------------------------------------------------------------
# Consistency-checked defaults for CLI consumers
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class Defaults:
    """Per-level preselect values, with ancestor consistency enforced."""

    project: str | None = None
    epic: str | None = None
    story: str | None = None
    task: str | None = None


def defaults_for(workspace: Workspace | None) -> Defaults:
    """Return preselect defaults derived from *workspace* (or empty).

    Deeper levels cascade-drop: an inconsistent epic invalidates the
    story (which depended on it), which in turn invalidates the task.
    """
    if workspace is None:
        return Defaults()
    project = workspace.project
    epic = workspace.last.epic
    story = workspace.last.story
    task = workspace.last.task
    if epic and not (project and epic.startswith(project + ":")):
        epic = None
    if story and not (epic and story.startswith(epic + ":")):
        story = None
    if task and not (story and task.startswith(story + ":")):
        task = None
    return Defaults(project=project, epic=epic, story=story, task=task)


def most_specific(d: Defaults) -> str | None:
    return d.task or d.story or d.epic or d.project
