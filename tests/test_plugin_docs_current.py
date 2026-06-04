"""Structural test: plugin docs must describe the current workflow-backed execution flow."""

from __future__ import annotations

from pathlib import Path

PLUGIN_ROOT = Path(__file__).parent.parent / "plugin"
STORY_EXECUTOR_MD = PLUGIN_ROOT / "agents" / "story-executor.md"
PLUGIN_README = PLUGIN_ROOT / "README.md"


def test_story_executor_no_self_managed_worktree() -> None:
    """story-executor.md must not claim the executor creates its own worktree.

    The harness creates and manages the worktree; the executor is placed in it.
    """
    content = STORY_EXECUTOR_MD.read_text()
    assert "harness does not manage the worktree" not in content, (
        "story-executor.md incorrectly states the harness does not manage the worktree; "
        "update to reflect that the harness creates the worktree"
    )
    # The file may mention "git worktree add" in a prohibition (Do NOT ...) but must
    # not contain instructions telling the executor to run it.
    assert "git worktree add -b" not in content, (
        "story-executor.md must not instruct the executor to run 'git worktree add -b'; "
        "the harness manages worktree creation"
    )


def test_story_executor_no_executing_plans_reference() -> None:
    """story-executor.md must not reference the deleted loom:executing-plans skill."""
    content = STORY_EXECUTOR_MD.read_text()
    assert "loom:executing-plans" not in content, (
        "story-executor.md references the deleted loom:executing-plans skill; remove it"
    )


def test_plugin_readme_no_task_hook_reference() -> None:
    """plugin/README.md must not mention Task lifecycle hooks (TaskCreated/TaskCompleted)."""
    content = PLUGIN_README.read_text()
    assert "SubagentStop/Task/PostToolUse" not in content, (
        "plugin/README.md references Task hook events that have been removed; "
        "update the lifecycle hooks description"
    )
