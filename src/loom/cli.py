"""Loom command-line interface.

Subcommand groups (``project``, ``epic``, ``story``, ``task``, ``tag``)
are nested typer apps; everything else is a top-level command. Each
group has its own no-op callback so typer treats it as multi-command.

The CLI is a thin shell over the library. Anything non-trivial belongs
in :mod:`loom.api` or :mod:`loom.items`, not here.
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated

import typer

from . import gitprobe, prompts
from . import state as state_mod
from .api import Loom
from .bootstrap import init as bootstrap_init
from .errors import LoomError
from .ids import BACKLOG_EPIC_ID, ItemType, parse_qid
from .index import Index
from .items import Epic, Item, Project, Story, Task
from .paths import loom_root
from .rebuild import rebuild as run_rebuild
from .rebuild import sync_one
from .validation import validate as run_validate


@dataclass(frozen=True, slots=True)
class CliState:
    """Per-invocation state stashed on ``ctx.obj`` by :func:`_root`."""

    non_interactive: bool = False


app = typer.Typer(
    add_completion=False,
    no_args_is_help=True,
    help="loom — markdown-based, hierarchy-agnostic project management",
)


@app.callback()
def _root(
    ctx: typer.Context,
    non_interactive: Annotated[
        bool,
        typer.Option(
            "--non-interactive",
            "-y",
            help="Disable interactive prompts; require explicit args.",
        ),
    ] = False,
) -> None:
    """loom — markdown-based, hierarchy-agnostic project management."""
    ctx.obj = CliState(non_interactive=non_interactive)


def _cli_state(ctx: typer.Context) -> CliState:
    """Return the active :class:`CliState`, defaulting if unset (e.g. tests)."""
    obj = ctx.obj
    return obj if isinstance(obj, CliState) else CliState()


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
# Workspace helpers
# ---------------------------------------------------------------------------


def _workspace() -> state_mod.Workspace | None:
    """Discover the active workspace by walking up from cwd.

    Returns None when no ancestor of cwd contains a ``.loom/`` directory.
    The result is the loaded state (so consumers see ``project`` and
    ``last_*`` without a second read).
    """
    ws_dir = state_mod.find_workspace_dir(Path.cwd())
    if ws_dir is None:
        return None
    return state_mod.load_workspace(ws_dir)


def _defaults() -> state_mod.Defaults:
    return state_mod.defaults_for(_workspace())


def _record_touch(qid: str) -> None:
    """Update the active workspace's ``last`` for *qid*. No-op if none."""
    ws = _workspace()
    if ws is None:
        return
    state_mod.update_workspace(ws.dir, qid)


def _story_create_epic_preselect(defaults: state_mod.Defaults) -> str | None:
    """Preselect for story_create's epic picker: last-touched, else
    <workspace.project>:backlog when a workspace is bound."""
    if defaults.epic:
        return defaults.epic
    if defaults.project:
        return f"{defaults.project}:{BACKLOG_EPIC_ID}"
    return None


# ---------------------------------------------------------------------------
# Interactive resolution helpers
# ---------------------------------------------------------------------------


def _item_candidate(item: Item) -> prompts.Candidate:
    return prompts.Candidate(
        qid=item.qualified_id,
        type=item.type,
        title=item.title,
        status=getattr(item.record, "status", None),
    )


def _pick_or_die(
    candidates: list[prompts.Candidate],
    *,
    prompt_label: str,
    preselect: str | None,
    non_interactive: bool,
) -> str:
    try:
        return prompts.pick_one(
            candidates,
            prompt=prompt_label,
            preselect=preselect,
            non_interactive=non_interactive,
        )
    except LoomError as e:
        _die(str(e))
        raise  # unreachable


def _resolve_qid_arg(
    qid: str | None,
    items: list[Item],
    *,
    prompt_label: str,
    non_interactive: bool,
    preselect: str | None = None,
) -> str:
    """Return *qid* if given, else pick interactively from *items*."""
    if qid:
        return qid
    return _pick_or_die(
        [_item_candidate(i) for i in items],
        prompt_label=prompt_label,
        preselect=preselect,
        non_interactive=non_interactive,
    )


