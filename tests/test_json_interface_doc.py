"""Tests that docs/JSON_INTERFACE.md exists and covers required content."""

from __future__ import annotations

from pathlib import Path


def _doc() -> str:
    path = Path(__file__).parent.parent / "docs" / "JSON_INTERFACE.md"
    assert path.exists(), f"docs/JSON_INTERFACE.md not found at {path}"
    return path.read_text(encoding="utf-8")


def test_json_interface_doc_exists() -> None:
    _doc()


def test_json_interface_doc_has_public_contract_preamble() -> None:
    """Must declare itself as a public/stable contract."""
    doc = _doc()
    assert "public" in doc.lower() or "stable" in doc.lower()


def test_json_interface_doc_covers_loom_apply() -> None:
    """Must document loom apply command."""
    doc = _doc()
    assert "loom apply" in doc


def test_json_interface_doc_covers_loom_dep_apply() -> None:
    """Must document loom dep apply command."""
    doc = _doc()
    assert "loom dep apply" in doc


def test_json_interface_doc_has_apply_schema_example() -> None:
    """Must show the items JSON schema for loom apply."""
    doc = _doc()
    assert '"items"' in doc


def test_json_interface_doc_has_dep_apply_schema_example() -> None:
    """Must show the deps JSON schema for loom dep apply."""
    doc = _doc()
    assert '"deps"' in doc


def test_json_interface_doc_covers_stdout_contract() -> None:
    """Must explain stdout vs stderr behavior."""
    doc = _doc()
    assert "stdout" in doc.lower()
    assert "stderr" in doc.lower()


def test_json_interface_doc_covers_exit_codes() -> None:
    """Must document exit codes."""
    doc = _doc()
    assert "exit" in doc.lower()


def test_json_interface_doc_covers_dry_run() -> None:
    """Must document --dry-run flag."""
    doc = _doc()
    assert "--dry-run" in doc


def test_json_interface_doc_covers_stdin() -> None:
    """Must document stdin ('-') support."""
    doc = _doc()
    assert "stdin" in doc.lower() or '"-"' in doc


def test_json_interface_doc_notes_ts_mirror_deferred() -> None:
    """Must note that web/lib TS mirror is intentionally deferred."""
    doc = _doc()
    lower = doc.lower()
    assert "deferred" in lower or "intentionally" in lower


def test_json_interface_doc_covers_validation_rules() -> None:
    """Must cover validation rules (cycle, unknown qid, self-loop, etc.)."""
    doc = _doc()
    lower = doc.lower()
    assert "cycle" in lower
    assert "unknown" in lower or "not found" in lower or "notfound" in lower


def test_json_interface_doc_covers_no_rollback() -> None:
    """Must note partial-failure / no-rollback behavior for loom apply."""
    doc = _doc()
    lower = doc.lower()
    assert "rollback" in lower or "partial" in lower
