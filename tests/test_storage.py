from __future__ import annotations

from pathlib import Path

import pytest

from loom.errors import ValidationError
from loom.storage import dump, load, parse, render

# ---------------------------------------------------------------------------
# parse — happy paths
# ---------------------------------------------------------------------------


def test_parse_basic() -> None:
    text = "---\ntitle: hello\n---\nbody line\n"
    fm, body = parse(text)
    assert fm == {"title": "hello"}
    assert body == "body line\n"


def test_parse_no_frontmatter() -> None:
    text = "no fence here\njust body\n"
    fm, body = parse(text)
    assert fm == {}
    assert body == text


def test_parse_empty_body() -> None:
    text = "---\nkey: value\n---\n"
    fm, body = parse(text)
    assert fm == {"key": "value"}
    assert body == ""


def test_parse_body_contains_horizontal_rule() -> None:
    text = "---\ntitle: t\n---\n# heading\n\n---\n\nmore body\n"
    fm, body = parse(text)
    assert fm == {"title": "t"}
    assert body == "# heading\n\n---\n\nmore body\n"


def test_parse_preserves_unknown_keys() -> None:
    text = "---\ntitle: t\nweird_key: 42\nnested:\n  a: 1\n  b: [x, y]\n---\nbody\n"
    fm, _ = parse(text)
    assert fm["weird_key"] == 42
    assert fm["nested"]["a"] == 1
    assert list(fm["nested"]["b"]) == ["x", "y"]


def test_parse_preserves_key_order() -> None:
    text = "---\nz: 1\na: 2\nm: 3\n---\nbody\n"
    fm, _ = parse(text)
    assert list(fm.keys()) == ["z", "a", "m"]


def test_parse_empty_frontmatter_block() -> None:
    text = "---\n---\nbody\n"
    fm, body = parse(text)
    assert fm == {}
    assert body == "body\n"


# ---------------------------------------------------------------------------
# parse — rejection paths
# ---------------------------------------------------------------------------


def test_parse_unclosed_fence() -> None:
    text = "---\ntitle: t\nbody without closing fence\n"
    with pytest.raises(ValidationError, match="closing fence"):
        parse(text)


def test_parse_non_mapping_frontmatter() -> None:
    text = "---\n- just\n- a\n- list\n---\nbody\n"
    with pytest.raises(ValidationError, match="mapping"):
        parse(text)


def test_parse_garbled_yaml_wraps_as_validation_error() -> None:
    text = "---\nkey: : :\n---\nbody\n"
    with pytest.raises(ValidationError, match="not valid YAML"):
        parse(text)


def test_parse_garbled_yaml_includes_source() -> None:
    text = "---\nkey: : :\n---\nbody\n"
    with pytest.raises(ValidationError, match=r"source: /tmp/x\.md"):
        parse(text, source="/tmp/x.md")


# ---------------------------------------------------------------------------
# render
# ---------------------------------------------------------------------------


def test_render_round_trip_simple() -> None:
    fm = {"title": "hello", "n": 3}
    body = "first line\nsecond line\n"
    text = render(fm, body)
    fm2, body2 = parse(text)
    assert dict(fm2) == fm
    assert body2 == body


def test_render_normalizes_trailing_newlines() -> None:
    text = render({"a": 1}, "body\n\n\n\n")
    assert text.endswith("body\n")
    assert not text.endswith("body\n\n")


def test_render_adds_trailing_newline_when_missing() -> None:
    text = render({"a": 1}, "no newline at end")
    assert text.endswith("\n")


def test_render_no_frontmatter() -> None:
    assert render({}, "just body\n") == "just body\n"


def test_render_empty_body() -> None:
    text = render({"a": 1}, "")
    assert text == "---\na: 1\n---\n"


# ---------------------------------------------------------------------------
# Round-trip via real files
# ---------------------------------------------------------------------------


def test_dump_load_round_trip(tmp_path: Path) -> None:
    p = tmp_path / "item.md"
    fm = {
        "schema_version": 1,
        "title": "OAuth backend",
        "tags": ["auth", "security"],
        "depends_on": ["foo:abcdefg:1"],
        "custom": {"score": 3, "extra": ["a", "b"]},
    }
    body = "## Context\n\nSome body content with --- inside it.\n"
    dump(p, fm, body)
    fm2, body2 = load(p)
    assert dict(fm2) == fm
    assert list(fm2["custom"]) == ["score", "extra"]
    assert body2 == body


def test_dump_overwrites_existing_file(tmp_path: Path) -> None:
    p = tmp_path / "item.md"
    dump(p, {"a": 1}, "first\n")
    dump(p, {"a": 2}, "second\n")
    fm, body = load(p)
    assert dict(fm) == {"a": 2}
    assert body == "second\n"


def test_dump_creates_parent_dirs(tmp_path: Path) -> None:
    p = tmp_path / "deep" / "nested" / "item.md"
    dump(p, {"a": 1}, "body\n")
    assert p.exists()


def test_dump_leaves_no_temp_files(tmp_path: Path) -> None:
    p = tmp_path / "item.md"
    dump(p, {"a": 1}, "body\n")
    leftovers = [x for x in tmp_path.iterdir() if x.name != "item.md"]
    assert leftovers == []


def test_dump_cleans_up_temp_on_failure(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    p = tmp_path / "item.md"

    def boom(*args: object, **kwargs: object) -> None:
        raise RuntimeError("simulated rename failure")

    monkeypatch.setattr("loom.storage.os.replace", boom)
    with pytest.raises(RuntimeError):
        dump(p, {"a": 1}, "body\n")
    assert list(tmp_path.iterdir()) == []


def test_round_trip_preserves_literal_block_string(tmp_path: Path) -> None:
    text = "---\ntitle: t\ndescription: |\n  line one\n  line two\n  line three\n---\nbody\n"
    fm, body = parse(text)
    assert fm["description"] == "line one\nline two\nline three\n"

    p = tmp_path / "item.md"
    dump(p, fm, body)
    fm2, body2 = load(p)
    assert fm2["description"] == "line one\nline two\nline three\n"
    assert body2 == body


def test_round_trip_preserves_key_order_through_disk(tmp_path: Path) -> None:
    p = tmp_path / "item.md"
    fm_in = {"z": 1, "a": 2, "m": 3}
    dump(p, fm_in, "body\n")
    fm_out, _ = load(p)
    assert list(fm_out.keys()) == ["z", "a", "m"]
