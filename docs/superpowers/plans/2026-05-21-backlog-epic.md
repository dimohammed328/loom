# Default backlog epic Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every loom project gets a default `backlog` epic (auto-created on `Loom.create_project`); the CLI's `story create <project>` defaults to landing under `<project>:backlog`.

**Architecture:** Reserve the literal string `backlog` as a valid epic ID alongside the existing 7-char alphabet rule (additive change). Extend `Project.create_epic` to accept an explicit `epic_id`. `Loom.create_project` calls it with `epic_id="backlog"` right after writing the project file. CLI defaulting lives only in `cli.py:story_create` — the library API stays strict. Bump `schema_version` to 2 since the on-disk format admits new epic IDs.

**Tech Stack:** Python 3.11, `uv`, `typer`, `pytest`, `ruff`, SQLite (via stdlib).

**Reference:** Spec at `docs/superpowers/specs/2026-05-21-backlog-epic-design.md`.

---

## File map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/loom/ids.py` | Modify | Add `BACKLOG_EPIC_ID` constant; accept it in `parse_qid` and `qid_from_path`. |
| `src/loom/items.py` | Modify | Add optional `epic_id` kwarg to `Project.create_epic`; bump `schema_version` constant from 1 → 2. |
| `src/loom/api.py` | Modify | `Loom.create_project` auto-creates backlog epic after project file. |
| `src/loom/cli.py` | Modify | `story_create`: bare project qid → `<project>:backlog` (lazy-create if missing); preselect rule for interactive picker; failure-mode message in `project_create`. |
| `docs/MARKDOWN_SPEC.md` | Modify | Document literal `backlog` epic; bump schema_version to 2. |
| `CLAUDE.md` | Modify | Amend non-negotiable #2 with the literal exception. |
| `tests/test_backlog.py` | Create | All backlog-specific tests (ids, api, cli, lazy-create). |
| `tests/test_ids.py` | Modify | Add positive parse_qid test for backlog. |
| `tests/test_phase5.py` | Modify | Update `test_rebuild_json_clean` indexed_count assertion (1 → 2). |

---

## Task 1: Accept literal `backlog` as a valid epic ID

**Files:**
- Modify: `src/loom/ids.py`
- Modify: `tests/test_ids.py`

- [ ] **Step 1: Write the failing test** in `tests/test_ids.py` (append at the end of the parse_qid happy-path section).

```python
def test_parse_qid_accepts_backlog_literal() -> None:
    qid = parse_qid("acme:backlog")
    assert qid == QualifiedId(project="acme", epic="backlog")
    assert str(qid) == "acme:backlog"
    assert qid.type is ItemType.EPIC


def test_parse_qid_backlog_under_story_and_task() -> None:
    assert parse_qid("acme:backlog:1").epic == "backlog"
    assert parse_qid("acme:backlog:1:2").epic == "backlog"


def test_parse_qid_backlog_is_case_sensitive() -> None:
    with pytest.raises(InvalidQualifiedId, match="epic segment"):
        parse_qid("acme:Backlog")
    with pytest.raises(InvalidQualifiedId, match="epic segment"):
        parse_qid("acme:BACKLOG")


def test_parse_qid_backlog_prefix_still_rejects() -> None:
    # 'backlogx' is neither the literal 'backlog' nor 7 chars from the alphabet.
    with pytest.raises(InvalidQualifiedId, match="epic segment"):
        parse_qid("acme:backlogx")


def test_path_qid_round_trip_backlog() -> None:
    qid = QualifiedId("acme", "backlog", 1, 2)
    for archived in (False, True):
        path = path_from_qid(qid, ROOT, archived=archived)
        recovered, recovered_archived = qid_from_path(path, ROOT)
        assert recovered == qid
        assert recovered_archived is archived


def test_project_named_backlog_round_trip() -> None:
    # Edge case: project literally named `backlog`, containing the `backlog` epic.
    qid = QualifiedId("backlog", "backlog")
    path = path_from_qid(qid, ROOT)
    recovered, _ = qid_from_path(path, ROOT)
    assert recovered == qid
    assert str(parse_qid("backlog:backlog")) == "backlog:backlog"
```

