"""Loom command-line interface.

Subcommand groups (``project``, ``epic``, ``story``, ``task``, ``tag``)
are nested typer apps; everything else is a top-level command. Each
group has its own no-op callback so typer treats it as multi-command.

The CLI is a thin shell over the library. Anything non-trivial belongs
in :mod:`loom.api` or :mod:`loom.items`, not here.
"""

from __future__ import annotations

import json
import os
import shlex
import subprocess
import sys
from pathlib import Path
from typing import Annotated

import typer

from .api import Loom
from .bootstrap import init as bootstrap_init
from .errors import LoomError
from .ids import parse_qid
from .index import Index
from .items import Epic, Item, Project, Story, Task
from .paths import loom_root
from .rebuild import rebuild as run_rebuild
from .rebuild import sync_one
from .validation import validate as run_validate

app = typer.Typer(
    add_completion=False,
    no_args_is_help=True,
    help="loom — markdown-based, hierarchy-agnostic project management",
)


@app.callback()
def _root() -> None:
    """loom — markdown-based, hierarchy-agnostic project management."""


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


RootOption = Annotated[
    Path | None,
    typer.Option("--root", help="Override $LOOM_DIR for this invocation."),
]


def _resolve_root(root: Path | None) -> Path:
    return root or loom_root()


def _loom(root: Path | None) -> Loom:
    """Construct a Loom for *root*, routing init errors through _die_from."""
    try:
        return Loom(root=_resolve_root(root))
    except LoomError as e:
        _die_from(e)
        raise  # unreachable


# ---------------------------------------------------------------------------
# Exit codes (public contract for scripts).
# Most-specific first; see _exit_code_for.
# ---------------------------------------------------------------------------

EXIT_GENERIC = 1
EXIT_NOT_FOUND = 2
EXIT_DUPLICATE = 3
EXIT_CYCLE = 4
EXIT_INVALID_ID = 5


def _exit_code_for(error: LoomError) -> int:
    """Map a :class:`LoomError` to a stable exit code.

    Order matters: subclasses are checked before bases. `validate` and
    `rebuild` continue to use EXIT_GENERIC for "any issue found" — this
    table only routes raised exceptions.
    """
    from .errors import (
        CycleError,
        Duplicate,
        InvalidQualifiedId,
        NotFound,
        ReservedName,
    )

    if isinstance(error, NotFound):
        return EXIT_NOT_FOUND
    if isinstance(error, Duplicate):
        return EXIT_DUPLICATE
    if isinstance(error, CycleError):
        return EXIT_CYCLE
    if isinstance(error, (InvalidQualifiedId, ReservedName)):
        return EXIT_INVALID_ID
    return EXIT_GENERIC


def _die(message: str, code: int = EXIT_GENERIC) -> None:
    typer.echo(message, err=True)
    raise typer.Exit(code=code)


def _die_from(error: LoomError) -> None:
    """Like :func:`_die` but routes the exit code via :func:`_exit_code_for`."""
    _die(str(error), code=_exit_code_for(error))


def _get_or_die(loom: Loom, qid: str) -> Item:
    try:
        return loom.get(qid)
    except LoomError as e:
        _die_from(e)
        raise  # unreachable


# ---------------------------------------------------------------------------
# Maintenance commands (existing — Phase 2)
# ---------------------------------------------------------------------------


@app.command("init")
def init_cmd(root: RootOption = None) -> None:
    """Initialize a $LOOM_DIR. Idempotent — safe to re-run."""
    result = bootstrap_init(root)
    if result.created_anything:
        typer.echo(f"initialized loom at {result.root}")
    else:
        typer.echo(f"already initialized at {result.root}")


