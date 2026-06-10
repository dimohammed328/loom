"""End-to-end tests: build a realistic loom store and exercise every
Phase 2 surface, both via the Python library and via the CLI.
"""

from __future__ import annotations

import json
from pathlib import Path

from typer.testing import CliRunner

from conftest import write_item
from loom.cli import app
from loom.ids import QualifiedId
from loom.index import Index
from loom.rebuild import rebuild
from loom.validation import validate

runner = CliRunner()


def _build_full_chain(loom_dir: Path) -> None:
    """A realistic project → epic → story → task tree with metadata."""
    write_item(
        loom_dir,
        QualifiedId("myproj"),
        title="My Project",
        repo="https://github.com/acme/myproj",
        default_branch="main",
        body="## about\nA real project.\n",
    )
    write_item(
        loom_dir,
        QualifiedId("myproj", "abcdefg"),
        title="Add OAuth",
        status="ready",
        tags=["auth", "security"],
        body="## context\nUsers need to log in via Google.\n",
    )
    write_item(
        loom_dir,
        QualifiedId("myproj", "abcdefg", 1),
        title="Backend pieces",
        status="in_progress",
        assignee="alice",
        branch="feat/oauth-backend",
    )
    write_item(
        loom_dir,
        QualifiedId("myproj", "abcdefg", 1, 1),
        title="Wire Google provider",
        status="ready",
        depends_on=["myproj:abcdefg:1"],
        tags=["auth"],
        pr_url="https://github.com/acme/myproj/pull/42",
    )


# ---------------------------------------------------------------------------
# Library end-to-end
# ---------------------------------------------------------------------------


def test_library_e2e_full_round_trip(loom_dir: Path) -> None:
    _build_full_chain(loom_dir)

    result = rebuild(loom_dir)
    assert result.indexed_count == 4
    assert result.issues == ()
    assert result.rewrites == ()

    idx = Index(loom_dir)

    # Project metadata round-trips, including repo + default_branch.
    project = idx.get("myproj")
    assert project is not None
    assert project.type == "project"
    assert project.status is None  # projects don't carry a status
    assert project.repo == "https://github.com/acme/myproj"
    assert project.default_branch == "main"

    # Epic carries tags.
    epic = idx.get("myproj:abcdefg")
    assert epic is not None
    assert set(epic.tags) == {"auth", "security"}
    assert epic.status == "ready"

    # Story carries assignee + branch and uses the in_progress status.
    story = idx.get("myproj:abcdefg:1")
    assert story is not None
    assert story.assignee == "alice"
    assert story.branch == "feat/oauth-backend"
    assert story.status == "in_progress"
    assert story.parent_id == "myproj:abcdefg"

    # Task has a dep, a pr_url, and a tag.
    task = idx.get("myproj:abcdefg:1:1")
    assert task is not None
    assert task.depends_on == ("myproj:abcdefg:1",)
    assert task.tags == ("auth",)
    assert task.pr_url == "https://github.com/acme/myproj/pull/42"
    assert task.parent_id == "myproj:abcdefg:1"

    # Validate reports no issues for a freshly rebuilt store.
    assert validate(loom_dir) == []


def test_library_e2e_status_discovery(loom_dir: Path) -> None:
    _build_full_chain(loom_dir)
    rebuild(loom_dir)
    # The chain has two distinct statuses (project has none).
    assert Index(loom_dir).statuses() == ["in_progress", "ready"]


def test_library_e2e_find_filters(loom_dir: Path) -> None:
    _build_full_chain(loom_dir)
    rebuild(loom_dir)
    idx = Index(loom_dir)

    assert {r.qualified_id for r in idx.find(type="task")} == {"myproj:abcdefg:1:1"}
    assert {r.qualified_id for r in idx.find(status="in_progress")} == {"myproj:abcdefg:1"}
    assert {r.qualified_id for r in idx.find(assignee="alice")} == {"myproj:abcdefg:1"}
    assert {r.qualified_id for r in idx.find(tag="auth")} == {
        "myproj:abcdefg",
        "myproj:abcdefg:1:1",
    }
    assert {r.qualified_id for r in idx.find(project="myproj")} == {
        "myproj",
        "myproj:abcdefg",
        "myproj:abcdefg:1",
        "myproj:abcdefg:1:1",
    }


