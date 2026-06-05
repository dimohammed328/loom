"""Structural test: plugin docs must describe the current workflow-backed execution flow."""

from __future__ import annotations

from pathlib import Path

PLUGIN_ROOT = Path(__file__).parent.parent / "plugin"
STORY_EXECUTOR_MD = PLUGIN_ROOT / "agents" / "story-executor.md"
PLUGIN_README = PLUGIN_ROOT / "README.md"


def test_story_executor_is_self_managed_worktree() -> None:
    """story-executor.md must describe the self-managed worktree model.

    The executor creates (or resumes) its own worktree off parent_branch. This is
    REQUIRED, not stylistic: the convergence loop re-dispatches the executor after
    filing fix-tasks, and only a deterministic self-created worktree can be
    *resumed* so the new fix-commits stack on the prior attempt's work. A fresh
    harness-managed worktree per dispatch would lose the earlier commits and never
    converge.
    """
    content = STORY_EXECUTOR_MD.read_text()
    assert "git worktree add -b" in content, (
        "story-executor.md must instruct the executor to create its own worktree "
        "('git worktree add -b … parent_branch') so re-dispatches can resume it"
    )
    assert "resume" in content.lower(), (
        "story-executor.md must document resuming the existing worktree on re-dispatch "
        "(required for the convergence retry loop)"
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