@app.command("rebuild")
def rebuild_cmd(
    root: RootOption = None,
    quiet: Annotated[
        bool,
        typer.Option("--quiet", "-q", help="Suppress per-rewrite log lines."),
    ] = False,
    json_out: Annotated[
        bool,
        typer.Option("--json", help="Emit the result as a JSON object on stdout."),
    ] = False,
) -> None:
    """Drop the index and rebuild it from the markdown files on disk."""
    target = _resolve_root(root)
    log = (lambda msg: None) if (quiet or json_out) else typer.echo
    result = run_rebuild(target, log=log)
    if json_out:
        typer.echo(
            json.dumps(
                {
                    "indexed_count": result.indexed_count,
                    "rewrites": list(result.rewrites),
                    "issues": [i.to_dict() for i in result.issues],
                },
                indent=2,
            )
        )
    else:
        typer.echo(
            f"indexed {result.indexed_count} item(s); "
            f"{len(result.rewrites)} rewrite(s); {len(result.issues)} issue(s)"
        )
        for issue in result.issues:
            typer.echo(f"  [{issue.kind}] {issue.qualified_id or issue.file_path}: {issue.message}")
    if result.issues:
        raise typer.Exit(code=EXIT_GENERIC)


@app.command("validate")
def validate_cmd(
    root: RootOption = None,
    json_out: Annotated[
        bool,
        typer.Option("--json", help="Emit issues as a JSON array on stdout."),
    ] = False,
) -> None:
    """Report inconsistencies between the index and the filesystem."""
    target = _resolve_root(root)
    issues = run_validate(target)
    if json_out:
        typer.echo(json.dumps([i.to_dict() for i in issues], indent=2))
    else:
        if not issues:
            typer.echo("no issues found")
        else:
            for issue in issues:
                location = issue.qualified_id or issue.file_path or "?"
                typer.echo(f"[{issue.kind}] {location}: {issue.message}")
            typer.echo(f"\n{len(issues)} issue(s) found", err=True)
    if issues:
        raise typer.Exit(code=1)


@app.command("sync")
def sync_cmd(
    qualified_id: Annotated[str, typer.Argument(help="Qualified id of the item to resync.")],
    root: RootOption = None,
) -> None:
    """Re-read one item's markdown file and apply it to the index."""
    target = _resolve_root(root)
    try:
        sync_one(target, qualified_id)
    except LoomError as e:
        _die_from(e)
    typer.echo(f"synced {qualified_id}")


@app.command("statuses")
def statuses_cmd(
    root: RootOption = None,
    json_out: Annotated[
        bool,
        typer.Option("--json", help="Emit the list as JSON on stdout."),
    ] = False,
) -> None:
    """List every distinct status currently in use across the index."""
    target = _resolve_root(root)
    values = Index(target).statuses()
    if json_out:
        json.dump(values, sys.stdout)
        sys.stdout.write("\n")
    else:
        for v in values:
            typer.echo(v)


# ---------------------------------------------------------------------------
# project / epic / story / task — create
# ---------------------------------------------------------------------------


project_app = typer.Typer(no_args_is_help=True, help="Project commands.")
epic_app = typer.Typer(no_args_is_help=True, help="Epic commands.")
story_app = typer.Typer(no_args_is_help=True, help="Story commands.")
task_app = typer.Typer(no_args_is_help=True, help="Task commands.")
tag_app = typer.Typer(no_args_is_help=True, help="Tag commands.")

app.add_typer(project_app, name="project")
app.add_typer(epic_app, name="epic")
app.add_typer(story_app, name="story")
app.add_typer(task_app, name="task")
app.add_typer(tag_app, name="tag")


@project_app.callback()
def _project_root() -> None:
    """Project commands."""


@epic_app.callback()
def _epic_root() -> None:
    """Epic commands."""


@story_app.callback()
def _story_root() -> None:
    """Story commands."""


@task_app.callback()
def _task_root() -> None:
    """Task commands."""


@tag_app.callback()
def _tag_root() -> None:
    """Tag commands."""


@project_app.command("create")
def project_create(
    name: Annotated[str, typer.Argument(help="Project slug — must match ^[a-z][a-z0-9_]{0,63}$.")],
    title: Annotated[str, typer.Option("--title", help="Human-readable title.")] = "",
    body: Annotated[str, typer.Option("--body", help="Markdown body for the project file.")] = "",
    repo: Annotated[
        str | None,
        typer.Option("--repo", help="Upstream / origin URL."),
    ] = None,
    default_branch: Annotated[
        str | None,
        typer.Option("--default-branch", help="Default git branch."),
    ] = None,
    root: RootOption = None,
) -> None:
    """Create a new project."""
    loom = _loom(root)
    try:
        project = loom.create_project(
            name,
            title=title or name,
            body=body,
            repo=repo,
            default_branch=default_branch,
        )
    except LoomError as e:
        _die_from(e)
        return
    typer.echo(f"created {project.qualified_id}")