def test_library_e2e_validate_catches_post_rebuild_drift(loom_dir: Path) -> None:
    _build_full_chain(loom_dir)
    rebuild(loom_dir)

    # Hand-edit a file to simulate an external change.
    task_path = loom_dir / "projects/myproj/epics/abcdefg/stories/1/tasks/1.md"
    task_path.write_text(task_path.read_text() + "\nappended\n")

    issues = validate(loom_dir)
    kinds = {i.kind for i in issues}
    assert "drift" in kinds


# ---------------------------------------------------------------------------
# CLI end-to-end
# ---------------------------------------------------------------------------


def test_cli_e2e_full_workflow(tmp_path: Path) -> None:
    """init → populate → rebuild → validate → statuses, all via the CLI."""
    root = tmp_path / "loom"

    # init
    r = runner.invoke(app, ["init", "--root", str(root)])
    assert r.exit_code == 0, r.output

    # Populate the store using the library helper (writing markdown is
    # not the CLI's job in Phase 2).
    _build_full_chain(root)

    # rebuild
    r = runner.invoke(app, ["rebuild", "--root", str(root), "-q"])
    assert r.exit_code == 0, r.output
    assert "indexed 4 item" in r.output

    # validate
    r = runner.invoke(app, ["validate", "--root", str(root)])
    assert r.exit_code == 0, r.output
    assert "no issues" in r.output

    # statuses (human)
    r = runner.invoke(app, ["statuses", "--root", str(root)])
    assert r.exit_code == 0
    lines = [line for line in r.output.strip().splitlines() if line.strip()]
    assert lines == ["in_progress", "ready"]

    # statuses (json)
    r = runner.invoke(app, ["statuses", "--root", str(root), "--json"])
    assert r.exit_code == 0
    assert json.loads(r.output) == ["in_progress", "ready"]


def test_cli_e2e_validate_json_after_drift(tmp_path: Path) -> None:
    root = tmp_path / "loom"
    runner.invoke(app, ["init", "--root", str(root)])
    _build_full_chain(root)
    runner.invoke(app, ["rebuild", "--root", str(root), "-q"])

    # External edit → drift.
    task_path = root / "projects/myproj/epics/abcdefg/stories/1/tasks/1.md"
    task_path.write_text(task_path.read_text() + "\nappended\n")

    r = runner.invoke(app, ["validate", "--root", str(root), "--json"])
    assert r.exit_code == 1
    payload = json.loads(r.output)
    assert any(i["kind"] == "drift" for i in payload)


def test_cli_e2e_sync_resolves_drift(tmp_path: Path) -> None:
    root = tmp_path / "loom"
    runner.invoke(app, ["init", "--root", str(root)])
    _build_full_chain(root)
    runner.invoke(app, ["rebuild", "--root", str(root), "-q"])

    # Edit the file out-of-band.
    task_path = root / "projects/myproj/epics/abcdefg/stories/1/tasks/1.md"
    task_path.write_text(task_path.read_text() + "\nappended\n")

    # Validate should flag drift first.
    r = runner.invoke(app, ["validate", "--root", str(root)])
    assert r.exit_code == 1
    assert "drift" in r.output

    # Sync just the affected item — should clear the drift.
    r = runner.invoke(app, ["sync", "myproj:abcdefg:1:1", "--root", str(root)])
    assert r.exit_code == 0
    assert "synced myproj:abcdefg:1:1" in r.output

    # Now validate is clean.
    r = runner.invoke(app, ["validate", "--root", str(root)])
    assert r.exit_code == 0


def test_cli_e2e_rebuild_with_broken_dep_exits_nonzero(tmp_path: Path) -> None:
    root = tmp_path / "loom"
    runner.invoke(app, ["init", "--root", str(root)])
    write_item(
        root,
        QualifiedId("myproj"),
        depends_on=[],  # projects don't have deps but write_item won't enforce
    )
    write_item(
        root,
        QualifiedId("myproj", "abcdefg"),
        depends_on=["other:absentab"],  # target doesn't exist
    )

    r = runner.invoke(app, ["rebuild", "--root", str(root), "-q"])
    assert r.exit_code == 1
    assert "broken_dep" in r.output

    # Despite the broken dep, the source item is still indexed.
    r = runner.invoke(app, ["validate", "--root", str(root), "--json"])
    payload = json.loads(r.output)
    assert any(i["kind"] == "broken_dep" and i["qualified_id"] == "myproj:abcdefg" for i in payload)


# ---------------------------------------------------------------------------
# Phase 3: library + CLI driven entirely through the public surface.
# ---------------------------------------------------------------------------


