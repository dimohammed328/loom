"""Structural test: docs must not contain an orchestrator-log file or removed event vocabulary."""

from __future__ import annotations

from pathlib import Path

REPO_ROOT = Path(__file__).parent.parent
DOCS_DIR = REPO_ROOT / "docs"

# Event kinds removed with the executing-plans skill.
REMOVED_EVENTS = [
    "wave_start",
    "retry_decision",
    "epic_finalize",
    "task_created",
    "task_completed",
    "task_updated",
]


def test_orchestrator_log_doc_absent() -> None:
    """docs/orchestrator-log.md must not exist (the old event-vocabulary doc)."""
    path = DOCS_DIR / "orchestrator-log.md"
    assert not path.exists(), (
        "docs/orchestrator-log.md must be removed — it documented the executing-plans "
        "orchestrator event vocabulary which no longer exists"
    )


def test_docs_no_removed_event_kinds() -> None:
    """No markdown file under docs/ should reference the removed orchestrator event kinds."""
    for md_file in DOCS_DIR.rglob("*.md"):
        content = md_file.read_text()
        for event in REMOVED_EVENTS:
            assert event not in content, (
                f"{md_file.relative_to(REPO_ROOT)} references removed event kind '{event}'; "
                f"update or remove the reference"
            )