@epic_app.command("create")
def epic_create(
    project: Annotated[str, typer.Argument(help="Project name (qid).")],
    title: Annotated[str, typer.Option("--title", help="Human-readable title.")] = "",
    body: Annotated[str, typer.Option("--body", help="Markdown body.")] = "",
    root: RootOption = None,
) -> None:
    """Create a new epic under <project>."""
    loom = _loom(root)
    try:
        parent = loom.get(project)
    except LoomError as e:
        _die_from(e)
        return
    if not isinstance(parent, Project):
        _die(f"{project} is not a project")
        return
    try:
        epic = parent.create_epic(title=title or "(untitled epic)", body=body)
    except LoomError as e:
        _die_from(e)
        return
    typer.echo(f"created {epic.qualified_id}")


@story_app.command("create")
def story_create(
    epic_qid: Annotated[str, typer.Argument(help="Qualified id of the parent epic.")],
    title: Annotated[str, typer.Option("--title", help="Human-readable title.")] = "",
    body: Annotated[str, typer.Option("--body", help="Markdown body.")] = "",
    root: RootOption = None,
) -> None:
    """Create a new story under <epic-qid>."""
    loom = _loom(root)
    try:
        parent = loom.get(epic_qid)
    except LoomError as e:
        _die_from(e)
        return
    if not isinstance(parent, Epic):
        _die(f"{epic_qid} is not an epic")
        return
    try:
        story = parent.create_story(title=title or "(untitled story)", body=body)
    except LoomError as e:
        _die_from(e)
        return
    typer.echo(f"created {story.qualified_id}")


@task_app.command("create")
def task_create(
    story_qid: Annotated[str, typer.Argument(help="Qualified id of the parent story.")],
    title: Annotated[str, typer.Option("--title", help="Human-readable title.")] = "",
    body: Annotated[str, typer.Option("--body", help="Markdown body.")] = "",
    root: RootOption = None,
) -> None:
    """Create a new task under <story-qid>."""
    loom = _loom(root)
    try:
        parent = loom.get(story_qid)
    except LoomError as e:
        _die_from(e)
        return
    if not isinstance(parent, Story):
        _die(f"{story_qid} is not a story")
        return
    try:
        task = parent.create_task(title=title or "(untitled task)", body=body)
    except LoomError as e:
        _die_from(e)
        return
    typer.echo(f"created {task.qualified_id}")


# ---------------------------------------------------------------------------
# project list (a useful convenience)
# ---------------------------------------------------------------------------


@project_app.command("list")
def project_list(
    root: RootOption = None,
    json_out: Annotated[bool, typer.Option("--json", help="Emit as JSON.")] = False,
) -> None:
    """List every project in the store."""
    loom = _loom(root)
    projects = loom.projects()
    if json_out:
        typer.echo(
            json.dumps(
                [
                    {
                        "qualified_id": p.qualified_id,
                        "title": p.title,
                        "repo": p.repo,
                        "default_branch": p.default_branch,
                        "archived": p.archived,
                    }
                    for p in projects
                ],
                indent=2,
            )
        )
    else:
        for p in projects:
            arch = " [archived]" if p.archived else ""
            typer.echo(f"{p.qualified_id}\t{p.title}{arch}")


# ---------------------------------------------------------------------------
# show / edit / set / archive / status shortcuts / list
# ---------------------------------------------------------------------------


@app.command("show")
def show_cmd(
    qid: Annotated[str, typer.Argument(help="Qualified id of the item to print.")],
    json_out: Annotated[
        bool,
        typer.Option("--json", help="Emit {qualified_id, frontmatter, body} as JSON."),
    ] = False,
    root: RootOption = None,
) -> None:
    """Print an item's markdown file to stdout (frontmatter + body, as-is)."""
    loom = _loom(root)
    item = _get_or_die(loom, qid)
    if json_out:
        from .index import to_plain
        from .storage import load

        fm, body = load(item.file_path)
        typer.echo(
            json.dumps(
                {
                    "qualified_id": item.qualified_id,
                    "type": item.type,
                    "frontmatter": to_plain(fm),
                    "body": body,
                },
                indent=2,
            )
        )
    else:
        typer.echo(item.file_path.read_text(encoding="utf-8"), nl=False)


