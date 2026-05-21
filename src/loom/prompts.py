"""Interactive prompt helpers for the CLI.

All entry points obey one rule: they raise :class:`LoomError` when the
caller is non-interactive (``sys.stdin.isatty() is False`` or the user
passed ``--non-interactive``). Interactive paths shell out to ``fzf`` for
selection (falling back to a stdlib numbered picker) and to ``$EDITOR``
for free-form input.

The TTY check is what keeps :class:`typer.testing.CliRunner` tests
behaving exactly as before — CliRunner's stdin reports ``isatty()`` as
False, so missing-arg flows still surface as today's errors.
"""

from __future__ import annotations

import os
import shlex
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .errors import LoomError
from .storage import parse as parse_markdown


@dataclass(frozen=True, slots=True)
class Candidate:
    """One option in a :func:`pick_one` selection list."""

    qid: str
    type: str
    title: str
    status: str | None


def is_interactive(non_interactive: bool) -> bool:
    """True iff the CLI may prompt the user."""
    return bool(sys.stdin.isatty()) and not non_interactive


# ---------------------------------------------------------------------------
# Picker
# ---------------------------------------------------------------------------


def pick_one(
    candidates: list[Candidate],
    *,
    prompt: str,
    preselect: str | None,
    non_interactive: bool,
) -> str:
    """Return the qid of a candidate chosen interactively.

    Raises :class:`LoomError` when there are no candidates, when the
    caller is non-interactive, or when the user cancels.
    """
    if not candidates:
        raise LoomError(f"{prompt}: nothing to choose from")
    if not is_interactive(non_interactive):
        raise LoomError(
            f"{prompt}: required (no value supplied and stdin is not a tty / --non-interactive set)"
        )
    if shutil.which("fzf"):
        return _pick_fzf(candidates, prompt=prompt, preselect=preselect)
    return _pick_fallback(candidates, prompt=prompt, preselect=preselect)


def _candidate_line(c: Candidate) -> str:
    return f"{c.qid}\t{c.type}\t{c.title}\t{c.status or ''}"


def _pick_fzf(candidates: list[Candidate], *, prompt: str, preselect: str | None) -> str:
    args = [
        "fzf",
        "--prompt",
        f"{prompt}> ",
        "--delimiter",
        "\t",
        "--with-nth=1..",
        "--header",
        "qid\ttype\ttitle\tstatus",
    ]
    if preselect:
        args.extend(["--query", preselect])
    proc = subprocess.Popen(
        args,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
    )
    payload = "\n".join(_candidate_line(c) for c in candidates) + "\n"
    out, _ = proc.communicate(payload)
    if proc.returncode != 0:
        raise LoomError("selection cancelled")
    line = out.strip()
    if not line:
        raise LoomError("selection cancelled")
    return line.split("\t", 1)[0]


def _pick_fallback(
    candidates: list[Candidate],
    *,
    prompt: str,
    preselect: str | None,
) -> str:
    default_idx: int | None = None
    print(f"\n{prompt}:", file=sys.stderr)
    for i, c in enumerate(candidates, start=1):
        marker = ""
        if preselect and c.qid == preselect:
            default_idx = i
            marker = " (default)"
        status = f" [{c.status}]" if c.status else ""
        print(f"  {i}. {c.qid}\t{c.type}{status}\t{c.title}{marker}", file=sys.stderr)

    suffix = (
        f" [1-{len(candidates)}, Enter for default, Q to cancel]"
        if default_idx
        else (f" [1-{len(candidates)}, Q to cancel]")
    )
    for _attempt in range(3):
        try:
            raw = input(f"{prompt}{suffix}: ").strip()
        except EOFError as e:
            raise LoomError("selection cancelled") from e
        if raw.lower() == "q":
            raise LoomError("selection cancelled")
        if not raw and default_idx:
            return candidates[default_idx - 1].qid
        try:
            n = int(raw)
        except ValueError:
            print(f"  invalid choice {raw!r}; try again", file=sys.stderr)
            continue
        if 1 <= n <= len(candidates):
            return candidates[n - 1].qid
        print(f"  out of range; pick 1-{len(candidates)}", file=sys.stderr)
    raise LoomError("selection cancelled after 3 invalid attempts")


# ---------------------------------------------------------------------------
# Editor
# ---------------------------------------------------------------------------


def launch_editor(path: Path) -> int:
    """Open *path* in ``$EDITOR`` (falling back to ``vi``). Return exit code."""
    editor_env = os.environ.get("EDITOR") or os.environ.get("VISUAL") or "vi"
    cmd = shlex.split(editor_env)
    proc = subprocess.run([*cmd, str(path)], check=False)
    return proc.returncode


def prompt_editor_template(
    template_text: str,
    *,
    non_interactive: bool,
) -> dict[str, Any]:
    """Open ``$EDITOR`` on a temp file containing *template_text*; parse it back.

    Returns ``{"title": str | None, "body": str, "frontmatter": dict}`` —
    callers typically pull ``title`` and ``body``. Raises :class:`LoomError`
    on cancel / non-interactive / nonzero editor exit.
    """
    if not is_interactive(non_interactive):
        raise LoomError(
            "title/body required (no value supplied and stdin is not a tty / --non-interactive set)"
        )
    fd, tmp_str = tempfile.mkstemp(suffix=".md", prefix="loom-")
    tmp = Path(tmp_str)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(template_text)
        code = launch_editor(tmp)
        if code != 0:
            raise LoomError(f"editor exited with code {code}")
        text = tmp.read_text(encoding="utf-8")
    finally:
        tmp.unlink(missing_ok=True)

    fm, body = parse_markdown(text, source="<editor template>")
    title = fm.get("title")
    if isinstance(title, str):
        title = title.strip() or None
    return {"title": title, "body": body, "frontmatter": fm}


def prompt_editor_file(path: Path, *, non_interactive: bool) -> None:
    """Open *path* in ``$EDITOR``; raise on cancel or nonzero exit."""
    if not is_interactive(non_interactive):
        raise LoomError("interactive editor required (stdin is not a tty / --non-interactive set)")
    code = launch_editor(path)
    if code != 0:
        raise LoomError(f"editor exited with code {code}")


CREATE_TEMPLATE = """\
---
title:
---
# Body — write your description here. Save and quit to confirm; quit
# without saving (or leave title empty) to cancel.
"""