- [ ] **Step 2: Run the tests; expect them to fail.**

Run: `uv run pytest tests/test_ids.py -v -k backlog`
Expected: 6 failures, all complaining the epic segment doesn't match the 7-char alphabet rule.

- [ ] **Step 3: Implement the change** in `src/loom/ids.py`.

Add the constant near the other epic constants (around line 29–30):

```python
BACKLOG_EPIC_ID = "backlog"
```

Add a helper just below `EPIC_ID_RE`:

```python
def _is_valid_epic_id(s: str) -> bool:
    """True iff *s* is either the literal `backlog` or a 7-char alphabet id."""
    return s == BACKLOG_EPIC_ID or bool(EPIC_ID_RE.match(s))
```

Replace the `EPIC_ID_RE.match(epic)` check in `parse_qid` (around line 154) with the helper:

```python
    epic = parts[1]
    if not _is_valid_epic_id(epic):
        raise InvalidQualifiedId(
            s,
            f"epic segment {epic!r} must be {EPIC_ID_LEN} chars from the epic alphabet "
            f"or the literal {BACKLOG_EPIC_ID!r}",
        )
```

Replace the `EPIC_ID_RE.match(epic)` check in `qid_from_path` (around line 227) with:

```python
    epic = rest[1]
    if not _is_valid_epic_id(epic):
        raise InvalidQualifiedId(str(path), f"invalid epic id segment {epic!r}")
```

- [ ] **Step 4: Run the new tests + the rejection suite; expect green.**

Run: `uv run pytest tests/test_ids.py -v`
Expected: every test passes, including the existing rejection tests (the additive change does not invalidate the old ones).

- [ ] **Step 5: Commit.**

```bash
git add src/loom/ids.py tests/test_ids.py
git commit -m "$(cat <<'EOF'
Accept literal 'backlog' as a valid epic id

Widens the epic id rule from "7 chars from EPIC_ALPHABET" to "7 chars
from EPIC_ALPHABET or the literal 'backlog'". random_epic_id is
unchanged — the alphabet excludes o/l so it can never collide.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Extend `Project.create_epic` to accept an explicit `epic_id`

**Files:**
- Modify: `src/loom/items.py:525-537`
- Create: `tests/test_backlog.py`

- [ ] **Step 1: Write the failing test** in a new file `tests/test_backlog.py`.

```python
"""Tests for the default `backlog` epic feature."""

from __future__ import annotations

from pathlib import Path

import pytest

from loom import Duplicate, Loom


def test_create_epic_with_explicit_id(loom_dir: Path) -> None:
    loom = Loom(root=loom_dir)
    project = loom.create_project("acme", title="A")
    # The auto-created backlog already occupies "backlog"; create a
    # fresh project to exercise the explicit-id path without colliding.
    other = loom.create_project("other", title="O")
    epic = other.create_epic(title="X", epic_id="abcdefg")
    assert epic.qualified_id == "other:abcdefg"


def test_create_epic_explicit_id_duplicate_raises(loom_dir: Path) -> None:
    loom = Loom(root=loom_dir)
    project = loom.create_project("acme", title="A")
    # The backlog already exists from create_project's auto-creation.
    with pytest.raises(Duplicate):
        project.create_epic(title="Backlog 2", epic_id="backlog")


def test_create_epic_invalid_explicit_id_raises(loom_dir: Path) -> None:
    loom = Loom(root=loom_dir)
    project = loom.create_project("acme", title="A")
    # 'BAD' has uppercase chars; not in the alphabet and not the literal 'backlog'.
    with pytest.raises(Exception):  # InvalidQualifiedId — path build will catch it
        project.create_epic(title="X", epic_id="BAD")