@app.command("edit")
def edit_cmd(
    qid: Annotated[str, typer.Argument(help="Qualified id of the item to edit.")],
    root: RootOption = None,
) -> None:
    """Open the item's file in $EDITOR; resync into the index on exit."""
    loom = _loom(root)
    item = _get_or_die(loom, qid)
    editor_env = os.environ.get("EDITOR") or os.environ.get("VISUAL") or "vi"
    editor_cmd = shlex.split(editor_env)
    proc = subprocess.run([*editor_cmd, str(item.file_path)], check=False)
    if proc.returncode != 0:
        _die(f"editor exited with code {proc.returncode}", code=proc.returncode)
    sync_one(loom.root, qid)
    typer.echo(f"synced {qid}")


_PROJECT_SETTABLE_FIELDS = frozenset({"title", "repo", "default_branch"})
_NON_PROJECT_SETTABLE_FIELDS = frozenset({"title", "status", "assignee", "branch", "pr_url"})


@app.command("set")
def set_cmd(
    qid: Annotated[str, typer.Argument(help="Qualified id of the item to mutate.")],
    field: Annotated[
        str,
        typer.Argument(
            help="Field name (title, status, assignee, branch, pr_url, repo, default_branch).",
        ),
    ],
    value: Annotated[
        str,
        typer.Argument(help="New value. Use an empty string to clear an optional field."),
    ],
    root: RootOption = None,
) -> None:
    """Set a single frontmatter field on an item."""
    loom = _loom(root)
    item = _get_or_die(loom, qid)

    is_project = isinstance(item, Project)
    allowed = _PROJECT_SETTABLE_FIELDS if is_project else _NON_PROJECT_SETTABLE_FIELDS
    if field not in allowed:
        _die(
            f"field {field!r} is not settable on a {item.type}; "
            f"allowed: {', '.join(sorted(allowed))}"
        )
        return

    cleared = value == ""
    try:
        if field == "title":
            if cleared:
                _die("title cannot be empty")
                return
            item.set_title(value)
        elif field == "status":
            if cleared:
                _die("status cannot be empty")
                return
            item.set_status(value)  # type: ignore[union-attr]
        elif field == "assignee":
            item.set_assignee(value or None)  # type: ignore[union-attr]
        elif field == "branch":
            item.set_branch(value or None)  # type: ignore[union-attr]
        elif field == "pr_url":
            item.set_pr_url(value or None)  # type: ignore[union-attr]
        elif field == "repo":
            item.set_repo(value or None)  # type: ignore[union-attr]
        elif field == "default_branch":
            item.set_default_branch(value or None)  # type: ignore[union-attr]
    except LoomError as e:
        _die_from(e)
        return
    typer.echo(f"set {qid} {field}={value if not cleared else '(cleared)'}")


@app.command("archive")
def archive_cmd(
    qid: Annotated[str, typer.Argument(help="Qualified id of the item to archive.")],
    root: RootOption = None,
) -> None:
    """Move an item (and any subtree) to the parallel _archive/ tree."""
    loom = _loom(root)
    item = _get_or_die(loom, qid)
    try:
        item.archive()
    except LoomError as e:
        _die_from(e)
        return
    typer.echo(f"archived {qid}")


@app.command("complete")
def complete_cmd(
    qid: Annotated[str, typer.Argument(help="Qualified id of the item to mark done.")],
    root: RootOption = None,
) -> None:
    """Set status to ``done``."""
    _set_canonical_status(_loom(root), qid, "done")


@app.command("block")
def block_cmd(
    qid: Annotated[str, typer.Argument(help="Qualified id of the item to mark blocked.")],
    root: RootOption = None,
) -> None:
    """Set status to ``blocked``."""
    _set_canonical_status(_loom(root), qid, "blocked")