def _resolve_title_body(
    title: str,
    body: str,
    *,
    non_interactive: bool,
) -> tuple[str, str]:
    """If both *title* and *body* are blank and we're interactive, open $EDITOR.

    Otherwise pass through. Returns ``(title, body)``.
    """
    if title or body:
        return title, body
    if not prompts.is_interactive(non_interactive):
        return title, body
    try:
        result = prompts.prompt_editor_template(
            prompts.CREATE_TEMPLATE, non_interactive=non_interactive
        )
    except LoomError as e:
        _die(str(e))
        raise  # unreachable
    new_title = result.get("title") or ""
    new_body = result.get("body") or ""
    if not new_title:
        _die("title is required (left blank in editor)")
    return new_title, new_body


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
    ctx: typer.Context,
    qualified_id: Annotated[
        str | None,
        typer.Argument(help="Qualified id of the item to resync. Picker if omitted."),
    ] = None,
    root: RootOption = None,
) -> None:
    """Re-read one item's markdown file and apply it to the index."""
    cli_state = _cli_state(ctx)
    target = _resolve_root(root)
    if qualified_id is None:
        loom = _loom(root)
        defaults = _defaults()
        qualified_id = _resolve_qid_arg(
            qualified_id,
            loom.find(),
            prompt_label="item",
            non_interactive=cli_state.non_interactive,
            preselect=state_mod.most_specific(defaults),
        )
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


def _resolve_body_with_file(
    body: str,
    body_file: Path | None,
) -> str:
    """Return the body string, given the inline ``body`` and the ``--body-file`` value.

    Exactly one of (body, body_file) may be non-empty. If body_file is set,
    its contents are read as utf-8. If both are set, exit with EXIT_GENERIC.
    """
    if body and body_file is not None:
        _die("--body and --body-file are mutually exclusive")
    if body_file is not None:
        try:
            return body_file.read_text(encoding="utf-8")
        except FileNotFoundError:
            _die(f"--body-file: {body_file} does not exist", code=EXIT_NOT_FOUND)
    return body


@project_app.command("create")
def project_create(
    ctx: typer.Context,
    name: Annotated[
        str,
        typer.Argument(help="Project slug — must match ^[a-z][a-z0-9_-]{0,63}$."),
    ],
    title: Annotated[str, typer.Option("--title", help="Human-readable title.")] = "",
    body: Annotated[str, typer.Option("--body", help="Markdown body for the project file.")] = "",
    body_file: Annotated[
        Path | None,
        typer.Option(
            "--body-file",
            help="Path to a markdown file used as the body. Mutually exclusive with --body.",
        ),
    ] = None,
    repo: Annotated[
        str | None,
        typer.Option(
            "--repo",
            help="Upstream / origin URL. Auto-discovered from cwd's git origin if omitted.",
        ),
    ] = None,
    default_branch: Annotated[
        str | None,
        typer.Option("--default-branch", help="Default git branch."),
    ] = None,
    root: RootOption = None,
) -> None:
    """Create a new project.

    When ``--repo`` is omitted, the current working directory must be a
    git repository with an ``origin`` remote; that URL is used. Pass
    ``--repo`` explicitly to override or to bypass the probe entirely.
    """
    cli_state = _cli_state(ctx)
    cwd = Path.cwd()
    if repo is None:
        if not gitprobe.is_git_repo(cwd):
            _die(
                f"loom project create needs --repo, or a cwd inside a git repo (got {cwd})",
                code=EXIT_GENERIC,
            )
            return
        discovered = gitprobe.discover_remote(cwd)
        if discovered is None:
            _die(
                "loom project create needs --repo, or a cwd whose git repo has an "
                "'origin' remote configured",
                code=EXIT_GENERIC,
            )
            return
        repo = discovered

    title, body = _resolve_title_body(title, body, non_interactive=cli_state.non_interactive)
    body = _resolve_body_with_file(body, body_file)
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

    # Anchor a `.loom/` workspace at the git toplevel (or cwd if no git).
    anchor = gitprobe.git_toplevel(cwd) or cwd
    prior = state_mod.init_workspace(anchor, project.qualified_id)
    if prior is not None and prior.project:
        typer.echo(
            f"note: workspace at {anchor} was bound to {prior.project}; "
            f"now bound to {project.qualified_id}",
            err=True,
        )
    typer.echo(f"created {project.qualified_id}")


