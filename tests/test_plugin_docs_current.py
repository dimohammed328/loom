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


def test_story_executor_isolation_guard_fallback() -> None:
    """story-executor.md must document the bgIsolation guard fallback.

    When the harness bgIsolation guard blocks Edit/Write, the executor must fall
    back to writing files via Bash heredocs inside the worktree, continue the
    normal TDD+commit loop, and never return BLOCKED solely for this reason.
    The doc must also explicitly forbid modifying .claude/settings.json or any
    harness config.
    """
    content = STORY_EXECUTOR_MD.read_text()
    assert "bgIsolation" in content or "isolation" in content.lower(), (
        "story-executor.md must document the isolation-guard fallback"
    )
    assert "heredoc" in content.lower() or "cat >" in content or "<<'EOF'" in content, (
        "story-executor.md must give a concrete heredoc fallback example"
    )
    assert ".claude/settings.json" in content, (
        "story-executor.md must explicitly forbid modifying .claude/settings.json"
    )
    assert "BLOCKED" in content, (
        "story-executor.md must forbid returning BLOCKED solely due to the isolation guard"
    )


def test_story_executor_donts_forbid_harness_config_self_modification() -> None:
    """The 'What you must NOT do' list must explicitly forbid harness-config self-modification.

    Executors attempted to write .claude/settings.json to disable the bgIsolation
    guard. This must be called out in the canonical don'ts list, not just in the
    fallback section, so it is visible at a glance.
    """
    content = STORY_EXECUTOR_MD.read_text()
    # Find the "What you must NOT do" section and extract only its bullet list
    # (stop at the next top-level ## heading)
    donts_start = content.find("## What you must NOT do")
    assert donts_start != -1, "story-executor.md must have a 'What you must NOT do' section"
    # Find the next ## heading after the donts section
    next_section = content.find("\n## ", donts_start + 1)
    donts_section = content[donts_start:next_section] if next_section != -1 else content[donts_start:]
    assert "settings.json" in donts_section or "harness config" in donts_section, (
        "The 'What you must NOT do' section must explicitly forbid modifying "
        ".claude/settings.json or harness config files"
    )


def test_writing_workflows_notes_enter_worktree_before_spawn() -> None:
    """plugin/skills/writing-workflows/SKILL.md must note the EnterWorktree-before-spawn fix.

    Audit item WF-4: executors hit the bgIsolation guard because the workflow
    spawns them before entering the shared trunk worktree. The structural fix is
    to enter the worktree (EnterWorktree) before spawning executor subagents so
    they inherit the session's isolation. This note belongs in the writing-workflows
    skill so future workflow authors bake this pattern into generated scripts.
    """
    writing_workflows_skill = PLUGIN_ROOT / "skills" / "writing-workflows" / "SKILL.md"
    content = writing_workflows_skill.read_text()
    assert "EnterWorktree" in content or "enter" in content.lower() and "worktree" in content.lower(), (
        "writing-workflows/SKILL.md must note the EnterWorktree-before-spawn structural fix"
    )
    assert "spawn" in content.lower() or "dispatch" in content.lower(), (
        "writing-workflows/SKILL.md must mention spawning/dispatching executors in relation to the worktree entry"
    )
    assert "isolation" in content.lower() or "bgIsolation" in content, (
        "writing-workflows/SKILL.md must connect worktree entry to isolation inheritance"
    )


def test_plugin_readme_no_task_hook_reference() -> None:
    """plugin/README.md must not mention Task lifecycle hooks (TaskCreated/TaskCompleted)."""
    content = PLUGIN_README.read_text()
    assert "SubagentStop/Task/PostToolUse" not in content, (
        "plugin/README.md references Task hook events that have been removed; "
        "update the lifecycle hooks description"
    )
