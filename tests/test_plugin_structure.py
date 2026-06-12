"""Structural guards for the plugin: the streamlined /epic-/story architecture.

One orchestrator skill per scale (epic, story), one specialized agent
(story-executor), live loom reads for scheduling — no workflow-generation
layer, no per-step subagents, no logging hooks. These tests pin the
load-bearing invariants so a future edit can't silently regress them.
"""

from __future__ import annotations

import json
from pathlib import Path

PLUGIN_ROOT = Path(__file__).parent.parent / "plugin"
EPIC_SKILL = PLUGIN_ROOT / "skills" / "epic" / "SKILL.md"
STORY_SKILL = PLUGIN_ROOT / "skills" / "story" / "SKILL.md"
STORY_EXECUTOR_MD = PLUGIN_ROOT / "agents" / "story-executor.md"

# Names that belonged to deleted machinery. None may appear anywhere under
# plugin/ — a reference to a nonexistent skill or agent fails silently at
# runtime (the executor's stale `loom:using-loom` reference did exactly that).
DELETED_NAMES = [
    "executing-plans",
    "story-integrator",
    "writing-workflows",
    "writing-plans",
    "loom:brainstorming",
    "using-loom-cli",
    "story-fixer",
    "story-validator",
    "story-merger",
    "code-hygiene",
    "codebase-researcher",
    "epic-validator",
    "loom-log",
    "context-inject",
]


def test_no_references_to_deleted_machinery() -> None:
    for f in PLUGIN_ROOT.rglob("*"):
        if not f.is_file():
            continue
        content = f.read_text(encoding="utf-8", errors="ignore")
        for name in DELETED_NAMES:
            assert name not in content, (
                f"{f.relative_to(PLUGIN_ROOT.parent)} references '{name}', "
                f"which belongs to deleted plugin machinery"
            )


def test_story_executor_is_the_only_agent() -> None:
    agents = sorted(p.name for p in (PLUGIN_ROOT / "agents").glob("*.md"))
    assert agents == ["story-executor.md"], (
        f"plugin/agents must contain exactly story-executor.md, found {agents}; "
        f"per-step subagents (validator/fixer/merger/hygiene) were deliberately "
        f"folded into the orchestrator skills"
    )


def test_story_executor_self_managed_worktree() -> None:
    """The executor creates and *resumes* its own deterministic worktree.

    Required, not stylistic: fix re-dispatches stack commits on the prior
    attempt's branch, and only a deterministic self-created worktree can be
    resumed. Harness-managed isolation (opts.isolation) cannot resume.
    """
    content = STORY_EXECUTOR_MD.read_text()
    assert "git worktree add -b" in content
    assert "resume" in content.lower()


def test_story_executor_forbids_harness_config_self_modification() -> None:
    """Executors once tried to edit .claude/settings.json to disable the
    bgIsolation guard; the prohibition must stay in the Never list."""
    content = STORY_EXECUTOR_MD.read_text()
    never_start = content.find("## Never")
    assert never_start != -1, "story-executor.md must have a '## Never' section"
    next_section = content.find("\n## ", never_start + 1)
    never_section = (
        content[never_start:next_section] if next_section != -1 else content[never_start:]
    )
    assert "harness config" in never_section or "settings.json" in never_section


def test_orchestrator_skills_never_ask_merge_vs_pr() -> None:
    for skill in (EPIC_SKILL, STORY_SKILL):
        content = skill.read_text()
        assert "derived mechanically" in content and "never asked" in content, (
            f"{skill.relative_to(PLUGIN_ROOT.parent)} must derive finalize "
            f"mechanically (PR by default) and forbid asking the user"
        )


def test_orchestrator_skills_forbid_question_ui_for_draft_approval() -> None:
    for skill in (EPIC_SKILL, STORY_SKILL):
        content = skill.read_text()
        assert "AskUserQuestion" in content and "approval" in content, (
            f"{skill.relative_to(PLUGIN_ROOT.parent)} must forbid AskUserQuestion "
            f"for draft approval (plain-text draft, typed reply)"
        )


def test_epic_skill_completes_story_only_after_merge() -> None:
    content = EPIC_SKILL.read_text()
    assert "only after its merge lands" in content, (
        "epic/SKILL.md must pin the loom-complete-after-merge ordering: 'done' "
        "is the only dep-satisfying status, so completing early unblocks "
        "dependents onto a trunk the code isn't on yet"
    )


def test_epic_skill_finalizes_as_stacked_prs_with_review_budget() -> None:
    """Epics ship as a stack of per-story PRs cut at the trunk's story merge
    commits, sized at groom time to a ~500-line review budget. Pinned because
    single multi-thousand-line epic PRs were the original complaint."""
    content = EPIC_SKILL.read_text()
    flat = " ".join(content.split())
    assert "stack of PRs, one per story" in flat, (
        "epic/SKILL.md Phase 7 must finalize as a stack of per-story PRs"
    )
    assert "300-400" in content and "500" in content, (
        "epic/SKILL.md must keep the groom-time diff budget (~300-400 lines "
        "per story, PRs under ~500)"
    )
    assert "first-parent" in content and "load-bearing" in content, (
        "epic/SKILL.md must derive cut points from the trunk's first-parent "
        "merge log, which requires the 'Merge story <qid>' message format "
        "to be marked load-bearing in Phase 5"
    )
    assert "-s<i>" in content and "loom/<SLUG>/s<i>" in content, (
        "epic/SKILL.md must name segment branches with a hyphen "
        "(loom/<SLUG>-s<i>) and warn against the slash form, which is a git "
        "ref directory/file conflict with the trunk branch"
    )
    assert "squash" in content.lower(), (
        "epic/SKILL.md must handle squash-only repos (no stack) and warn "
        "about squash-merging a stack"
    )


def test_skills_frontmatter_name_matches_directory() -> None:
    for skill_md in (PLUGIN_ROOT / "skills").glob("*/SKILL.md"):
        head = skill_md.read_text().split("---")[1]
        name_lines = [line for line in head.splitlines() if line.startswith("name:")]
        assert name_lines, f"{skill_md} frontmatter has no name field"
        name = name_lines[0].split(":", 1)[1].strip()
        assert name == skill_md.parent.name, (
            f"{skill_md}: frontmatter name '{name}' != directory '{skill_md.parent.name}'"
        )


def test_plugin_json_valid_and_hook_free() -> None:
    manifest = json.loads((PLUGIN_ROOT / ".claude-plugin" / "plugin.json").read_text())
    assert manifest["name"] == "loom"
    assert "hooks" not in manifest, (
        "plugin.json must not wire hooks; the only hook is SessionStart in "
        "plugin/hooks/hooks.json (subagent inject and logging hooks were deleted)"
    )


def test_session_start_hook_wired_and_script_exists() -> None:
    hooks = json.loads((PLUGIN_ROOT / "hooks" / "hooks.json").read_text())["hooks"]
    assert list(hooks) == ["SessionStart"], (
        "hooks.json must wire exactly the SessionStart hook (it injects "
        "using-loom-skills; deleting it kills skill discipline in all sessions)"
    )
    script = PLUGIN_ROOT / "scripts" / "session-start"
    assert script.is_file()
    assert script.stat().st_mode & 0o111, "session-start must be executable"
