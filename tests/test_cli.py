from __future__ import annotations

import json
from pathlib import Path

import pytest
from typer.testing import CliRunner

from conftest import write_item
from loom.cli import app
from loom.ids import QualifiedId
from loom.rebuild import rebuild
from loom.storage import dump, load

runner = CliRunner()


# ---------------------------------------------------------------------------
# init
# ---------------------------------------------------------------------------


def test_init_command_fresh(tmp_path: Path) -> None:
    root = tmp_path / "loom"
    result = runner.invoke(app, ["init", "--root", str(root)])
    assert result.exit_code == 0, result.output
    assert "initialized loom at" in result.output
    assert root.is_dir()
    assert (root / "loom.db").is_file()


def test_init_command_idempotent(tmp_path: Path) -> None:
    root = tmp_path / "loom"
    runner.invoke(app, ["init", "--root", str(root)])
    second = runner.invoke(app, ["init", "--root", str(root)])
    assert second.exit_code == 0
    assert "already initialized" in second.output


def test_init_command_uses_env_when_no_root(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    target = tmp_path / "from-env"
    monkeypatch.setenv("LOOM_DIR", str(target))
    monkeypatch.delenv("XDG_DATA_HOME", raising=False)
    result = runner.invoke(app, ["init"])
    assert result.exit_code == 0
    assert target.is_dir()


def test_no_args_shows_help() -> None:
    result = runner.invoke(app, [])
    assert result.exit_code in (0, 2)
    assert "loom" in result.output.lower()


# ---------------------------------------------------------------------------
# rebuild
# ---------------------------------------------------------------------------


def test_rebuild_command_clean(loom_dir: Path) -> None:
    write_item(loom_dir, QualifiedId("foo"))
    result = runner.invoke(app, ["rebuild", "--root", str(loom_dir), "-q"])
    assert result.exit_code == 0
    assert "indexed 1 item" in result.output


def test_rebuild_command_with_issue_exits_nonzero(loom_dir: Path) -> None:
    (loom_dir / "projects" / "stray.md").write_text("---\ntitle: x\n---\n")
    result = runner.invoke(app, ["rebuild", "--root", str(loom_dir), "-q"])
    assert result.exit_code == 1
    assert "stray_file" in result.output


def test_rebuild_logs_rewrites(loom_dir: Path) -> None:
    path = write_item(loom_dir, QualifiedId("foo"))
    fm, body = load(path)
    fm["id"] = "wrong"
    fm["qualified_id"] = "wrong"
    dump(path, fm, body)

    result = runner.invoke(app, ["rebuild", "--root", str(loom_dir)])
    assert "rewrote" in result.output


# ---------------------------------------------------------------------------
# validate
# ---------------------------------------------------------------------------


def test_validate_clean_exits_zero(loom_dir: Path) -> None:
    write_item(loom_dir, QualifiedId("foo"))
    rebuild(loom_dir)
    result = runner.invoke(app, ["validate", "--root", str(loom_dir)])
    assert result.exit_code == 0
    assert "no issues" in result.output


def test_validate_drift_exits_nonzero(loom_dir: Path) -> None:
    path = write_item(loom_dir, QualifiedId("foo"))
    rebuild(loom_dir)
    fm, body = load(path)
    fm["title"] = "edited"
    dump(path, fm, body)

    result = runner.invoke(app, ["validate", "--root", str(loom_dir)])
    assert result.exit_code == 1
    assert "drift" in result.output


def test_validate_json_output(loom_dir: Path) -> None:
    write_item(loom_dir, QualifiedId("foo"), depends_on=["nope:absentab"])
    rebuild(loom_dir)
    result = runner.invoke(app, ["validate", "--root", str(loom_dir), "--json"])
    assert result.exit_code == 1
    payload = json.loads(result.output)
    assert isinstance(payload, list)
    assert any(i["kind"] == "broken_dep" for i in payload)


# ---------------------------------------------------------------------------
# sync
# ---------------------------------------------------------------------------


def test_sync_command_reflects_disk_edits(loom_dir: Path) -> None:
    path = write_item(loom_dir, QualifiedId("foo"), title="initial")
    rebuild(loom_dir)
    fm, body = load(path)
    fm["title"] = "edited"
    dump(path, fm, body)

    result = runner.invoke(app, ["sync", "foo", "--root", str(loom_dir)])
    assert result.exit_code == 0
    assert "synced foo" in result.output


def test_sync_command_unknown_id_exits_not_found(loom_dir: Path) -> None:
    from loom.cli import EXIT_NOT_FOUND

    result = runner.invoke(app, ["sync", "no_such", "--root", str(loom_dir)])
    assert result.exit_code == EXIT_NOT_FOUND


# ---------------------------------------------------------------------------
# statuses
# ---------------------------------------------------------------------------


def test_statuses_command_human(loom_dir: Path) -> None:
    write_item(loom_dir, QualifiedId("foo"))
    write_item(loom_dir, QualifiedId("foo", "abcdefg"), status="ready")
    write_item(loom_dir, QualifiedId("foo", "hjkmnpq"), status="in_progress")
    rebuild(loom_dir)
    result = runner.invoke(app, ["statuses", "--root", str(loom_dir)])
    assert result.exit_code == 0
    lines = [line.strip() for line in result.output.strip().splitlines() if line.strip()]
    assert lines == ["in_progress", "ready"]


def test_statuses_command_json(loom_dir: Path) -> None:
    write_item(loom_dir, QualifiedId("foo"))
    write_item(loom_dir, QualifiedId("foo", "abcdefg"), status="done")
    rebuild(loom_dir)
    result = runner.invoke(app, ["statuses", "--root", str(loom_dir), "--json"])
    assert result.exit_code == 0
    assert json.loads(result.output) == ["done"]


# ---------------------------------------------------------------------------
# Phase 3: project / epic / story / task create
# ---------------------------------------------------------------------------


def _create_project_chain_via_cli(root: Path) -> tuple[str, str, str, str]:
    """Run the four create commands and return the resulting qids."""
    r = runner.invoke(
        app,
        [
            "project",
            "create",
            "acme",
            "--title",
            "Acme",
            "--repo",
            "https://github.com/acme/acme",
            "--default-branch",
            "main",
            "--root",
            str(root),
        ],
    )
    assert r.exit_code == 0, r.output
    assert r.stdout.strip() == "acme"

    r = runner.invoke(app, ["epic", "create", "acme", "--title", "Auth", "--root", str(root)])
    assert r.exit_code == 0, r.output
    epic_qid = r.stdout.strip()

    r = runner.invoke(app, ["story", "create", epic_qid, "--title", "Backend", "--root", str(root)])
    assert r.exit_code == 0, r.output
    story_qid = r.stdout.strip()

    r = runner.invoke(app, ["task", "create", story_qid, "--title", "Wire", "--root", str(root)])
    assert r.exit_code == 0, r.output
    task_qid = r.stdout.strip()

    return "acme", epic_qid, story_qid, task_qid


def test_project_create_round_trip(loom_dir: Path) -> None:
    _create_project_chain_via_cli(loom_dir)
    r = runner.invoke(app, ["project", "list", "--json", "--root", str(loom_dir)])
    assert r.exit_code == 0
    payload = json.loads(r.output)
    assert payload[0]["qualified_id"] == "acme"
    assert payload[0]["repo"] == "https://github.com/acme/acme"
    assert payload[0]["default_branch"] == "main"


def test_create_chain_cli(loom_dir: Path) -> None:
    proj, epic, story, task = _create_project_chain_via_cli(loom_dir)
    # task qid descends from story qid descends from epic qid descends from project.
    assert task.startswith(story + ":")
    assert story.startswith(epic + ":")
    assert epic.startswith(proj + ":")


def test_epic_create_under_non_project_fails(loom_dir: Path) -> None:
    _proj, epic, _story, _task = _create_project_chain_via_cli(loom_dir)
    # Trying to create an epic under an *epic* (not a project) should fail.
    r = runner.invoke(app, ["epic", "create", epic, "--title", "X", "--root", str(loom_dir)])
    assert r.exit_code != 0
    assert "is not a project" in r.output


def test_task_create_under_non_story_fails(loom_dir: Path) -> None:
    _proj, epic, _story, _task = _create_project_chain_via_cli(loom_dir)
    # Trying to create a task under an *epic* should fail.
    r = runner.invoke(app, ["task", "create", epic, "--title", "X", "--root", str(loom_dir)])
    assert r.exit_code != 0
    assert "is not a story" in r.output


def test_project_create_bare_qid_on_stdout(loom_dir: Path) -> None:
    """project create: stdout is exactly the qid; stderr carries the human message."""
    r = runner.invoke(
        app,
        [
            "project",
            "create",
            "acme",
            "--title",
            "Acme",
            "--repo",
            "https://github.com/acme/acme",
            "--root",
            str(loom_dir),
        ],
    )
    assert r.exit_code == 0, r.output
    assert r.stdout.strip() == "acme"
    assert "created acme" in r.stderr


def test_epic_create_bare_qid_on_stdout(loom_dir: Path) -> None:
    """epic create: stdout is exactly the qid; stderr carries the human message."""
    runner.invoke(
        app,
        ["project", "create", "acme", "--title", "Acme", "--repo", "x", "--root", str(loom_dir)],
    )
    r = runner.invoke(app, ["epic", "create", "acme", "--title", "Auth", "--root", str(loom_dir)])
    assert r.exit_code == 0, r.output
    qid = r.stdout.strip()
    assert qid.startswith("acme:")
    assert "created " + qid in r.stderr


def test_story_create_bare_qid_on_stdout(loom_dir: Path) -> None:
    """story create: stdout is exactly the qid; stderr carries the human message."""
    runner.invoke(
        app,
        ["project", "create", "acme", "--title", "Acme", "--repo", "x", "--root", str(loom_dir)],
    )
    re = runner.invoke(app, ["epic", "create", "acme", "--title", "Auth", "--root", str(loom_dir)])
    epic_qid = re.stdout.strip()
    r = runner.invoke(
        app, ["story", "create", epic_qid, "--title", "Backend", "--root", str(loom_dir)]
    )
    assert r.exit_code == 0, r.output
    qid = r.stdout.strip()
    assert qid.startswith(epic_qid + ":")
    assert "created " + qid in r.stderr


def test_task_create_bare_qid_on_stdout(loom_dir: Path) -> None:
    """task create: stdout is exactly the qid; stderr carries the human message."""
    runner.invoke(
        app,
        ["project", "create", "acme", "--title", "Acme", "--repo", "x", "--root", str(loom_dir)],
    )
    re = runner.invoke(app, ["epic", "create", "acme", "--title", "Auth", "--root", str(loom_dir)])
    epic_qid = re.stdout.strip()
    rs = runner.invoke(
        app, ["story", "create", epic_qid, "--title", "Backend", "--root", str(loom_dir)]
    )
    story_qid = rs.stdout.strip()
    r = runner.invoke(
        app, ["task", "create", story_qid, "--title", "Wire", "--root", str(loom_dir)]
    )
    assert r.exit_code == 0, r.output
    qid = r.stdout.strip()
    assert qid.startswith(story_qid + ":")
    assert "created " + qid in r.stderr


def test_story_create_with_assignee_sets_frontmatter(loom_dir: Path) -> None:
    """story create --assignee sets assignee in frontmatter; stdout is still bare qid."""
    runner.invoke(
        app,
        ["project", "create", "acme", "--title", "Acme", "--repo", "x", "--root", str(loom_dir)],
    )
    re = runner.invoke(
        app, ["epic", "create", "acme", "--title", "Auth", "--root", str(loom_dir)]
    )
    epic_qid = re.stdout.strip()
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
            str(loom_dir),
        ],
    )
    assert r.exit_code == 0, r.output
    qid = r.stdout.strip()
    assert qid.startswith(epic_qid + ":")
    from loom.api import Loom

    loom = Loom(loom_dir)
    story = loom.get(qid)
    assert story.assignee == "bob"


