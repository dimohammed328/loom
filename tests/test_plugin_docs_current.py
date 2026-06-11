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
    donts_section = (
        content[donts_start:next_section] if next_section != -1 else content[donts_start:]
    )
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
    assert "EnterWorktree" in content or (
        "enter" in content.lower() and "worktree" in content.lower()
    ), "writing-workflows/SKILL.md must note the EnterWorktree-before-spawn structural fix"
    assert "spawn" in content.lower() or "dispatch" in content.lower(), (
        "writing-workflows/SKILL.md must mention spawning/dispatching executors "
        "in relation to the worktree entry"
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


def test_plugin_workflows_dir_absent() -> None:
    """plugin/workflows/ must not exist — workflow scripts are generated, not static.

    The static plugin/workflows/ directory was part of the old executing-plans
    backend. Generated workflows now live in .loom/workflows/ (gitignored) at
    plan time. The source templates live in plugin/skills/writing-workflows/templates/.
    """
    workflows_dir = PLUGIN_ROOT / "workflows"
    assert not workflows_dir.exists(), (
        "plugin/workflows/ must not exist; workflow scripts are generated by "
        "loom:writing-workflows into .loom/workflows/ — remove any static scripts "
        "left over from the old executing-plans backend"
    )


def test_plugin_no_executing_plans_reference() -> None:
    """No file under plugin/ may reference 'executing-plans' or 'story-integrator'.

    These names belonged to the old static runner backend which has been
    replaced by baked-DAG workflow scripts generated by loom:writing-workflows.
    """
    stale_terms = ["executing-plans", "story-integrator"]
    for md_file in PLUGIN_ROOT.rglob("*"):
        if not md_file.is_file():
            continue
        try:
            content = md_file.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        for term in stale_terms:
            assert term not in content, (
                f"{md_file.relative_to(PLUGIN_ROOT.parent)} references '{term}'; "
                f"this name belongs to the deleted executing-plans backend — remove it"
            )


def test_templates_use_loom_prefixed_agent_types() -> None:
    """Every agentType in the workflow templates must use the 'loom:' prefix.

    The harness resolves agentTypes from the plugin namespace. Bare names like
    'story-executor' (without the 'loom:' prefix) silently dispatch to the wrong
    agent or are not found. The baked-DAG templates are the canonical source of
    truth for generated workflows.
    """
    import re

    templates_dir = PLUGIN_ROOT / "skills" / "writing-workflows" / "templates"
    for js_file in sorted(templates_dir.glob("*.js")):
        content = js_file.read_text()
        for match in re.finditer(r"agentType:\s*'([^']+)'", content):
            agent_type = match.group(1)
            assert agent_type.startswith("loom:"), (
                f"{js_file.name}: agentType '{agent_type}' is missing the 'loom:' prefix; "
                f"all agent dispatches in the templates must use fully-qualified 'loom:<name>' "
                f"agentTypes so the harness resolves them from the correct plugin namespace"
            )


def test_templates_no_json_stringify_args() -> None:
    """Workflow templates must not pass agent args via JSON.stringify().

    A historical bug passed the args string through JSON.stringify(), producing a
    double-encoded JSON string instead of the plain key=value prompt the agent
    expected. Templates must pass args as plain template literals or strings.
    """
    templates_dir = PLUGIN_ROOT / "skills" / "writing-workflows" / "templates"
    for js_file in sorted(templates_dir.glob("*.js")):
        content = js_file.read_text()
        assert "JSON.stringify" not in content, (
            f"{js_file.name}: found JSON.stringify() — agent args must be passed as plain "
            f"strings (template literals), not JSON-encoded strings; "
            f"this was a historical bug where the harness received a double-encoded payload"
        )
