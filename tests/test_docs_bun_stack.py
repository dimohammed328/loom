"""Structural test: CLAUDE.md must document the Bun/TS stack after docs update."""
from __future__ import annotations

from pathlib import Path


def _load_claude_md() -> str:
    path = Path(__file__).parent.parent / "CLAUDE.md"
    return path.read_text()


def test_claude_md_documents_bun_dev_command() -> None:
    """CLAUDE.md commands table must include bun run dev."""
    content = _load_claude_md()
    assert "bun run dev" in content, (
        "CLAUDE.md must document 'bun run dev' for the Bun server"
    )


def test_claude_md_documents_bun_test_command() -> None:
    """CLAUDE.md commands table must include bun test."""
    content = _load_claude_md()
    assert "bun test" in content, (
        "CLAUDE.md must document 'bun test' for the TS test suite"
    )


def test_claude_md_documents_bun_typecheck_command() -> None:
    """CLAUDE.md commands table must include bun run typecheck."""
    content = _load_claude_md()
    assert "bun run typecheck" in content, (
        "CLAUDE.md must document 'bun run typecheck' for TS type checking"
    )


def test_claude_md_references_web_directory() -> None:
    """CLAUDE.md must reference the web/ directory."""
    content = _load_claude_md()
    assert "web/" in content, (
        "CLAUDE.md must reference the web/ directory"
    )


def test_web_readme_exists() -> None:
    """web/README.md must exist and describe the Bun stack."""
    readme = Path(__file__).parent.parent / "web" / "README.md"
    assert readme.exists(), "web/README.md must exist"
    content = readme.read_text()
    assert "bun run dev" in content, "web/README.md must document bun run dev"
    assert "bun run start" in content, "web/README.md must document bun run start"