def test_epic_create_with_assignee_sets_frontmatter(loom_dir: Path) -> None:
    """epic create --assignee sets assignee in frontmatter; stdout is still bare qid."""
    runner.invoke(
        app,
        ["project", "create", "acme", "--title", "Acme", "--repo", "x", "--root", str(loom_dir)],
    )
    r = runner.invoke(
        app,
        [
            "epic",
            "create",
            "acme",
            "--title",
            "Auth",
            "--assignee",
            "alice",
            "--root",
            str(loom_dir),
        ],
    )
    assert r.exit_code == 0, r.output
    qid = r.stdout.strip()
    assert qid.startswith("acme:")
    # Verify assignee in frontmatter via loom API
    from loom.api import Loom

    loom = Loom(loom_dir)
    epic = loom.get(qid)
    assert epic.assignee == "alice"


# ---------------------------------------------------------------------------
# show / set / archive / status shortcuts
# ---------------------------------------------------------------------------


def test_show_prints_file_contents(loom_dir: Path) -> None:
    proj, _epic, _story, _task = _create_project_chain_via_cli(loom_dir)
    r = runner.invoke(app, ["show", proj, "--root", str(loom_dir)])
    assert r.exit_code == 0
    assert "qualified_id: acme" in r.output
    assert "type: project" in r.output


