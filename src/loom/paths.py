"""Resolution of the loom data root.

Precedence (first match wins):
    1. ``$LOOM_DIR``
    2. ``$XDG_DATA_HOME/loom``
    3. ``~/.local/share/loom``
"""

from __future__ import annotations

import os
from pathlib import Path

ENV_LOOM_DIR = "LOOM_DIR"
ENV_XDG_DATA_HOME = "XDG_DATA_HOME"


def loom_root(env: dict[str, str] | None = None) -> Path:
    """Return the configured loom data directory.

    The directory is not created or validated; this is a pure path computation.
    Pass an explicit ``env`` dict in tests to avoid depending on the real
    environment.
    """
    e = os.environ if env is None else env

    if loom_dir := e.get(ENV_LOOM_DIR):
        return Path(loom_dir).expanduser()

    if xdg := e.get(ENV_XDG_DATA_HOME):
        return Path(xdg).expanduser() / "loom"

    return Path.home() / ".local" / "share" / "loom"