```

Note: the duplicate-raises test depends on Task 3's auto-creation. To run it standalone before Task 3 lands, manually skip with `pytest.skip(...)` or restructure to call `project.create_epic(epic_id="backlog")` twice. The "explicit_id" basic test passes today.

- [ ] **Step 2: Run the new test (only the explicit-id basic case for now).**

Run: `uv run pytest tests/test_backlog.py::test_create_epic_with_explicit_id -v`
Expected: FAIL with `TypeError: create_epic() got an unexpected keyword argument 'epic_id'`.

- [ ] **Step 3: Modify `Project.create_epic`** in `src/loom/items.py` (replace the existing method around line 525–537).

```python
    def create_epic(
        self, *, title: str, body: str = "", epic_id: str | None = None
    ) -> Epic:
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
```

- [ ] **Step 4: Run the explicit-id test; expect green.**

Run: `uv run pytest tests/test_backlog.py::test_create_epic_with_explicit_id -v`
Expected: PASS.

Also re-run the items test suite to catch regressions:
Run: `uv run pytest tests/test_items.py -v`
Expected: all pass.

- [ ] **Step 5: Commit.**

```bash
git add src/loom/items.py tests/test_backlog.py
git commit -m "$(cat <<'EOF'
Allow Project.create_epic to take an explicit epic_id

Default behavior (no epic_id) is unchanged: still allocates a fresh
random id. Explicit-id mode is what lets the next change auto-create
the backlog epic at a fixed path.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Auto-create backlog epic in `Loom.create_project`

**Files:**
- Modify: `src/loom/api.py:88-113`
- Modify: `src/loom/items.py:122-138` (schema_version bump)
- Modify: `tests/test_backlog.py` (append)
- Modify: `tests/test_phase5.py:189-196` (fix indexed_count assertion)

- [ ] **Step 1: Write the failing test** (append to `tests/test_backlog.py`).

```python
from loom.ids import BACKLOG_EPIC_ID


def test_create_project_writes_backlog_epic(loom_dir: Path) -> None:
    loom = Loom(root=loom_dir)
    project = loom.create_project("acme", title="A")

    # Backlog epic exists on disk and in the index.
    backlog_qid = f"acme:{BACKLOG_EPIC_ID}"
    backlog_path = loom_dir / "projects" / "acme" / "epics" / "backlog" / "epic.md"
    assert backlog_path.is_file()

    epic = loom.get(backlog_qid)
    assert epic.title == "Backlog"
    assert epic.qualified_id == backlog_qid
    assert epic.type == "epic"
    # _Statused exposes status; cast through the index record to avoid mypy noise.
    assert epic.record.status == "ready"


def test_create_project_backlog_appears_in_find(loom_dir: Path) -> None:
    loom = Loom(root=loom_dir)
    loom.create_project("acme", title="A")
    epics = loom.find(type="epic")
    assert {e.qualified_id for e in epics} == {f"acme:{BACKLOG_EPIC_ID}"}


def test_create_project_backlog_uses_schema_v2(loom_dir: Path) -> None:
    from loom.storage import load

    loom = Loom(root=loom_dir)
    loom.create_project("acme", title="A")
    backlog_path = loom_dir / "projects" / "acme" / "epics" / "backlog" / "epic.md"
    fm, _body = load(backlog_path)
    assert fm["schema_version"] == 2


def test_project_named_backlog_creates_backlog_backlog(loom_dir: Path) -> None:
    """Edge case: project literally named `backlog` still gets its backlog epic."""
    loom = Loom(root=loom_dir)
    loom.create_project("backlog", title="Backlog Project")
    backlog_path = loom_dir / "projects" / "backlog" / "epics" / "backlog" / "epic.md"
    assert backlog_path.is_file()
    epic = loom.get("backlog:backlog")
    assert epic.title == "Backlog"
```