def test_update_field_updates(loom_dir: Path) -> None:
    _proj, _epic, _story, task = _create_project_chain_via_cli(loom_dir)

    r = runner.invoke(app, ["update", task, "title", "Renamed", "--root", str(loom_dir)])
    assert r.exit_code == 0
    r = runner.invoke(app, ["show", task, "--root", str(loom_dir)])
    assert "title: Renamed" in r.output

    r = runner.invoke(app, ["update", task, "branch", "feat/x", "--root", str(loom_dir)])
    assert r.exit_code == 0
    r = runner.invoke(app, ["update", task, "branch", "", "--root", str(loom_dir)])
    assert r.exit_code == 0  # empty value clears optional field
    r = runner.invoke(app, ["show", task, "--root", str(loom_dir)])
    assert "branch:" not in r.output


def test_update_repo_on_non_project_rejected(loom_dir: Path) -> None:
    _proj, epic, _story, _task = _create_project_chain_via_cli(loom_dir)
    r = runner.invoke(app, ["update", epic, "repo", "https://x", "--root", str(loom_dir)])
    assert r.exit_code != 0
    assert "not settable" in r.output


def test_update_status_on_project_rejected(loom_dir: Path) -> None:
    _proj, _epic, _story, _task = _create_project_chain_via_cli(loom_dir)
    r = runner.invoke(app, ["update", "acme", "status", "ready", "--root", str(loom_dir)])
    assert r.exit_code != 0