def test_library_e2e_facade_full_chain(loom_dir: Path) -> None:
    """Drive the entire chain through the public Loom facade — no helpers."""
    from loom import Epic, Loom, Project, Story, Task

    loom = Loom(root=loom_dir)
    project = loom.create_project(
        "myproj",
        title="My Project",
        repo="https://github.com/acme/myproj",
        default_branch="main",
        body="## about\n",
    )
    epic = project.create_epic(title="Add OAuth", body="user story\n")
    epic.add_tag("auth").add_tag("security")

    story = epic.create_story(title="Backend pieces", body="")
    story.set_assignee("alice").set_branch("feat/oauth-backend").set_status("in_progress")

    task = story.create_task(title="Wire Google", body="")
    task.set_pr_url("https://github.com/acme/myproj/pull/42").add_tag("auth")
    task.complete()

    # Fresh fetches return the right subclasses.
    assert isinstance(loom.get(project.qualified_id), Project)
    assert isinstance(loom.get(epic.qualified_id), Epic)
    assert isinstance(loom.get(story.qualified_id), Story)
    assert isinstance(loom.get(task.qualified_id), Task)

    # Status filters work across the full chain.
    done_tasks = loom.find(type="task", status="done")
    assert {t.qualified_id for t in done_tasks} == {task.qualified_id}

    # Status discovery sees both canonical and custom labels.
    assert set(loom.statuses()) >= {"done", "in_progress", "ready"}

    # Validation is clean.
    assert loom.validate() == []


def test_library_e2e_archive_skips_collision(loom_dir: Path) -> None:
    """Archived siblings reserve their ids; the next sibling skips past."""
    from loom import Epic, Loom

    loom = Loom(root=loom_dir)
    project = loom.create_project("myproj", title="P")
    epic = project.create_epic(title="E")
    s1 = epic.create_story(title="s1")
    s2 = epic.create_story(title="s2")
    s2.archive()
    fresh_epic = loom.get(epic.qualified_id)
    assert isinstance(fresh_epic, Epic)
    s3 = fresh_epic.create_story(title="s3")
    assert s3.qualified_id == f"{epic.qualified_id}:3"
    assert s1.qualified_id == f"{epic.qualified_id}:1"


def test_cli_e2e_create_chain(tmp_path: Path) -> None:
    """Build the full chain through CLI commands only."""
    root = tmp_path / "loom"
    runner.invoke(app, ["init", "--root", str(root)])

    r = runner.invoke(
        app,
        [
            "project",
            "create",
            "myproj",
            "--title",
            "MyProj",
            "--repo",
            "https://github.com/acme/myproj",
            "--default-branch",
            "main",
            "--root",
            str(root),
        ],
    )
    assert r.exit_code == 0

    r = runner.invoke(app, ["epic", "create", "myproj", "--title", "Auth", "--root", str(root)])
    assert r.exit_code == 0
    epic_qid = r.stdout.strip()

    r = runner.invoke(app, ["story", "create", epic_qid, "--title", "Backend", "--root", str(root)])
    assert r.exit_code == 0
    story_qid = r.stdout.strip()

    r = runner.invoke(app, ["task", "create", story_qid, "--title", "Wire", "--root", str(root)])
    assert r.exit_code == 0
    task_qid = r.stdout.strip()

    r = runner.invoke(app, ["complete", task_qid, "--root", str(root)])
    assert r.exit_code == 0

    r = runner.invoke(
        app,
        ["list", "--type", "task", "--status", "done", "--json", "--root", str(root)],
    )
    payload = json.loads(r.output)
    assert {x["qualified_id"] for x in payload} == {task_qid}

    r = runner.invoke(app, ["validate", "--root", str(root)])
    assert r.exit_code == 0


