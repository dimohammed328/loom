from pathlib import Path

import pytest

from loom.errors import InvalidQualifiedId, ReservedName
from loom.ids import (
    EPIC_ALPHABET,
    EPIC_ID_LEN,
    ItemType,
    QualifiedId,
    parse_qid,
    path_from_qid,
    qid_from_path,
    random_epic_id,
    validate_project_name,
)

# ---------------------------------------------------------------------------
# parse_qid — happy paths
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "raw, expected",
    [
        ("foo", QualifiedId(project="foo")),
        ("foo:abc2345", QualifiedId(project="foo", epic="abc2345")),
        ("foo:abc2345:1", QualifiedId(project="foo", epic="abc2345", story=1)),
        ("foo:abc2345:1:1", QualifiedId(project="foo", epic="abc2345", story=1, task=1)),
        ("a_proj:nmpqrst:42:99", QualifiedId("a_proj", "nmpqrst", 42, 99)),
    ],
)
def test_parse_round_trip(raw: str, expected: QualifiedId) -> None:
    qid = parse_qid(raw)
    assert qid == expected
    assert str(qid) == raw


def test_type_inference() -> None:
    assert parse_qid("foo").type is ItemType.PROJECT
    assert parse_qid("foo:abc2345").type is ItemType.EPIC
    assert parse_qid("foo:abc2345:1").type is ItemType.STORY
    assert parse_qid("foo:abc2345:1:1").type is ItemType.TASK


def test_parent_chain() -> None:
    task = parse_qid("foo:abc2345:1:2")
    story = task.parent
    epic = story.parent
    project = epic.parent
    assert story == QualifiedId("foo", "abc2345", 1)
    assert epic == QualifiedId("foo", "abc2345")
    assert project == QualifiedId("foo")
    assert project.parent is None


# ---------------------------------------------------------------------------
# parse_qid — rejection cases
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "raw, reason_substr",
    [
        ("", "empty segments"),
        (":foo", "empty segments"),
        ("foo:", "empty segments"),
        ("foo::1", "empty segments"),
        ("foo:abc2345:1:1:extra", "1-4"),
        ("foo bar", "whitespace"),
        ("foo:abc2345 ", "whitespace"),
        (" foo", "whitespace"),
    ],
)
def test_structural_rejects(raw: str, reason_substr: str) -> None:
    with pytest.raises(InvalidQualifiedId) as exc:
        parse_qid(raw)
    assert reason_substr in exc.value.reason


def test_invalid_project_format() -> None:
    with pytest.raises(InvalidQualifiedId):
        parse_qid("Foo")  # uppercase
    with pytest.raises(InvalidQualifiedId):
        parse_qid("1foo")  # leading digit


def test_reserved_project_names() -> None:
    for name in ("projects", "loom", "_archive", "_anything"):
        with pytest.raises(ReservedName):
            parse_qid(name)


def test_epic_id_must_match_alphabet() -> None:
    with pytest.raises(InvalidQualifiedId, match="epic segment"):
        parse_qid("foo:ABC1234")  # uppercase
    with pytest.raises(InvalidQualifiedId, match="epic segment"):
        parse_qid("foo:abc-234")  # hyphen
    with pytest.raises(InvalidQualifiedId, match="epic segment"):
        parse_qid("foo:abc12")  # too short
    with pytest.raises(InvalidQualifiedId, match="epic segment"):
        parse_qid("foo:abc23455")  # too long
    with pytest.raises(InvalidQualifiedId, match="epic segment"):
        parse_qid("foo:abc123o")  # 'o' is excluded for ambiguity


@pytest.mark.parametrize("bad", ["01", "0", "-1", "+1", "1.0", "abc", "1e3"])
def test_story_index_rejects(bad: str) -> None:
    with pytest.raises(InvalidQualifiedId):
        parse_qid(f"foo:abc2345:{bad}")


@pytest.mark.parametrize("bad", ["01", "0", "-1", "+1", "abc"])
def test_task_index_rejects(bad: str) -> None:
    with pytest.raises(InvalidQualifiedId):
        parse_qid(f"foo:abc2345:1:{bad}")


def test_validate_project_name_too_long() -> None:
    name = "a" * 65
    with pytest.raises(InvalidQualifiedId):
        validate_project_name(name)


def test_validate_project_name_max_length_ok() -> None:
    validate_project_name("a" * 64)  # boundary: 64 chars allowed


# ---------------------------------------------------------------------------
# random_epic_id
# ---------------------------------------------------------------------------


def test_random_epic_id_uses_alphabet() -> None:
    alphabet = set(EPIC_ALPHABET)
    for _ in range(200):
        eid = random_epic_id()
        assert len(eid) == EPIC_ID_LEN
        assert set(eid) <= alphabet


def test_random_epic_id_round_trips_through_parser() -> None:
    for _ in range(50):
        eid = random_epic_id()
        # Should pass parse_qid as part of an epic-level id.
        assert parse_qid(f"foo:{eid}").epic == eid


# ---------------------------------------------------------------------------
# path ↔ qid bijection
# ---------------------------------------------------------------------------

ROOT = Path("/data/loom")


@pytest.mark.parametrize(
    "qid",
    [
        QualifiedId("foo"),
        QualifiedId("foo", "abc2345"),
        QualifiedId("foo", "abc2345", 1),
        QualifiedId("foo", "abc2345", 1, 1),
        QualifiedId("a_proj", "nmpqrst", 42, 99),
    ],
)
@pytest.mark.parametrize("archived", [False, True])
def test_path_qid_round_trip(qid: QualifiedId, archived: bool) -> None:
    path = path_from_qid(qid, ROOT, archived=archived)
    recovered, recovered_archived = qid_from_path(path, ROOT)
    assert recovered == qid
    assert recovered_archived is archived


def test_path_layout_specifics() -> None:
    qid = QualifiedId("foo", "abc2345", 2, 3)
    assert path_from_qid(qid, ROOT) == (
        ROOT / "projects" / "foo" / "epics" / "abc2345" / "stories" / "2" / "tasks" / "3.md"
    )
    assert path_from_qid(qid, ROOT, archived=True) == (
        ROOT
        / "_archive"
        / "projects"
        / "foo"
        / "epics"
        / "abc2345"
        / "stories"
        / "2"
        / "tasks"
        / "3.md"
    )


def test_qid_from_path_rejects_outside_root() -> None:
    with pytest.raises(InvalidQualifiedId, match="not under root"):
        qid_from_path(Path("/elsewhere/file.md"), ROOT)


def test_qid_from_path_rejects_missing_projects_prefix() -> None:
    with pytest.raises(InvalidQualifiedId, match="projects"):
        qid_from_path(ROOT / "stuff.md", ROOT)


def test_qid_from_path_rejects_malformed_task_filename() -> None:
    bogus = ROOT / "projects" / "foo" / "epics" / "abc2345" / "stories" / "1" / "tasks" / "01.md"
    with pytest.raises(InvalidQualifiedId):
        qid_from_path(bogus, ROOT)


def test_qid_from_path_rejects_unknown_subdir() -> None:
    bogus = ROOT / "projects" / "foo" / "garbage" / "thing.md"
    with pytest.raises(InvalidQualifiedId, match="epics"):
        qid_from_path(bogus, ROOT)