@app.command("mark-ready")
def mark_ready_cmd(
    qid: Annotated[str, typer.Argument(help="Qualified id of the item to mark ready.")],
    root: RootOption = None,
) -> None:
    """Set status to ``ready``."""
    _set_canonical_status(_loom(root), qid, "ready")


def _set_canonical_status(loom: Loom, qid: str, status: str) -> None:
    item = _get_or_die(loom, qid)
    if isinstance(item, Project):
        _die("projects do not have a status")
        return
    try:
        item.set_status(status)  # type: ignore[union-attr]
    except LoomError as e:
        _die_from(e)
        return
    typer.echo(f"{qid} -> {status}")


# ---------------------------------------------------------------------------
# tag add / rm
# ---------------------------------------------------------------------------


@tag_app.command("add")
def tag_add(
    qid: Annotated[str, typer.Argument(help="Qualified id of the item to tag.")],
    tags: Annotated[list[str], typer.Argument(help="One or more tags to add.")],
    root: RootOption = None,
) -> None:
    """Add one or more tags to an item."""
    loom = _loom(root)
    item = _get_or_die(loom, qid)
    for tag in tags:
        item.add_tag(tag)
    typer.echo(f"{qid} tags: {', '.join(item.tags) or '(none)'}")


@tag_app.command("rm")
def tag_rm(
    qid: Annotated[str, typer.Argument(help="Qualified id of the item to tag.")],
    tags: Annotated[list[str], typer.Argument(help="One or more tags to remove.")],
    root: RootOption = None,
) -> None:
    """Remove one or more tags from an item."""
    loom = _loom(root)
    item = _get_or_die(loom, qid)
    for tag in tags:
        item.remove_tag(tag)
    typer.echo(f"{qid} tags: {', '.join(item.tags) or '(none)'}")


# ---------------------------------------------------------------------------
# list (cross-cutting query)
# ---------------------------------------------------------------------------


@app.command("list")
def list_cmd(
    type_: Annotated[
        str | None,
        typer.Option("--type", help="Filter by type (project|epic|story|task)."),
    ] = None,
    status: Annotated[
        str | None,
        typer.Option("--status", help="Filter by exact status string."),
    ] = None,
    project: Annotated[
        str | None,
        typer.Option("--project", help="Filter by project name."),
    ] = None,
    assignee: Annotated[
        str | None,
        typer.Option("--assignee", help="Filter by assignee."),
    ] = None,
    tag: Annotated[
        str | None,
        typer.Option("--tag", help="Filter to items carrying this tag."),
    ] = None,
    archived: Annotated[
        bool | None,
        typer.Option(
            "--archived/--not-archived",
            help="Restrict to archived or non-archived items.",
        ),
    ] = None,
    json_out: Annotated[bool, typer.Option("--json", help="Emit as JSON.")] = False,
    root: RootOption = None,
) -> None:
    """List items, with optional filters."""
    loom = _loom(root)
    items = loom.find(
        type=type_,
        status=status,
        project=project,
        assignee=assignee,
        tag=tag,
        archived=archived,
    )
    if json_out:
        typer.echo(json.dumps([_item_to_dict(i) for i in items], indent=2))
    else:
        for item in items:
            arch = " [archived]" if item.archived else ""
            status_str = f" [{item.record.status}]" if item.record.status else ""
            typer.echo(f"{item.qualified_id}\t{item.type}{status_str}\t{item.title}{arch}")


def _item_to_dict(item: Item) -> dict:
    return {
        "qualified_id": item.qualified_id,
        "type": item.type,
        "title": item.title,
        "status": item.record.status,
        "assignee": item.assignee,
        "branch": item.branch,
        "pr_url": item.pr_url,
        "tags": list(item.tags),
        "archived": item.archived,
    }


# ---------------------------------------------------------------------------
# dep / ready / close (Phase 4)
# ---------------------------------------------------------------------------


dep_app = typer.Typer(no_args_is_help=True, help="Dependency commands.")
app.add_typer(dep_app, name="dep")


@dep_app.callback()
def _dep_root() -> None:
    """Dependency commands."""


