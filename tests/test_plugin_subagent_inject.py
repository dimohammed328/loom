"""Behavioural test for the SubagentStart context-injection hook.

The hook (`plugin/scripts/loom-subagent-context-inject.sh`) injects a
`## Loom Workflow Context` block for loom's orchestration agents. Claude Code
dispatches plugin agents under namespaced names (e.g. `loom:story-executor`),
so the hook must match both the bare and the `<plugin>:`-prefixed form.
Regression guard for the namespace-prefix mismatch that silently disabled
injection for every real plugin-dispatched agent.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

SCRIPT = Path(__file__).parent.parent / "plugin" / "scripts" / "loom-subagent-context-inject.sh"

TARGET_AGENTS = (
    "story-executor",
    "epic-validator",
    "codebase-researcher",
)


def _run(agent_type: str) -> str:
    payload = json.dumps({"session_id": "SID", "agent_id": "AID", "agent_type": agent_type})
    result = subprocess.run(
        ["bash", str(SCRIPT)],
        input=payload,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    return result.stdout


def _injected_context(stdout: str) -> str:
    """Return the additionalContext string, or '' if nothing was injected."""
    stdout = stdout.strip()
    if not stdout:
        return ""
    return json.loads(stdout)["hookSpecificOutput"]["additionalContext"]


@pytest.mark.parametrize("agent_type", TARGET_AGENTS)
def test_bare_agent_type_injects(agent_type: str) -> None:
    ctx = _injected_context(_run(agent_type))
    assert "## Loom Workflow Context" in ctx
    assert f"agent_type: {agent_type}" in ctx
    assert "assignee SID:AID" in ctx


@pytest.mark.parametrize("agent_type", TARGET_AGENTS)
def test_namespaced_agent_type_injects(agent_type: str) -> None:
    """`loom:<agent>` must inject identically to the bare name."""
    ctx = _injected_context(_run(f"loom:{agent_type}"))
    assert "## Loom Workflow Context" in ctx
    # Namespace prefix is stripped before the block is rendered.
    assert f"agent_type: {agent_type}" in ctx
    assert "assignee SID:AID" in ctx


@pytest.mark.parametrize("agent_type", TARGET_AGENTS)
def test_output_declares_hook_event_name(agent_type: str) -> None:
    """hookSpecificOutput MUST carry hookEventName; Claude Code silently
    discards the injected context (no context reaches the subagent) when
    it is absent."""
    payload = json.loads(_run(agent_type))
    assert payload["hookSpecificOutput"]["hookEventName"] == "SubagentStart"


@pytest.mark.parametrize("agent_type", ["general-purpose", "loom:general-purpose", "Explore"])
def test_non_target_agent_type_is_silent(agent_type: str) -> None:
    """Non-orchestration agents get no injection (silent exit 0)."""
    assert _injected_context(_run(agent_type)) == ""