def test_canonical_status_shortcuts(loom_dir: Path) -> None:
    _proj, _epic, _story, task = _create_project_chain_via_cli(loom_dir)

    r = runner.invoke(app, ["complete", task, "--root", str(loom_dir)])
    assert r.exit_code == 0 and "-> done" in r.output

    r = runner.invoke(app, ["block", task, "--root", str(loom_dir)])
    assert r.exit_code == 0 and "-> blocked" in r.output

    r = runner.invoke(app, ["mark-ready", task, "--root", str(loom_dir)])
    assert r.exit_code == 0 and "-> ready" in r.output


def test_canonical_status_on_project_rejected(loom_dir: Path) -> None:
    _proj, _epic, _story, _task = _create_project_chain_via_cli(loom_dir)
    r = runner.invoke(app, ["complete", "acme", "--root", str(loom_dir)])
    assert r.exit_code != 0


def test_archive_round_trip(loom_dir: Path) -> None:
    _proj, _epic, _story, task = _create_project_chain_via_cli(loom_dir)
    r = runner.invoke(app, ["archive", task, "--root", str(loom_dir)])
    assert r.exit_code == 0 and "archived" in r.output

    # Listing archived items.
    r = runner.invoke(app, ["list", "--archived", "--type", "task", "--root", str(loom_dir)])
    assert r.exit_code == 0
    assert task in r.output


