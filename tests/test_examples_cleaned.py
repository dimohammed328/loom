"""Structural test: scratch example workflow files must be removed."""

from __future__ import annotations

from pathlib import Path

REPO_ROOT = Path(__file__).parent.parent
EXAMPLES_DIR = REPO_ROOT / "examples"


def test_no_workflow_js_files() -> None:
    """examples/*.workflow.js must be removed (design scratch, not shipped artefacts)."""
    if not EXAMPLES_DIR.exists():
        return  # examples/ removed entirely — that's fine
    files = list(EXAMPLES_DIR.glob("*.workflow.js"))
    assert files == [], (
        f"Found scratch workflow.js files that must be removed: "
        f"{[str(f.relative_to(REPO_ROOT)) for f in files]}"
    )


def test_no_workflow_reference_md() -> None:
    """examples/WORKFLOW_REFERENCE.md must be removed (design scratch)."""
    path = EXAMPLES_DIR / "WORKFLOW_REFERENCE.md"
    assert not path.exists(), (
        "examples/WORKFLOW_REFERENCE.md must be removed — it is a design scratch file"
    )