@epic_app.command("create")
def epic_create(
    ctx: typer.Context,
    project: Annotated[
        str | None,
        typer.Argument(help="Project name (qid). Interactive picker if omitted."),
    ] = None,
    title: Annotated[str, typer.Option("--title", help="Human-readable title.")] = "",
    body: Annotated[str, typer.Option("--body", help="Markdown body.")] = "",
    body_file: Annotated[
        Path | None,
        typer.Option(
            "--body-file",
            help="Path to a markdown file used as the body. Mutually exclusive with --body.",
        ),
    ] = None,
    root: RootOption = None,
) -> None:
    """Create a new epic under <project>.

    If a ``.loom/`` workspace at or above cwd is bound to a project, that
    project is used silently when ``<project>`` is omitted. Otherwise, an
    interactive picker prompts (preselected to the last-touched project).
    """
    cli_state = _cli_state(ctx)
    loom = _loom(root)
    defaults = _defaults()
    if project is None and defaults.project:
        project = defaults.project
    project = _resolve_qid_arg(
        project,
        loom.projects(),
        prompt_label="project",
        non_interactive=cli_state.non_interactive,
        preselect=defaults.project,
    )
    try:
        parent = loom.get(project)
    except LoomError as e:
        _die_from(e)
        return
    if not isinstance(parent, Project):
        _die(f"{project} is not a project")
        return
    title, body = _resolve_title_body(title, body, non_interactive=cli_state.non_interactive)
    body = _resolve_body_with_file(body, body_file)
    try:
        epic = parent.create_epic(title=title or "(untitled epic)", body=body)
    except LoomError as e:
        _die_from(e)
        return
    _record_touch(epic.qualified_id)
    typer.echo(f"created {epic.qualified_id}")


@story_app.command("create")
def story_create(
    ctx: typer.Context,
    epic_qid: Annotated[
        str | None,
        typer.Argument(help="Qualified id of the parent epic. Picker if omitted."),
    ] = None,
    title: Annotated[str, typer.Option("--title", help="Human-readable title.")] = "",
    body: Annotated[str, typer.Option("--body", help="Markdown body.")] = "",
    body_file: Annotated[
        Path | None,
        typer.Option(
            "--body-file",
            help="Path to a markdown file used as the body. Mutually exclusive with --body.",
        ),
    ] = None,
    root: RootOption = None,
) -> None:
    """Create a new story under <epic-qid>.

    Passing a bare project qid (e.g. `loom story create acme`) defaults
    the story to that project's `backlog` epic, creating the backlog
    on the fly if the project pre-dates this feature.
    """
    cli_state = _cli_state(ctx)
    loom = _loom(root)
    defaults = _defaults()
    epic_qid = _resolve_qid_arg(
        epic_qid,
        loom.find(type="epic"),
        prompt_label="epic",
        non_interactive=cli_state.non_interactive,
        preselect=_story_create_epic_preselect(defaults),
    )

    # Bare project qid → default to <project>:backlog, lazy-creating
    # the backlog epic for legacy projects that pre-date this feature.
    try:
        parsed = parse_qid(epic_qid)
    except LoomError as e:
        _die_from(e)
        return
    if parsed.type is ItemType.PROJECT:
        backlog_qid = f"{parsed.project}:{BACKLOG_EPIC_ID}"
        if loom.get_or_none(backlog_qid) is None:
            project = _get_or_die(loom, parsed.project)
            if not isinstance(project, Project):
                _die(f"{parsed.project} is not a project")
                return
            try:
                project.create_epic(title="Backlog", epic_id=BACKLOG_EPIC_ID)
            except LoomError as e:
                _die_from(e)
                return
        epic_qid = backlog_qid

    try:
        parent = loom.get(epic_qid)
    except LoomError as e:
        _die_from(e)
        return
    if not isinstance(parent, Epic):
        _die(f"{epic_qid} is not an epic")
        return
    title, body = _resolve_title_body(title, body, non_interactive=cli_state.non_interactive)
    body = _resolve_body_with_file(body, body_file)
    try:
        story = parent.create_story(title=title or "(untitled story)", body=body)
    except LoomError as e:
        _die_from(e)
        return
    _record_touch(story.qualified_id)
    typer.echo(f"created {story.qualified_id}")