- [ ] **Step 2: Run the new tests; expect them to fail.**

Run: `uv run pytest tests/test_backlog.py -v`
Expected: the four new tests fail (`NotFound` on the backlog qid lookup). The earlier `test_create_epic_with_explicit_id` continues to pass.

- [ ] **Step 3: Bump the schema_version constant** in `src/loom/items.py` `_build_frontmatter` (around line 124).

Replace:
```python
        "schema_version": 1,
```
with:
```python
        "schema_version": 2,
```

- [ ] **Step 4: Wire the auto-creation** in `src/loom/api.py` `Loom.create_project` (replace the body around line 88–113).

Add the import at the top of the file:
```python
from .ids import (
    BACKLOG_EPIC_ID,
    QualifiedId,
    parse_qid,
    path_from_qid,
    validate_project_name,
)
```

Replace the method:
```python
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
```

- [ ] **Step 5: Run the backlog tests; expect green.**

Run: `uv run pytest tests/test_backlog.py -v`
Expected: all four new tests pass, plus `test_create_epic_with_explicit_id` and the two error-path tests from Task 2 also pass (the duplicate-raises test now exercises real duplicate behavior).

- [ ] **Step 6: Update `test_phase5.py` indexed_count assertion** (around line 194).

Open `tests/test_phase5.py` and find `test_rebuild_json_clean`. Change:
```python
    assert payload["indexed_count"] == 1
```
to:
```python
    # create_project writes the project + its auto-generated backlog epic.
    assert payload["indexed_count"] == 2
```

- [ ] **Step 7: Run the full suite to surface any other count-based regressions.**

Run: `uv run pytest -x`
Expected: all green. If any test fails because it now sees the backlog epic (e.g., a `len(loom.find(type="epic"))` check), update the assertion in place and add a brief inline comment ("+ backlog auto-creation"). Do NOT change the production code to suppress the backlog.

- [ ] **Step 8: Commit.**

```bash
git add src/loom/api.py src/loom/items.py tests/test_backlog.py tests/test_phase5.py
git commit -m "$(cat <<'EOF'
Loom.create_project now creates a default backlog epic

Every project gets projects/<P>/epics/backlog/epic.md alongside the
project file. The backlog epic has title 'Backlog' and status 'ready'.
Bumps schema_version 1 -> 2 to reflect the widened epic id format on
disk. Updates the one existing test whose indexed_count assertion
shifted (project + backlog = 2).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: CLI — `story create <project>` defaults to `<project>:backlog`

**Files:**
- Modify: `src/loom/cli.py:550-587` (story_create)
- Modify: `tests/test_backlog.py` (append)

- [ ] **Step 1: Write the failing test** (append to `tests/test_backlog.py`).

```python
import json

from typer.testing import CliRunner

from loom.cli import app

runner = CliRunner()


def test_cli_story_create_defaults_to_backlog(loom_dir: Path) -> None:
    runner.invoke(
        app,
        ["project", "create", "acme", "--title", "A", "--repo", "https://e/a",
         "--root", str(loom_dir)],
    )
    r = runner.invoke(
        app,
        ["story", "create", "acme", "--title", "Fix login bug",
         "--root", str(loom_dir)],
    )
    assert r.exit_code == 0, r.output
    assert "created acme:backlog:1" in r.output


def test_cli_story_create_legacy_project_lazy_creates_backlog(
    loom_dir: Path,
) -> None:
    """A project written without a backlog (legacy layout) gets backlog
    materialized the first time `story create <project>` defaults into it.
    """
    from conftest import write_item
    from loom.ids import QualifiedId

    # Write a project with NO backlog epic — simulates pre-feature layout.
    write_item(loom_dir, QualifiedId("legacy"), title="Legacy Project")

    # Rebuild so the index sees the project.
    runner.invoke(app, ["rebuild", "--root", str(loom_dir), "-q"])

    backlog_path = loom_dir / "projects" / "legacy" / "epics" / "backlog" / "epic.md"
    assert not backlog_path.exists()

    r = runner.invoke(
        app,
        ["story", "create", "legacy", "--title", "S", "--root", str(loom_dir)],
    )
    assert r.exit_code == 0, r.output
    assert backlog_path.is_file()
    assert "created legacy:backlog:1" in r.output