def test_tag_add_and_rm(loom_dir: Path) -> None:
    _proj, _epic, _story, task = _create_project_chain_via_cli(loom_dir)
    r = runner.invoke(app, ["tag", "add", task, "auth", "urgent", "--root", str(loom_dir)])
    assert r.exit_code == 0
    assert "auth" in r.output and "urgent" in r.output

    r = runner.invoke(app, ["tag", "rm", task, "auth", "--root", str(loom_dir)])
    assert r.exit_code == 0
    assert "auth" not in r.output
    assert "urgent" in r.output


def test_list_filters_and_json(loom_dir: Path) -> None:
    _proj, _epic, _story, task = _create_project_chain_via_cli(loom_dir)
    r = runner.invoke(app, ["list", "--type", "task", "--json", "--root", str(loom_dir)])
    assert r.exit_code == 0
    payload = json.loads(r.output)
    assert len(payload) == 1
    assert payload[0]["qualified_id"] == task


def test_edit_uses_editor_env(monkeypatch: pytest.MonkeyPatch, loom_dir: Path) -> None:
    """Use $EDITOR=true so the subprocess succeeds without input."""
    proj, _epic, _story, _task = _create_project_chain_via_cli(loom_dir)
    monkeypatch.setenv("EDITOR", "true")
    r = runner.invoke(app, ["edit", proj, "--root", str(loom_dir)])
    assert r.exit_code == 0, r.output
    assert "synced acme" in r.output


def test_show_unknown_qid_fails(loom_dir: Path) -> None:
    r = runner.invoke(app, ["show", "no_such_project", "--root", str(loom_dir)])
    assert r.exit_code != 0


# ---------------------------------------------------------------------------
# Phase 4: dep / ready / close
# ---------------------------------------------------------------------------


def _build_two_tasks(loom_dir: Path) -> tuple[str, str]:
    """Create acme/epic/story/(t1, t2). Returns the two task qids in qid order."""
    _proj, _epic, _story, t1 = _create_project_chain_via_cli(loom_dir)
    story_qid = ":".join(t1.split(":")[:-1])
    r = runner.invoke(app, ["task", "create", story_qid, "--title", "T2", "--root", str(loom_dir)])
    assert r.exit_code == 0, r.output
    t2 = r.stdout.strip()
    return t1, t2


def test_dep_add_and_list(loom_dir: Path) -> None:
    t1, t2 = _build_two_tasks(loom_dir)
    r = runner.invoke(app, ["dep", "add", t2, "--on", t1, "--root", str(loom_dir)])
    assert r.exit_code == 0, r.output
    assert f"{t2} -> {t1}" in r.output

    r = runner.invoke(app, ["dep", "list", t2, "--root", str(loom_dir)])
    assert r.exit_code == 0
    assert t1 in r.output

    r = runner.invoke(app, ["dep", "list", t1, "--reverse", "--root", str(loom_dir)])
    assert r.exit_code == 0
    assert t2 in r.output


def test_dep_list_json(loom_dir: Path) -> None:
    t1, t2 = _build_two_tasks(loom_dir)
    runner.invoke(app, ["dep", "add", t2, "--on", t1, "--root", str(loom_dir)])
    r = runner.invoke(app, ["dep", "list", t2, "--json", "--root", str(loom_dir)])
    assert r.exit_code == 0
    payload = json.loads(r.output)
    assert [x["qualified_id"] for x in payload] == [t1]


