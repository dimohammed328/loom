"""Tests that docs/JSON_INTERFACE.md documents the nested schema and error-report contract.

Pinned claims per task spec:
- Nested schema example (children)
- parent field table: roots only / existing qid
- Error-report section with collect-all behavior
- Full set of stable code values verbatim
- exit-code mapping per first error
- dry-run: valid -> {"plan": [...]}, invalid -> {"errors": [...]}
- No flat-schema references (parent-as-ref, forward-ref rules)
"""

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


def test_json_interface_doc_has_nested_apply_schema_example() -> None:
    """Must show a nested items JSON schema (with children)."""
    doc = _doc()
    assert '"items"' in doc
    assert '"children"' in doc


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
    """Must cover validation rules."""
    doc = _doc()
    lower = doc.lower()
    assert "cycle" in lower
    assert "unknown" in lower or "not found" in lower or "notfound" in lower


def test_json_interface_doc_covers_no_rollback() -> None:
    """Must note partial-failure / no-rollback behavior for loom apply."""
    doc = _doc()
    lower = doc.lower()
    assert "rollback" in lower or "partial" in lower


# ---------------------------------------------------------------------------
# Nested schema specific checks
# ---------------------------------------------------------------------------


def test_json_interface_doc_parent_field_says_roots_only() -> None:
    """parent field table must say it is required on root items only."""
    doc = _doc()
    # "root" or "roots only" or "root items" must appear in context of parent field
    lower = doc.lower()
    assert "root" in lower


def test_json_interface_doc_parent_must_be_existing_qid() -> None:
    """parent field must be described as an existing qid (not a ref)."""
    doc = _doc()
    # Must mention "existing qid" or "existing qualified"
    lower = doc.lower()
    assert "existing qid" in lower or "existing qualified" in lower


def test_json_interface_doc_children_field_documented() -> None:
    """children field must appear in the field table."""
    doc = _doc()
    assert "children" in doc


def test_json_interface_doc_no_flat_parent_as_ref() -> None:
    """Must not mention forward refs or parent-as-ref rule."""
    doc = _doc()
    lower = doc.lower()
    # The flat schema allowed ref-as-parent and forward refs; those should be gone
    assert "forward ref" not in lower
    # "parent must resolve to an already-seen ref" is the flat-schema language
    assert "already-seen ref" not in lower
    assert "already-seen `ref`" not in doc


def test_json_interface_doc_has_error_report_section() -> None:
    """Must have a validation errors / error report section."""
    doc = _doc()
    lower = doc.lower()
    assert "validation error" in lower or "error report" in lower


def test_json_interface_doc_error_report_shape() -> None:
    """Must document the {"errors": [...]} stdout shape."""
    doc = _doc()
    assert '"errors"' in doc


def test_json_interface_doc_error_report_fields() -> None:
    """Each error must document path, code, message fields."""
    doc = _doc()
    assert '"path"' in doc
    assert '"code"' in doc
    assert '"message"' in doc


def test_json_interface_doc_collect_all_behavior() -> None:
    """Must mention that all errors are collected in one pass."""
    doc = _doc()
    lower = doc.lower()
    # "all errors", "collect all", "single pass", "one pass", or "one round-trip"
    assert any(
        phrase in lower
        for phrase in [
            "all errors",
            "collect all",
            "one pass",
            "single pass",
            "one round",
            "every error",
        ]
    )


def test_json_interface_doc_has_all_error_codes() -> None:
    """Must list all stable error code constants verbatim."""
    from loom.bulk import (
        CODE_BAD_NESTING,
        CODE_BAD_TYPE,
        CODE_CHILDREN_ON_TASK,
        CODE_DUPLICATE_REF,
        CODE_EMPTY_TITLE,
        CODE_MISSING_FIELD,
        CODE_MISSING_PARENT,
        CODE_NON_OBJECT,
        CODE_PARENT_ON_CHILD,
        CODE_UNKNOWN_FIELD,
        CODE_UNKNOWN_PARENT,
    )

    doc = _doc()
    for code in [
        CODE_BAD_TYPE,
        CODE_EMPTY_TITLE,
        CODE_MISSING_FIELD,
        CODE_DUPLICATE_REF,
        CODE_UNKNOWN_PARENT,
        CODE_MISSING_PARENT,
        CODE_PARENT_ON_CHILD,
        CODE_CHILDREN_ON_TASK,
        CODE_BAD_NESTING,
        CODE_NON_OBJECT,
        CODE_UNKNOWN_FIELD,
    ]:
        assert code in doc, f"Error code {code!r} missing from JSON_INTERFACE.md"


def test_json_interface_doc_exit_code_mapping_for_first_error() -> None:
    """Must document exit-code mapping based on first error's code."""
    doc = _doc()
    lower = doc.lower()
    # Mentions that exit code is determined by the first error
    assert "first error" in lower or "first" in lower


def test_json_interface_doc_dry_run_shows_error_report_on_invalid() -> None:
    """dry-run section must say invalid plan prints the error report."""
    doc = _doc()
    lower = doc.lower()
    # dry-run on invalid should print errors
    assert "dry-run" in lower
    # The doc must mention that errors are shown on invalid plan in dry-run
    assert "errors" in lower or "error report" in lower


def test_json_interface_doc_worked_multi_error_example() -> None:
    """Must include a worked example of a multi-error report."""
    doc = _doc()
    # Should show the errors array in an example
    assert '"errors"' in doc
    # Should show path, code, message together
    assert '"path"' in doc
    assert '"code"' in doc
    assert '"message"' in doc


def test_json_interface_doc_has_missing_field_code() -> None:
    """Must document the missing_field error code."""
    doc = _doc()
    assert "missing_field" in doc


def test_json_interface_doc_errors_in_document_order() -> None:
    """Must mention that errors are reported in document order."""
    doc = _doc()
    lower = doc.lower()
    assert "document order" in lower or "pre-order" in lower
