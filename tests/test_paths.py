from pathlib import Path

from loom.paths import loom_root


def test_loom_dir_takes_precedence(tmp_path: Path) -> None:
    env = {
        "LOOM_DIR": str(tmp_path / "explicit"),
        "XDG_DATA_HOME": str(tmp_path / "xdg"),
    }
    assert loom_root(env) == tmp_path / "explicit"


def test_xdg_when_no_loom_dir(tmp_path: Path) -> None:
    env = {"XDG_DATA_HOME": str(tmp_path / "xdg")}
    assert loom_root(env) == tmp_path / "xdg" / "loom"


def test_default_when_neither_set() -> None:
    assert loom_root({}) == Path.home() / ".local" / "share" / "loom"


def test_tilde_expansion_in_loom_dir() -> None:
    env = {"LOOM_DIR": "~/custom/loom"}
    assert loom_root(env) == Path.home() / "custom" / "loom"


def test_tilde_expansion_in_xdg() -> None:
    env = {"XDG_DATA_HOME": "~/xdg"}
    assert loom_root(env) == Path.home() / "xdg" / "loom"


def test_uses_real_env_by_default(monkeypatch) -> None:
    monkeypatch.setenv("LOOM_DIR", "/tmp/from-real-env")
    monkeypatch.delenv("XDG_DATA_HOME", raising=False)
    assert loom_root() == Path("/tmp/from-real-env")