@task_app.command("create")
def task_create(
    ctx: typer.Context,
    story_qid: Annotated[
        str | None,
        typer.Argument(help="Qualified id of the parent story. Picker if omitted."),
    ] = None,
    title: Annotated[str, typer.Option("--title", help="Human-readable title.")] = "",
    body: Annotated[str, typer.Option("--body", help="Markdown body.")] = "",
    body_file: Annotated[
        Path | None,
        typer.Option(
            "--body-file",
            help="Path to a markdown file used as the body. Mutually exclusive with --body.",
        ),
    ] = None,
    root: RootOption = None,
) -> None:
    """Create a new task under <story-qid>."""
    cli_state = _cli_state(ctx)
    loom = _loom(root)
    defaults = _defaults()
    story_qid = _resolve_qid_arg(
        story_qid,
        loom.find(type="story"),
        prompt_label="story",
        non_interactive=cli_state.non_interactive,
        preselect=defaults.story,
    )
    try:
        parent = loom.get(story_qid)
    except LoomError as e:
        _die_from(e)
        return
    if not isinstance(parent, Story):
        _die(f"{story_qid} is not a story")
        return
    title, body = _resolve_title_body(title, body, non_interactive=cli_state.non_interactive)
    body = _resolve_body_with_file(body, body_file)
    try:
        task = parent.create_task(title=title or "(untitled task)", body=body)
    except LoomError as e:
        _die_from(e)
        return
    _record_touch(task.qualified_id)
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
    ctx: typer.Context,
    qid: Annotated[
        str | None,
        typer.Argument(help="Qualified id of the item to print. Picker if omitted."),
    ] = None,
    json_out: Annotated[
        bool,
        typer.Option("--json", help="Emit {qualified_id, frontmatter, body} as JSON."),
    ] = False,
    root: RootOption = None,
) -> None:
    """Print an item's markdown file to stdout (frontmatter + body, as-is)."""
    cli_state = _cli_state(ctx)
    loom = _loom(root)
    defaults = _defaults()
    qid = _resolve_qid_arg(
        qid,
        loom.find(),
        prompt_label="item",
        non_interactive=cli_state.non_interactive,
        preselect=state_mod.most_specific(defaults),
    )
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


@app.command("tree")
def tree_cmd(
    qid: Annotated[str, typer.Argument(help="Qualified id to render as a tree.")],
    depth: Annotated[
        int | None,
        typer.Option("--depth", help="Limit descent: 1 = direct children only."),
    ] = None,
    status: Annotated[
        str | None,
        typer.Option("--status", help="Filter items to this status."),
    ] = None,
    json_out: Annotated[
        bool,
        typer.Option("--json", help="Emit the flat-array JSON shape."),
    ] = False,
    root: RootOption = None,
) -> None:
    """Render the subtree rooted at <qid>."""
    loom = _loom(root)
    try:
        result = loom.tree(qid, depth=depth, status=status)
    except LoomError as e:
        _die_from(e)
        return
    if json_out:
        typer.echo(json.dumps(result, indent=2))
        return
    # Text output: indented unicode tree
    by_qid = {item["qid"]: item for item in result["items"]}
    root_qid = result["root"]

    def _render(current: str, prefix: str = "", is_last: bool = True) -> None:
        item = by_qid[current]
        if current == root_qid:
            connector = ""
            next_prefix = ""
        else:
            connector = "└─ " if is_last else "├─ "
            next_prefix = prefix + ("   " if is_last else "│  ")
        line = f"{prefix}{connector}{current}  [{item['status']}]  {item['type']}"
        if item.get("branch"):
            line += f"  branch={item['branch']}"
        typer.echo(line)
        children = item["children"]
        for i, child in enumerate(children):
            _render(child, next_prefix, i == len(children) - 1)

    _render(root_qid)


@app.command("order")
def order_cmd(
    qid: Annotated[str, typer.Argument(help="Qualified id to enumerate descendants of.")],
    recursive: Annotated[
        bool,
        typer.Option("--recursive", help="Include all descendants, not just direct children."),
    ] = False,
    include_done: Annotated[
        bool,
        typer.Option("--include-done", help="Include done items in the result."),
    ] = False,
    json_out: Annotated[
        bool,
        typer.Option("--json", help="Emit JSON array."),
    ] = False,
    root: RootOption = None,
) -> None:
    """Return descendants of <qid> in topological dep-order."""
    loom = _loom(root)
    try:
        items = loom.order(qid, recursive=recursive, include_done=include_done)
    except LoomError as e:
        _die_from(e)
        return
    if json_out:
        typer.echo(json.dumps([_item_to_dict(i) for i in items], indent=2))
        return
    for item in items:
        status_str = f" [{item.record.status}]" if item.record.status else ""
        typer.echo(f"{item.qualified_id}{status_str}\t{item.type}\t{item.title}")