@dep_app.command("add")
def dep_add(
    qid: Annotated[str, typer.Argument(help="Source: the item that depends on something.")],
    on: Annotated[str, typer.Option("--on", help="Target qualified id.")],
    root: RootOption = None,
) -> None:
    """Add a dependency edge: <qid> depends on --on <target>."""
    loom = _loom(root)
    source = _get_or_die(loom, qid)
    if isinstance(source, Project):
        _die(f"projects cannot have dependencies: {qid}")
        return
    try:
        source.depends_on(on)  # type: ignore[union-attr]
    except LoomError as e:
        _die_from(e)
        return
    typer.echo(f"{qid} -> {on}")


@dep_app.command("rm")
def dep_rm(
    qid: Annotated[str, typer.Argument(help="Source qualified id.")],
    on: Annotated[str, typer.Option("--on", help="Target qualified id to remove.")],
    root: RootOption = None,
) -> None:
    """Remove a dependency edge: <qid> no longer depends on <target>."""
    loom = _loom(root)
    source = _get_or_die(loom, qid)
    if isinstance(source, Project):
        _die(f"projects cannot have dependencies: {qid}")
        return
    try:
        source.remove_dependency(on)  # type: ignore[union-attr]
    except LoomError as e:
        _die_from(e)
        return
    typer.echo(f"removed {qid} -> {on}")


@dep_app.command("list")
def dep_list(
    qid: Annotated[str, typer.Argument(help="Qualified id to inspect.")],
    reverse: Annotated[
        bool,
        typer.Option("--reverse", help="Show dependents (who depends on me) instead of deps."),
    ] = False,
    json_out: Annotated[bool, typer.Option("--json", help="Emit as JSON.")] = False,
    root: RootOption = None,
) -> None:
    """List blockers (default) or dependents (--reverse) of an item."""
    loom = _loom(root)
    item = _get_or_die(loom, qid)
    if isinstance(item, Project):
        refs: list = []
    else:
        refs = item.dependents() if reverse else item.dependencies()  # type: ignore[union-attr]

    if json_out:
        payload = [
            {
                "qualified_id": r.qualified_id,
                "type": r.type,
                "title": r.title,
                "status": r.status,
            }
            for r in refs
        ]
        typer.echo(json.dumps(payload, indent=2))
        return

    if not refs:
        typer.echo("(none)")
        return
    for r in refs:
        status_str = f" [{r.status}]" if r.status else ""
        typer.echo(f"{r.qualified_id}\t{r.type}{status_str}\t{r.title}")


@app.command("ready")
def ready_cmd(
    type_: Annotated[
        str | None,
        typer.Option("--type", help="Filter by type (epic|story|task)."),
    ] = None,
    tag: Annotated[
        str | None,
        typer.Option("--tag", help="Filter to items carrying this tag."),
    ] = None,
    limit: Annotated[
        int | None,
        typer.Option("--limit", help="Cap the number of results."),
    ] = None,
    json_out: Annotated[bool, typer.Option("--json", help="Emit as JSON.")] = False,
    root: RootOption = None,
) -> None:
    """List pickable items: status='ready' and every dep is done."""
    loom = _loom(root)
    items = loom.ready(type=type_, tag=tag, limit=limit)
    if json_out:
        typer.echo(json.dumps([_item_to_dict(i) for i in items], indent=2))
        return
    for item in items:
        typer.echo(f"{item.qualified_id}\t{item.type}\t{item.title}")


@app.command("close")
def close_cmd(
    qid: Annotated[str, typer.Argument(help="Container qualified id (epic or story).")],
    if_children_done: Annotated[
        bool,
        typer.Option(
            "--if-children-done",
            help="Required flag: only close when every descendant has status='done'.",
        ),
    ] = False,
    root: RootOption = None,
) -> None:
    """Close a container iff every descendant is done.

    --if-children-done is required (it documents intent at the call site).
    """
    if not if_children_done:
        _die("close requires --if-children-done; use `complete` for an unconditional close")
        return
    loom = _loom(root)
    try:
        closed = loom.close_if_children_done(qid)
    except LoomError as e:
        _die_from(e)
        return
    if closed:
        typer.echo(f"closed {qid}")
    else:
        typer.echo(f"{qid} not closed (subtree empty or has incomplete descendants)")
        raise typer.Exit(code=1)


# Suppress unused-import lint for symbols re-exported through CLI imports.
_ = (Task, parse_qid)
