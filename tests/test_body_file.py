"""Tests for --body-file flag and Item.set_body_from_file helper."""

from __future__ import annotations

from pathlib import Path

import pytest
from typer.testing import CliRunner

from loom.api import Loom
from loom.cli import app


def test_set_body_from_file_reads_file(loom_dir: Path, tmp_path: Path) -> None:
    body_path = tmp_path / "body.md"
    body_path.write_text("# Heading\n\nbody text.\n", encoding="utf-8")
    loom = Loom(root=loom_dir)
    project = loom.create_project(name="p", title="P")
    epic = project.create_epic(title="e")
    epic.set_body_from_file(body_path)
    assert epic.refresh().body.strip().startswith("# Heading")


def test_set_body_from_file_missing_raises(loom_dir: Path, tmp_path: Path) -> None:
    loom = Loom(root=loom_dir)
    project = loom.create_project(name="p", title="P")
    epic = project.create_epic(title="e")
    with pytest.raises(FileNotFoundError):
        epic.set_body_from_file(tmp_path / "does-not-exist.md")


def test_epic_create_body_file(loom_dir: Path, tmp_path: Path) -> None:
    body_path = tmp_path / "epic-body.md"
    body_path.write_text("## Summary\nthe epic.\n", encoding="utf-8")
    runner = CliRunner()
    # Create the project first
    result = runner.invoke(
        app,
        ["-y", "project", "create", "p", "--root", str(loom_dir), "--repo", "x"],
    )
    assert result.exit_code == 0, result.output
    # Now create the epic with --body-file
    result = runner.invoke(
        app,
        [
            "-y",
            "epic",
            "create",
            "p",
            "--root",
            str(loom_dir),
            "--title",
            "Big work",
            "--body-file",
            str(body_path),
        ],
    )
    assert result.exit_code == 0, result.output
    qid = result.output.strip().split()[-1]
    # The body should be the file's contents
    loom = Loom(root=loom_dir)
    assert loom.get(qid).body.strip().startswith("## Summary")


def test_epic_create_body_and_body_file_mutually_exclusive(loom_dir: Path, tmp_path: Path) -> None:
    body_path = tmp_path / "epic-body.md"
    body_path.write_text("from file\n", encoding="utf-8")
    runner = CliRunner()
    runner.invoke(
        app,
        ["-y", "project", "create", "p", "--root", str(loom_dir), "--repo", "x"],
    )
    result = runner.invoke(
        app,
        [
            "-y",
            "epic",
            "create",
            "p",
            "--root",
            str(loom_dir),
            "--title",
            "Big",
            "--body",
            "inline",
            "--body-file",
            str(body_path),
        ],
    )
    assert result.exit_code != 0
    assert (
        "mutually exclusive" in result.output.lower() or "cannot use both" in result.output.lower()
    )


def test_story_create_body_file(loom_dir: Path, tmp_path: Path) -> None:
    body_path = tmp_path / "story-body.md"
    body_path.write_text("## Summary\nthe story.\n", encoding="utf-8")
    runner = CliRunner()
    runner.invoke(
        app,
        ["-y", "project", "create", "p", "--root", str(loom_dir), "--repo", "x"],
    )
    epic_result = runner.invoke(
        app,
        ["-y", "epic", "create", "p", "--root", str(loom_dir), "--title", "e"],
    )
    epic_qid = epic_result.output.strip().split()[-1]
    result = runner.invoke(
        app,
        [
            "-y",
            "story",
            "create",
            epic_qid,
            "--root",
            str(loom_dir),
            "--title",
            "s",
            "--body-file",
            str(body_path),
        ],
    )
    assert result.exit_code == 0, result.output
    sqid = result.output.strip().split()[-1]
    loom = Loom(root=loom_dir)
    assert loom.get(sqid).body.strip().startswith("## Summary")


def test_task_create_body_file(loom_dir: Path, tmp_path: Path) -> None:
    body_path = tmp_path / "task-body.md"
    body_path.write_text("the task.\n", encoding="utf-8")
    runner = CliRunner()
    runner.invoke(
        app,
        ["-y", "project", "create", "p", "--root", str(loom_dir), "--repo", "x"],
    )
    epic_result = runner.invoke(
        app,
        ["-y", "epic", "create", "p", "--root", str(loom_dir), "--title", "e"],
    )
    epic_qid = epic_result.output.strip().split()[-1]
    story_result = runner.invoke(
        app,
        [
            "-y",
            "story",
            "create",
            epic_qid,
            "--root",
            str(loom_dir),
            "--title",
            "s",
        ],
    )
    story_qid = story_result.output.strip().split()[-1]
    result = runner.invoke(
        app,
        [
            "-y",
            "task",
            "create",
            story_qid,
            "--root",
            str(loom_dir),
            "--title",
            "t",
            "--body-file",
            str(body_path),
        ],
    )
    assert result.exit_code == 0, result.output
    tqid = result.output.strip().split()[-1]
    loom = Loom(root=loom_dir)
    assert loom.get(tqid).body.strip() == "the task."


def test_project_create_body_file(loom_dir: Path, tmp_path: Path) -> None:
    body_path = tmp_path / "p.md"
    body_path.write_text("## Goals\nbig project.\n", encoding="utf-8")
    runner = CliRunner()
    result = runner.invoke(
        app,
        [
            "-y",
            "project",
            "create",
            "myproj",
            "--root",
            str(loom_dir),
            "--repo",
            "x",
            "--body-file",
            str(body_path),
        ],
    )
    assert result.exit_code == 0, result.output
    loom = Loom(root=loom_dir)
    assert loom.get("myproj").body.strip().startswith("## Goals")


def test_update_body_file(loom_dir: Path, tmp_path: Path) -> None:
    runner = CliRunner()
    runner.invoke(
        app,
        ["-y", "project", "create", "p", "--root", str(loom_dir), "--repo", "x"],
    )
    epic_result = runner.invoke(
        app,
        ["-y", "epic", "create", "p", "--root", str(loom_dir), "--title", "e"],
    )
    qid = epic_result.output.strip().split()[-1]
    new_body = tmp_path / "new.md"
    new_body.write_text("## Updated\nnew text.\n", encoding="utf-8")
    result = runner.invoke(
        app,
        [
            "-y",
            "update",
            qid,
            "body",
            "--root",
            str(loom_dir),
            "--body-file",
            str(new_body),
        ],
    )
    assert result.exit_code == 0, result.output
    loom = Loom(root=loom_dir)
    assert loom.get(qid).body.strip().startswith("## Updated")