@app.command("reopen")
def reopen_cmd(
    qid: Annotated[str, typer.Argument(help="Qualified id to reset (with descendants).")],
    root: RootOption = None,
) -> None:
    """Reset <qid> and all live descendants to status=ready; clear assignee."""
    loom = _loom(root)
    try:
        loom.reopen(qid)
    except LoomError as e:
        _die_from(e)
        return
    _record_touch(qid)
    typer.echo(f"reopened {qid}")


@app.command("edit")
def edit_cmd(
    ctx: typer.Context,
    qid: Annotated[
        str | None,
        typer.Argument(help="Qualified id of the item to edit. Picker if omitted."),
    ] = None,
    root: RootOption = None,
) -> None:
    """Open the item's file in $EDITOR; resync into the index on exit."""
    cli_state = _cli_state(ctx)
    loom = _loom(root)
    defaults = _defaults()
    qid = _resolve_qid_arg(
        qid,
        loom.find(),
        prompt_label="item",
        non_interactive=cli_state.non_interactive,
        preselect=state_mod.most_specific(defaults),
    )
    item = _get_or_die(loom, qid)
    code = prompts.launch_editor(item.file_path)
    if code != 0:
        _die(f"editor exited with code {code}", code=code)
    sync_one(loom.root, qid)
    _record_touch(qid)
    typer.echo(f"synced {qid}")


_PROJECT_SETTABLE_FIELDS = frozenset({"title", "body", "repo", "default_branch"})
_NON_PROJECT_SETTABLE_FIELDS = frozenset(
    {"title", "body", "status", "assignee", "branch", "pr_url"}
)


@app.command("update")
def update_cmd(
    ctx: typer.Context,
    qid: Annotated[
        str | None,
        typer.Argument(help="Qualified id of the item to mutate. Picker if omitted."),
    ] = None,
    field: Annotated[
        str | None,
        typer.Argument(
            help=(
                "Field name (title, body, status, assignee, branch, pr_url, repo, default_branch)."
            ),
        ),
    ] = None,
    value: Annotated[
        str | None,
        typer.Argument(help="New value. Use an empty string to clear an optional field."),
    ] = None,
    body_file: Annotated[
        Path | None,
        typer.Option(
            "--body-file",
            help="When field=body, read the new body from this file.",
        ),
    ] = None,
    root: RootOption = None,
) -> None:
    """Update a single frontmatter field on an item.

    Interactive: omitting any of QID, FIELD, or VALUE prompts for it. For
    ``title``, the prompt opens the item's file in ``$EDITOR`` rather
    than asking for a one-line value. For ``body``, pass ``--body-file
    <path>`` to read the new body from disk; ``loom edit`` remains the
    interactive way to edit a body in ``$EDITOR``.
    """
    cli_state = _cli_state(ctx)
    loom = _loom(root)
    defaults = _defaults()
    qid = _resolve_qid_arg(
        qid,
        loom.find(),
        prompt_label="item",
        non_interactive=cli_state.non_interactive,
        preselect=state_mod.most_specific(defaults),
    )
    item = _get_or_die(loom, qid)

    is_project = isinstance(item, Project)
    allowed = _PROJECT_SETTABLE_FIELDS if is_project else _NON_PROJECT_SETTABLE_FIELDS

    if field is None:
        field_cands = [
            prompts.Candidate(qid=f, type="field", title=f, status=None) for f in sorted(allowed)
        ]
        field = _pick_or_die(
            field_cands,
            prompt_label="field",
            preselect=None,
            non_interactive=cli_state.non_interactive,
        )

    if field not in allowed:
        _die(
            f"field {field!r} is not settable on a {item.type}; "
            f"allowed: {', '.join(sorted(allowed))}"
        )
        return

    # Body has its own value-resolution path: prefer --body-file when set,
    # otherwise treat the positional value as the literal new body.
    if field == "body":
        if body_file is not None:
            if value:
                _die("--body-file and positional value are mutually exclusive")
                return
            try:
                value = body_file.read_text(encoding="utf-8")
            except FileNotFoundError:
                _die(f"--body-file: {body_file} does not exist", code=EXIT_NOT_FOUND)
                return
        elif value is None:
            if not prompts.is_interactive(cli_state.non_interactive):
                _die("value or --body-file required for body (--non-interactive set / not a tty)")
                return
            try:
                value = typer.prompt("body (empty to clear)", default="", show_default=False)
            except (EOFError, typer.Abort):
                _die("value entry cancelled")
                return
        try:
            item.set_body(value)
        except LoomError as e:
            _die_from(e)
            return
        _record_touch(qid)
        typer.echo(f"set {qid} body")
        return

    if body_file is not None:
        _die("--body-file is only valid when field=body")
        return

    # Title gets the editor-on-existing-file flow when no value was supplied.
    if field == "title" and value is None:
        if not prompts.is_interactive(cli_state.non_interactive):
            _die("value required for title (--non-interactive set / not a tty)")
            return
        try:
            prompts.prompt_editor_file(item.file_path, non_interactive=cli_state.non_interactive)
        except LoomError as e:
            _die(str(e))
            return
        try:
            sync_one(loom.root, qid)
        except LoomError as e:
            _die_from(e)
            return
        _record_touch(qid)
        typer.echo(f"updated {qid} via editor")
        return

    if value is None:
        if not prompts.is_interactive(cli_state.non_interactive):
            _die(f"value required for {field} (--non-interactive set / not a tty)")
            return
        try:
            value = typer.prompt(f"{field} (empty to clear)", default="", show_default=False)
        except (EOFError, typer.Abort):
            _die("value entry cancelled")
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
    _record_touch(qid)
    typer.echo(f"set {qid} {field}={value if not cleared else '(cleared)'}")