def test_dep_rm(loom_dir: Path) -> None:
    t1, t2 = _build_two_tasks(loom_dir)
    runner.invoke(app, ["dep", "add", t2, "--on", t1, "--root", str(loom_dir)])
    r = runner.invoke(app, ["dep", "rm", t2, "--on", t1, "--root", str(loom_dir)])
    assert r.exit_code == 0
    assert "removed" in r.output

    r = runner.invoke(app, ["dep", "rm", t2, "--on", t1, "--root", str(loom_dir)])
    assert r.exit_code != 0  # second remove fails — typo protection


def test_dep_add_self_loop_rejected(loom_dir: Path) -> None:
    t1, _t2 = _build_two_tasks(loom_dir)
    r = runner.invoke(app, ["dep", "add", t1, "--on", t1, "--root", str(loom_dir)])
    assert r.exit_code != 0
    assert "cannot depend on itself" in r.output


def test_dep_add_cycle_rejected(loom_dir: Path) -> None:
    t1, t2 = _build_two_tasks(loom_dir)
    runner.invoke(app, ["dep", "add", t2, "--on", t1, "--root", str(loom_dir)])
    r = runner.invoke(app, ["dep", "add", t1, "--on", t2, "--root", str(loom_dir)])
    assert r.exit_code != 0
    assert "cycle" in r.output.lower()


def test_dep_add_on_project_rejected(loom_dir: Path) -> None:
    _t1, t2 = _build_two_tasks(loom_dir)
    r = runner.invoke(app, ["dep", "add", t2, "--on", "acme", "--root", str(loom_dir)])
    assert r.exit_code != 0


def test_ready_command(loom_dir: Path) -> None:
    t1, t2 = _build_two_tasks(loom_dir)
    runner.invoke(app, ["dep", "add", t2, "--on", t1, "--root", str(loom_dir)])
    r = runner.invoke(app, ["ready", "--type", "task", "--root", str(loom_dir)])
    assert r.exit_code == 0
    assert t1 in r.output
    assert t2 not in r.output

    runner.invoke(app, ["complete", t1, "--root", str(loom_dir)])
    r = runner.invoke(app, ["ready", "--type", "task", "--root", str(loom_dir)])
    assert t2 in r.output  # now pickable
    assert t1 not in r.output  # done, not ready


def test_ready_json(loom_dir: Path) -> None:
    t1, _t2 = _build_two_tasks(loom_dir)
    r = runner.invoke(app, ["ready", "--type", "task", "--json", "--root", str(loom_dir)])
    assert r.exit_code == 0
    payload = json.loads(r.output)
    qids = {x["qualified_id"] for x in payload}
    assert t1 in qids


def test_close_requires_flag(loom_dir: Path) -> None:
    _t1, _t2 = _build_two_tasks(loom_dir)
    r = runner.invoke(app, ["close", "acme", "--root", str(loom_dir)])
    assert r.exit_code != 0
    assert "--if-children-done" in r.output


def test_close_if_children_done_via_cli(loom_dir: Path) -> None:
    t1, t2 = _build_two_tasks(loom_dir)
    runner.invoke(app, ["complete", t1, "--root", str(loom_dir)])
    runner.invoke(app, ["complete", t2, "--root", str(loom_dir)])

    r = runner.invoke(app, ["list", "--type", "story", "--json", "--root", str(loom_dir)])
    story = json.loads(r.output)[0]["qualified_id"]

    r = runner.invoke(app, ["close", story, "--if-children-done", "--root", str(loom_dir)])
    assert r.exit_code == 0
    assert "closed" in r.output


def test_close_partial_exits_nonzero(loom_dir: Path) -> None:
    t1, _t2 = _build_two_tasks(loom_dir)
    runner.invoke(app, ["complete", t1, "--root", str(loom_dir)])
    r = runner.invoke(app, ["list", "--type", "story", "--json", "--root", str(loom_dir)])
    story = json.loads(r.output)[0]["qualified_id"]
    r = runner.invoke(app, ["close", story, "--if-children-done", "--root", str(loom_dir)])
    # Partial: t2 not done. Command should exit non-zero and not close.
    assert r.exit_code != 0
    assert "not closed" in r.output