def test_cli_e2e_create_with_assignee(tmp_path: Path) -> None:
    """epic create --assignee and story create --assignee set frontmatter in one call."""
    root = tmp_path / "loom"
    runner.invoke(app, ["init", "--root", str(root)])
    runner.invoke(
        app,
        [
            "project",
            "create",
            "myproj",
            "--title",
            "MyProj",
            "--repo",
            "https://github.com/acme/myproj",
            "--root",
            str(root),
        ],
    )

    # Epic create with assignee
    r = runner.invoke(
        app,
        ["epic", "create", "myproj", "--title", "Auth", "--assignee", "alice", "--root", str(root)],
    )
    assert r.exit_code == 0, r.output
    epic_qid = r.stdout.strip()

    # Story create with assignee
    r = runner.invoke(
        app,
        [
            "story",
            "create",
            epic_qid,
            "--title",
            "Backend",
            "--assignee",
            "bob",
            "--root",
            str(root),
        ],
    )
    assert r.exit_code == 0, r.output
    story_qid = r.stdout.strip()

    # Verify via loom show --json (CLI surface)
    r = runner.invoke(app, ["show", epic_qid, "--json", "--root", str(root)])
    assert r.exit_code == 0, r.output
    epic_data = json.loads(r.output)
    assert epic_data["frontmatter"]["assignee"] == "alice"

    r = runner.invoke(app, ["show", story_qid, "--json", "--root", str(root)])
    assert r.exit_code == 0, r.output
    story_data = json.loads(r.output)
    assert story_data["frontmatter"]["assignee"] == "bob"

    # Stdout must still be the bare qid only (no extra lines)
    assert "\n" not in epic_qid
    assert "\n" not in story_qid

    # task create --assignee must be rejected
    r_task = runner.invoke(
        app,
        ["task", "create", story_qid, "--title", "Wire", "--assignee", "carol", "--root", str(root)],
    )
    assert r_task.exit_code != 0


# ---------------------------------------------------------------------------
# Phase 4: full dependency / ready / close lifecycle through both surfaces.
# ---------------------------------------------------------------------------


def test_library_e2e_dep_chain_ready_and_close(loom_dir: Path) -> None:
    """A two-task dependency chain: build → block → unblock → close."""
    from loom import Loom

    loom = Loom(root=loom_dir)
    project = loom.create_project("acme", title="Acme")
    epic = project.create_epic(title="Auth")
    story = epic.create_story(title="Backend")
    t1 = story.create_task(title="Bootstrap")
    t2 = story.create_task(title="Wire google")

    # t2 depends on t1.
    loom.get(t2.qualified_id).depends_on(t1.qualified_id)  # type: ignore[union-attr]

    # Initially t1 is pickable; t2 is blocked.
    ready_now = {x.qualified_id for x in loom.ready(type="task")}
    assert t1.qualified_id in ready_now
    assert t2.qualified_id not in ready_now

    # Complete t1, t2 unblocks.
    loom.get(t1.qualified_id).complete()  # type: ignore[union-attr]
    ready_after = {x.qualified_id for x in loom.ready(type="task")}
    assert t2.qualified_id in ready_after

    # Complete t2 too. close-if-children-done bubbles up the chain.
    loom.get(t2.qualified_id).complete()  # type: ignore[union-attr]
    assert loom.close_if_children_done(story.qualified_id) is True
    assert loom.close_if_children_done(epic.qualified_id) is True
    assert loom.get(epic.qualified_id).status == "done"  # type: ignore[union-attr]

    # And the index stays consistent.
    assert loom.validate() == []


def test_cli_e2e_dep_ready_close(tmp_path: Path) -> None:
    """Same lifecycle as above, but driven entirely through the CLI."""
    root = tmp_path / "loom"
    runner.invoke(app, ["init", "--root", str(root)])
    runner.invoke(
        app,
        [
            "project",
            "create",
            "acme",
            "--title",
            "Acme",
            "--repo",
            "https://example/acme",
            "--root",
            str(root),
        ],
    )
    r = runner.invoke(app, ["epic", "create", "acme", "--title", "E", "--root", str(root)])
    epic = r.stdout.strip()
    r = runner.invoke(app, ["story", "create", epic, "--title", "S", "--root", str(root)])
    story = r.stdout.strip()
    r = runner.invoke(app, ["task", "create", story, "--title", "T1", "--root", str(root)])
    t1 = r.stdout.strip()
    r = runner.invoke(app, ["task", "create", story, "--title", "T2", "--root", str(root)])
    t2 = r.stdout.strip()

    runner.invoke(app, ["dep", "add", t2, "--on", t1, "--root", str(root)])
    r = runner.invoke(app, ["ready", "--type", "task", "--root", str(root)])
    assert t1 in r.output and t2 not in r.output

    runner.invoke(app, ["complete", t1, "--root", str(root)])
    runner.invoke(app, ["complete", t2, "--root", str(root)])

    r = runner.invoke(app, ["close", story, "--if-children-done", "--root", str(root)])
    assert r.exit_code == 0
    r = runner.invoke(app, ["close", epic, "--if-children-done", "--root", str(root)])
    assert r.exit_code == 0

    # Validate is clean.
    r = runner.invoke(app, ["validate", "--root", str(root)])
    assert r.exit_code == 0