@app.command("archive")
def archive_cmd(
    ctx: typer.Context,
    qid: Annotated[
        str | None,
        typer.Argument(help="Qualified id of the item to archive. Picker if omitted."),
    ] = None,
    root: RootOption = None,
) -> None:
    """Move an item (and any subtree) to the parallel _archive/ tree."""
    cli_state = _cli_state(ctx)
    loom = _loom(root)
    defaults = _defaults()
    qid = _resolve_qid_arg(
        qid,
        loom.find(),
        prompt_label="item",
        non_interactive=cli_state.non_interactive,
        preselect=state_mod.most_specific(defaults),
    )
    item = _get_or_die(loom, qid)
    try:
        item.archive()
    except LoomError as e:
        _die_from(e)
        return
    _record_touch(qid)
    typer.echo(f"archived {qid}")


def _non_project_items(loom: Loom) -> list[Item]:
    return [i for i in loom.find() if not isinstance(i, Project)]


@app.command("complete")
def complete_cmd(
    ctx: typer.Context,
    qid: Annotated[
        str | None,
        typer.Argument(help="Qualified id of the item to mark done. Picker if omitted."),
    ] = None,
    root: RootOption = None,
) -> None:
    """Set status to ``done``."""
    _status_shortcut(ctx, qid, root, "done")


@app.command("block")
def block_cmd(
    ctx: typer.Context,
    qid: Annotated[
        str | None,
        typer.Argument(help="Qualified id of the item to mark blocked. Picker if omitted."),
    ] = None,
    root: RootOption = None,
) -> None:
    """Set status to ``blocked``."""
    _status_shortcut(ctx, qid, root, "blocked")


@app.command("mark-ready")
def mark_ready_cmd(
    ctx: typer.Context,
    qid: Annotated[
        str | None,
        typer.Argument(help="Qualified id of the item to mark ready. Picker if omitted."),
    ] = None,
    root: RootOption = None,
) -> None:
    """Set status to ``ready``."""
    _status_shortcut(ctx, qid, root, "ready")


def _status_shortcut(ctx: typer.Context, qid: str | None, root: Path | None, status: str) -> None:
    cli_state = _cli_state(ctx)
    loom = _loom(root)
    defaults = _defaults()
    qid = _resolve_qid_arg(
        qid,
        _non_project_items(loom),
        prompt_label="item",
        non_interactive=cli_state.non_interactive,
        preselect=state_mod.most_specific(defaults),
    )
    _set_canonical_status(loom, qid, status)
    _record_touch(qid)


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
    ctx: typer.Context,
    qid: Annotated[
        str | None,
        typer.Argument(help="Qualified id of the item to tag. Picker if omitted."),
    ] = None,
    tags: Annotated[
        list[str] | None,
        typer.Argument(help="One or more tags to add. Comma-separated prompt if omitted."),
    ] = None,
    root: RootOption = None,
) -> None:
    """Add one or more tags to an item."""
    cli_state = _cli_state(ctx)
    loom = _loom(root)
    defaults = _defaults()
    qid = _resolve_qid_arg(
        qid,
        loom.find(),
        prompt_label="item",
        non_interactive=cli_state.non_interactive,
        preselect=state_mod.most_specific(defaults),
    )
    tags = _resolve_tags(
        tags, non_interactive=cli_state.non_interactive, prompt_label="tags to add"
    )
    item = _get_or_die(loom, qid)
    for tag in tags:
        item.add_tag(tag)
    _record_touch(qid)
    typer.echo(f"{qid} tags: {', '.join(item.tags) or '(none)'}")