def test_cli_story_create_explicit_epic_unchanged(loom_dir: Path) -> None:
    """Passing a real epic qid still creates the story under that epic."""
    loom = Loom(root=loom_dir)
    p = loom.create_project("acme", title="A")
    e = p.create_epic(title="Auth")
    r = runner.invoke(
        app,
        ["story", "create", e.qualified_id, "--title", "S",
         "--root", str(loom_dir)],
    )
    assert r.exit_code == 0, r.output
    assert f"created {e.qualified_id}:1" in r.output
```

- [ ] **Step 2: Run the new tests; expect them to fail.**

Run: `uv run pytest tests/test_backlog.py -v -k "story_create"`
Expected: the two defaulting tests fail with "acme is not an epic" (the strict check at line 577–579). `test_cli_story_create_explicit_epic_unchanged` already passes.

- [ ] **Step 3: Modify `story_create`** in `src/loom/cli.py` (around line 550–587).

Add imports at the top of the file:
```python
from .ids import BACKLOG_EPIC_ID, ItemType, parse_qid
```
(`parse_qid` is already imported — just add `BACKLOG_EPIC_ID` and `ItemType` to the import line.)

Replace the `story_create` body, inserting the defaulting block right after `_resolve_qid_arg`:

```python
@story_app.command("create")
def story_create(
    ctx: typer.Context,
    epic_qid: Annotated[
        str | None,
        typer.Argument(help="Qualified id of the parent epic. Picker if omitted."),
    ] = None,
    title: Annotated[str, typer.Option("--title", help="Human-readable title.")] = "",
    body: Annotated[str, typer.Option("--body", help="Markdown body.")] = "",
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
        preselect=defaults.epic,
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
    try:
        story = parent.create_story(title=title or "(untitled story)", body=body)
    except LoomError as e:
        _die_from(e)
        return
    _record_touch(story.qualified_id)
    typer.echo(f"created {story.qualified_id}")
```

- [ ] **Step 4: Run the new tests; expect green.**

Run: `uv run pytest tests/test_backlog.py -v -k "story_create"`
Expected: all three CLI defaulting tests pass.

Also run the full e2e and CLI test files to catch regressions:
Run: `uv run pytest tests/test_e2e.py tests/test_cli.py tests/test_cli_state_roundtrip.py -v`
Expected: all green.

- [ ] **Step 5: Commit.**

```bash
git add src/loom/cli.py tests/test_backlog.py
git commit -m "$(cat <<'EOF'
CLI: 'story create <project>' defaults to <project>:backlog

Passing a bare project qid to 'story create' lands the story under
the project's backlog epic. Legacy projects (created before the
auto-backlog feature) get backlog materialized on first reference.
Library API stays strict — only the CLI takes this shortcut.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: CLI — preselect backlog when no last-touched epic

**Files:**
- Modify: `src/loom/cli.py:550-587` (story_create preselect)
- Modify: `tests/test_backlog.py` (append)

- [ ] **Step 1: Write the failing test** (append to `tests/test_backlog.py`).