def test_loom_workflow_chain_via_cli(loom_dir: Path, tmp_path: Path) -> None:
    """Drive a /epic-shaped flow end-to-end through the CLI:

    1. Create project, epic with --body-file
    2. Create two stories with --body-file
    3. Create tasks on story 1, deps between them
    4. Verify loom tree, loom order, loom ready
    5. Complete tasks, mark story done, run loom reopen
    6. Verify reopen reset state correctly
    """
    from loom.api import Loom

    body_path = tmp_path / "body.md"
    body_path.write_text("## Validation Criteria\n- [ ] criterion\n", encoding="utf-8")

    # 1. project + epic
    r = runner.invoke(
        app,
        ["-y", "project", "create", "myproj", "--root", str(loom_dir), "--repo", "x"],
    )
    assert r.exit_code == 0, r.output
    r = runner.invoke(
        app,
        [
            "-y",
            "epic",
            "create",
            "myproj",
            "--root",
            str(loom_dir),
            "--title",
            "Big",
            "--body-file",
            str(body_path),
        ],
    )
    assert r.exit_code == 0, r.output
    epic_qid = r.output.strip().split()[-1]

    # 2. two stories
    r = runner.invoke(
        app,
        [
            "-y",
            "story",
            "create",
            epic_qid,
            "--root",
            str(loom_dir),
            "--title",
            "s1",
            "--body-file",
            str(body_path),
        ],
    )
    assert r.exit_code == 0, r.output
    s1_qid = r.output.strip().split()[-1]
    r = runner.invoke(
        app,
        [
            "-y",
            "story",
            "create",
            epic_qid,
            "--root",
            str(loom_dir),
            "--title",
            "s2",
            "--body-file",
            str(body_path),
        ],
    )
    assert r.exit_code == 0, r.output
    s2_qid = r.output.strip().split()[-1]
    # s2 depends on s1
    r = runner.invoke(
        app,
        ["-y", "dep", "add", s2_qid, "--on", s1_qid, "--root", str(loom_dir)],
    )
    assert r.exit_code == 0, r.output

    # 3. two tasks on s1
    r = runner.invoke(
        app,
        ["-y", "task", "create", s1_qid, "--root", str(loom_dir), "--title", "t1"],
    )
    assert r.exit_code == 0, r.output
    t1_qid = r.output.strip().split()[-1]
    r = runner.invoke(
        app,
        ["-y", "task", "create", s1_qid, "--root", str(loom_dir), "--title", "t2"],
    )
    assert r.exit_code == 0, r.output
    t2_qid = r.output.strip().split()[-1]
    r = runner.invoke(
        app,
        ["-y", "dep", "add", t2_qid, "--on", t1_qid, "--root", str(loom_dir)],
    )
    assert r.exit_code == 0, r.output

    # 4. tree, order, ready
    r = runner.invoke(app, ["tree", epic_qid, "--root", str(loom_dir), "--json"])
    assert r.exit_code == 0, r.output
    data = json.loads(r.output)
    assert len(data["items"]) == 5  # epic + 2 stories + 2 tasks

    r = runner.invoke(app, ["order", s1_qid, "--root", str(loom_dir), "--json"])
    assert r.exit_code == 0, r.output
    data = json.loads(r.output)
    qids = [e["qualified_id"] for e in data]
    assert qids == [t1_qid, t2_qid]  # topo order

    # The auto-created backlog epic is a SIBLING (under myproj), not under
    # our epic, so it does not appear in `loom ready <epic_qid> --type story`.
    r = runner.invoke(
        app,
        ["ready", epic_qid, "--root", str(loom_dir), "--type", "story", "--json"],
    )
    assert r.exit_code == 0, r.output
    data = json.loads(r.output)
    assert {e["qualified_id"] for e in data} == {s1_qid}  # s2 blocked

    # 5. complete tasks + story, reopen
    r = runner.invoke(app, ["-y", "complete", t1_qid, "--root", str(loom_dir)])
    assert r.exit_code == 0, r.output
    r = runner.invoke(app, ["-y", "complete", t2_qid, "--root", str(loom_dir)])
    assert r.exit_code == 0, r.output
    r = runner.invoke(app, ["-y", "complete", s1_qid, "--root", str(loom_dir)])
    assert r.exit_code == 0, r.output
    r = runner.invoke(app, ["reopen", s1_qid, "--root", str(loom_dir)])
    assert r.exit_code == 0, r.output

    # 6. verify reset
    loom = Loom(root=loom_dir)
    assert loom.get(s1_qid).status == "ready"
    assert loom.get(t1_qid).status == "ready"
    assert loom.get(t2_qid).status == "ready"