@tag_app.command("rm")
def tag_rm(
    ctx: typer.Context,
    qid: Annotated[
        str | None,
        typer.Argument(help="Qualified id of the item to tag. Picker if omitted."),
    ] = None,
    tags: Annotated[
        list[str] | None,
        typer.Argument(help="One or more tags to remove. Comma-separated prompt if omitted."),
    ] = None,
    root: RootOption = None,
) -> None:
    """Remove one or more tags from an item."""
    cli_state = _cli_state(ctx)
    loom = _loom(root)
    defaults = _defaults()
    qid = _resolve_qid_arg(
        qid,
        loom.find(),
        prompt_label="item",
        non_interactive=cli_state.non_interactive,
        preselect=state_mod.most_specific(defaults),
    )
    tags = _resolve_tags(
        tags, non_interactive=cli_state.non_interactive, prompt_label="tags to remove"
    )
    item = _get_or_die(loom, qid)
    for tag in tags:
        item.remove_tag(tag)
    _record_touch(qid)
    typer.echo(f"{qid} tags: {', '.join(item.tags) or '(none)'}")


def _resolve_tags(
    tags: list[str] | None,
    *,
    non_interactive: bool,
    prompt_label: str,
) -> list[str]:
    if tags:
        return tags
    if not prompts.is_interactive(non_interactive):
        _die(f"{prompt_label} required (--non-interactive set / not a tty)")
    try:
        raw = typer.prompt(f"{prompt_label} (comma-separated)", default="", show_default=False)
    except (EOFError, typer.Abort):
        _die("tag entry cancelled")
        raise  # unreachable
    parsed = [t.strip() for t in raw.split(",") if t.strip()]
    if not parsed:
        _die("no tags entered")
    return parsed


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
    all_projects: Annotated[
        bool,
        typer.Option(
            "--all",
            help="List items from all projects, bypassing the workspace default.",
        ),
    ] = False,
    json_out: Annotated[bool, typer.Option("--json", help="Emit as JSON.")] = False,
    root: RootOption = None,
) -> None:
    """List items, with optional filters."""
    if all_projects and project is not None:
        _die("--all and --project are mutually exclusive", code=EXIT_GENERIC)
        return
    loom = _loom(root)
    # Resolution order: explicit --project wins; else --all bypasses the default;
    # else fall back to the workspace-bound project (may be None → no filter).
    if project is not None:
        effective_project = project
    elif all_projects:
        effective_project = None
    else:
        effective_project = _defaults().project
    items = loom.find(
        type=type_,
        status=status,
        project=effective_project,
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
    ctx: typer.Context,
    qid: Annotated[
        str | None,
        typer.Argument(help="Source: the item that depends on something. Picker if omitted."),
    ] = None,
    on: Annotated[
        str | None,
        typer.Option("--on", help="Target qualified id. Picker if omitted."),
    ] = None,
    root: RootOption = None,
) -> None:
    """Add a dependency edge: <qid> depends on --on <target>."""
    cli_state = _cli_state(ctx)
    loom = _loom(root)
    defaults = _defaults()
    qid = _resolve_qid_arg(
        qid,
        _non_project_items(loom),
        prompt_label="source",
        non_interactive=cli_state.non_interactive,
        preselect=state_mod.most_specific(defaults),
    )
    source = _get_or_die(loom, qid)
    if isinstance(source, Project):
        _die(f"projects cannot have dependencies: {qid}")
        return
    if on is None:
        targets = [i for i in _non_project_items(loom) if i.qualified_id != qid]
        on = _resolve_qid_arg(
            None,
            targets,
            prompt_label=f"target ({qid} depends on …)",
            non_interactive=cli_state.non_interactive,
        )
    try:
        source.depends_on(on)  # type: ignore[union-attr]
    except LoomError as e:
        _die_from(e)
        return
    _record_touch(qid)
    typer.echo(f"{qid} -> {on}")


