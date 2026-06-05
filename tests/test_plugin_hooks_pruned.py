"""Structural test: plugin artifacts must not reference removed orchestrator-only events."""

from __future__ import annotations

import json
from pathlib import Path

PLUGIN_ROOT = Path(__file__).parent.parent / "plugin"
PLUGIN_JSON = PLUGIN_ROOT / ".claude-plugin" / "plugin.json"
LOOM_LOG_SH = PLUGIN_ROOT / "scripts" / "loom-log.sh"
INJECT_SH = PLUGIN_ROOT / "scripts" / "loom-subagent-context-inject.sh"


def _plugin_json() -> dict:
    return json.loads(PLUGIN_JSON.read_text())


def test_plugin_json_no_task_created_hook() -> None:
    """plugin.json must not wire a TaskCreated hook (orchestrator-only, no longer emitted)."""
    hooks = _plugin_json().get("hooks", {})
    assert "TaskCreated" not in hooks, (
        "TaskCreated hook must be removed — story executors no longer use Claude Code TaskCreate"
    )


def test_plugin_json_no_task_completed_hook() -> None:
    """plugin.json must not wire a TaskCompleted hook (orchestrator-only, no longer emitted)."""
    hooks = _plugin_json().get("hooks", {})
    assert "TaskCompleted" not in hooks, (
        "TaskCompleted hook must be removed — story executors no longer use Claude Code TaskCreate"
    )


def test_loom_log_sh_no_task_created_handler() -> None:
    """loom-log.sh must not contain a handle_task_created function."""
    content = LOOM_LOG_SH.read_text()
    assert "handle_task_created" not in content, (
        "handle_task_created must be removed from loom-log.sh"
    )


def test_loom_log_sh_no_task_completed_handler() -> None:
    """loom-log.sh must not contain a handle_task_completed function."""
    content = LOOM_LOG_SH.read_text()
    assert "handle_task_completed" not in content, (
        "handle_task_completed must be removed from loom-log.sh"
    )


def test_loom_log_sh_no_task_updated_handler() -> None:
    """loom-log.sh must not contain a handle_task_updated function."""
    content = LOOM_LOG_SH.read_text()
    assert "handle_task_updated" not in content, (
        "handle_task_updated must be removed from loom-log.sh — "
        "TaskUpdate PostToolUse no longer fires in story executor flow"
    )


def test_inject_sh_no_strict_mode_language() -> None:
    """loom-subagent-context-inject.sh must not reference TaskCreate strict mode enforcement."""
    content = INJECT_SH.read_text()
    assert "strict mode" not in content, (
        "strict-mode TaskCreate language must be removed from context inject script"
    )
    assert "TaskCreate" not in content, (
        "TaskCreate references must be removed from context inject script"
    )
    assert "TaskCompleted" not in content, (
        "TaskCompleted references must be removed from context inject script"
    )