```python
def test_cli_story_create_preselects_backlog_when_no_last_touched(
    loom_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Interactive picker preselects <workspace.project>:backlog when
    no real epic has been touched yet."""
    from loom import prompts
    from loom import state as state_mod

    runner.invoke(
        app,
        ["project", "create", "acme", "--title", "A", "--repo", "https://e/a",
         "--root", str(loom_dir)],
    )

    calls: list[dict] = []

    def fake_pick(candidates, *, prompt, preselect, non_interactive):  # type: ignore[no-untyped-def]
        calls.append({"prompt": prompt, "preselect": preselect})
        return candidates[0].qid

    monkeypatch.setattr(prompts, "pick_one", fake_pick)
    # Force the picker code path even though CliRunner is non-TTY.
    monkeypatch.setattr(prompts, "is_interactive", lambda _ni: True)

    r = runner.invoke(
        app, ["story", "create", "--title", "S", "--root", str(loom_dir)]
    )
    assert r.exit_code == 0, r.output
    epic_pick = [c for c in calls if c["prompt"] == "epic"]
    assert epic_pick and epic_pick[0]["preselect"] == "acme:backlog"
```

- [ ] **Step 2: Run the test; expect failure.**

Run: `uv run pytest tests/test_backlog.py::test_cli_story_create_preselects_backlog_when_no_last_touched -v`
Expected: FAIL — preselect is `None` (defaults.epic is None and there's no fallback yet).

- [ ] **Step 3: Modify the preselect line** in `cli.py:story_create`.

Replace the `_resolve_qid_arg` call's `preselect` argument:
```python
        preselect=defaults.epic,
```
with:
```python
        preselect=_story_create_epic_preselect(defaults),
```

And add the helper above the `story_app.command` registration block (e.g., right after `_record_touch`):

```python
def _story_create_epic_preselect(defaults: state_mod.Defaults) -> str | None:
    """Preselect for story_create's epic picker: last-touched, else
    <workspace.project>:backlog when a workspace is bound."""
    if defaults.epic:
        return defaults.epic
    if defaults.project:
        return f"{defaults.project}:{BACKLOG_EPIC_ID}"
    return None
```

- [ ] **Step 4: Run the test + the existing preselect tests; expect green.**

Run: `uv run pytest tests/test_backlog.py tests/test_cli_state_roundtrip.py -v`
Expected: all pass. `test_story_create_preselects_last_epic` still passes because it touches a real epic before the picker runs (defaults.epic populated, takes priority).

- [ ] **Step 5: Commit.**

```bash
git add src/loom/cli.py tests/test_backlog.py
git commit -m "$(cat <<'EOF'
CLI: preselect backlog in story_create when no last-touched epic

A fresh user with a bound workspace but no last-touched epic now
gets <project>:backlog as the picker default (fzf --query seed or
numbered-fallback Enter-default). Once they touch a real epic,
that wins.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Update `MARKDOWN_SPEC.md` and `CLAUDE.md`

**Files:**
- Modify: `docs/MARKDOWN_SPEC.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update `docs/MARKDOWN_SPEC.md`.**

Change line 14 from:
```
schema_version: 1
```
to:
```
schema_version: 2
```

Change line 64 (the Epic ID row in the identifier table) from:
```
| Epic    | exactly 7 chars from `abcdefghjkmnpqrstvwxyz23456789` (Crockford-ish, no `0/1/i/l/o/u`) | `apt2467` |
```
to:
```
| Epic    | exactly 7 chars from `abcdefghjkmnpqrstvwxyz23456789` (Crockford-ish, no `0/1/i/l/o/u`), **or** the literal `backlog` | `apt2467`, `backlog` |
```

Change line 85 from:
```
| `schema_version` | int | Currently `1`. |
```
to:
```
| `schema_version` | int | Currently `2`. |
```

Change line 179 from:
```
`schema_version: 1` is the current and only version. A future
```
to:
```
`schema_version: 2` is the current version (v1 differed only by
disallowing the literal `backlog` epic id). A future
```

Add a new section after the "Identifier rules" table (after line 77's "An archived sibling's id is never reused." paragraph):

```markdown
### The `backlog` epic

Every project is created with a default `backlog` epic at
`projects/<project>/epics/backlog/epic.md`. It is loom's canonical
home for one-off work that doesn't warrant a dedicated epic — bug
fixes, small patches, ad-hoc tasks. Tools may treat `backlog` as a
known, addressable target; loom itself only special-cases it in two
places:

1. `Loom.create_project` writes the backlog epic alongside the
   project file.
2. The CLI's `loom story create <project>` (a bare project qid)
   defaults to creating the story under `<project>:backlog`.

The backlog epic is otherwise a normal epic — same frontmatter,
same status semantics, same dependency rules.
```

- [ ] **Step 2: Update `CLAUDE.md` non-negotiable #2** (around line 63–66).

Change:
```
2. **Epic ids are unique within a project**, not globally; the qualified
   ID disambiguates across projects. They are 7 chars from
   `abcdefghjkmnpqrstvwxyz23456789` (Crockford-ish, no `0/1/i/l/o/u`).
```
to:
```
2. **Epic ids are unique within a project**, not globally; the qualified
   ID disambiguates across projects. They are 7 chars from
   `abcdefghjkmnpqrstvwxyz23456789` (Crockford-ish, no `0/1/i/l/o/u`),
   **or** the literal `backlog` (the auto-created default epic on
   every project — see `docs/MARKDOWN_SPEC.md`).
```

- [ ] **Step 3: Verify the suite still passes.**

Run: `uv run pytest -q`
Expected: all green (no test reads MARKDOWN_SPEC.md or the CLAUDE.md non-negotiable text).

- [ ] **Step 4: Commit.**

```bash
git add docs/MARKDOWN_SPEC.md CLAUDE.md
git commit -m "$(cat <<'EOF'
Document the default backlog epic; bump schema_version to 2

MARKDOWN_SPEC.md: add the literal 'backlog' to the epic-id rule, bump
schema_version 1 -> 2, and add a section describing the backlog
convention. CLAUDE.md: amend non-negotiable #2 with the literal
exception. User explicitly approved the non-negotiable change.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Final verification

**Files:** none (verification only).

- [ ] **Step 1: Lint and format.**

Run:
```bash
uv run ruff check --fix src tests
uv run ruff format src tests
```
Expected: no errors. If ruff makes formatting changes, stage and commit them in a follow-up "style: ruff format" commit.

- [ ] **Step 2: Full test suite.**

Run: `uv run pytest`
Expected: all tests pass.

- [ ] **Step 3: GitNexus impact check.**

Run the `gitnexus_detect_changes` MCP tool with default args. Review the affected processes summary; nothing surprising should appear (changes localized to `ids`, `items`, `api`, `cli`).

- [ ] **Step 4: Manual smoke (optional — only if anything above turned up surprising).**

```bash
LOOM_DIR=/tmp/loom-smoke-$$ uv run loom init
LOOM_DIR=/tmp/loom-smoke-$$ uv run loom project create demo --repo file:///tmp/x --title Demo -y
LOOM_DIR=/tmp/loom-smoke-$$ uv run loom list --type epic --json
# Expect: one epic with qualified_id "demo:backlog".
LOOM_DIR=/tmp/loom-smoke-$$ uv run loom story create demo --title 'Fix bug' -y
LOOM_DIR=/tmp/loom-smoke-$$ uv run loom list --type story --json
# Expect: one story at "demo:backlog:1".
rm -rf /tmp/loom-smoke-$$
```

- [ ] **Step 5: Done. No new commit unless ruff produced changes.**

---

## Deferred (intentionally out of this plan)

**Friendly failure-mode message in `loom project create`.** The spec
describes a polished stderr message when backlog creation fails after
the project file is written ("project created; backlog epic creation
failed — run rebuild..."). This plan lets the exception propagate
generically through `_die_from`, which already surfaces the underlying
error (e.g., `Duplicate: acme:backlog`). The failure rate is
near-zero in practice (only disk-full or permission errors), and the
recovery path is the same either way. Add this polish if it ever
becomes a real user complaint.