@dep_app.command("rm")
def dep_rm(
    ctx: typer.Context,
    qid: Annotated[
        str | None,
        typer.Argument(help="Source qualified id. Picker if omitted."),
    ] = None,
    on: Annotated[
        str | None,
        typer.Option("--on", help="Target qualified id to remove. Picker if omitted."),
    ] = None,
    root: RootOption = None,
) -> None:
    """Remove a dependency edge: <qid> no longer depends on <target>."""
    cli_state = _cli_state(ctx)
    loom = _loom(root)
    defaults = _defaults()
    qid = _resolve_qid_arg(
        qid,
        _non_project_items(loom),
        prompt_label="source",
        non_interactive=cli_state.non_interactive,
        preselect=state_mod.most_specific(defaults),
    )
    source = _get_or_die(loom, qid)
    if isinstance(source, Project):
        _die(f"projects cannot have dependencies: {qid}")
        return
    if on is None:
        existing = source.dependencies()  # type: ignore[union-attr]
        cands = [
            prompts.Candidate(qid=r.qualified_id, type=r.type, title=r.title, status=r.status)
            for r in existing
        ]
        on = _pick_or_die(
            cands,
            prompt_label=f"existing dep to remove from {qid}",
            preselect=None,
            non_interactive=cli_state.non_interactive,
        )
    try:
        source.remove_dependency(on)  # type: ignore[union-attr]
    except LoomError as e:
        _die_from(e)
        return
    _record_touch(qid)
    typer.echo(f"removed {qid} -> {on}")


@dep_app.command("list")
def dep_list(
    ctx: typer.Context,
    qid: Annotated[
        str | None,
        typer.Argument(help="Qualified id to inspect. Picker if omitted."),
    ] = None,
    reverse: Annotated[
        bool,
        typer.Option("--reverse", help="Show dependents (who depends on me) instead of deps."),
    ] = False,
    json_out: Annotated[bool, typer.Option("--json", help="Emit as JSON.")] = False,
    root: RootOption = None,
) -> None:
    """List blockers (default) or dependents (--reverse) of an item."""
    cli_state = _cli_state(ctx)
    loom = _loom(root)
    defaults = _defaults()
    qid = _resolve_qid_arg(
        qid,
        loom.find(),
        prompt_label="item",
        non_interactive=cli_state.non_interactive,
        preselect=state_mod.most_specific(defaults),
    )
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
    qid: Annotated[
        str | None,
        typer.Argument(help="Optional parent qid; scope to items under it."),
    ] = None,
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
    recursive: Annotated[
        bool,
        typer.Option(
            "--recursive",
            help="Include all descendants of <qid>, not just direct children.",
        ),
    ] = False,
    json_out: Annotated[bool, typer.Option("--json", help="Emit as JSON.")] = False,
    root: RootOption = None,
) -> None:
    """List pickable items: status='ready' and every dep is done.

    If <qid> is provided, scope to items directly under it (or, with
    ``--recursive``, all descendants at any depth).
    """
    loom = _loom(root)
    if qid is not None:
        _get_or_die(loom, qid)
    items = loom.ready(type=type_, tag=tag, limit=limit, parent=qid, recursive=recursive)
    if json_out:
        typer.echo(json.dumps([_item_to_dict(i) for i in items], indent=2))
        return
    for item in items:
        typer.echo(f"{item.qualified_id}\t{item.type}\t{item.title}")


@app.command("close")
def close_cmd(
    ctx: typer.Context,
    qid: Annotated[
        str | None,
        typer.Argument(help="Container qualified id (epic or story). Picker if omitted."),
    ] = None,
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
    cli_state = _cli_state(ctx)
    loom = _loom(root)
    defaults = _defaults()
    qid = _resolve_qid_arg(
        qid,
        [i for i in loom.find() if isinstance(i, (Epic, Story))],
        prompt_label="container",
        non_interactive=cli_state.non_interactive,
        preselect=defaults.story or defaults.epic,
    )
    try:
        closed = loom.close_if_children_done(qid)
    except LoomError as e:
        _die_from(e)
        return
    if closed:
        _record_touch(qid)
        typer.echo(f"closed {qid}")
    else:
        typer.echo(f"{qid} not closed (subtree empty or has incomplete descendants)")
        raise typer.Exit(code=1)


# Suppress unused-import lint for symbols re-exported through CLI imports.
_ = (Task, parse_qid)
