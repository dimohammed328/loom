"""Backend API tests for loom_web endpoints.

Uses FastAPI's TestClient (sync wrapper over httpx) against a real, fixture
$LOOM_DIR so every loom read goes through the actual SDK.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from conftest import write_item
from loom.ids import QualifiedId
from loom.rebuild import rebuild
from loom_web.app import create_app


@pytest.fixture
def populated_loom_dir(loom_dir: Path) -> Path:
    """A loom_dir pre-populated with a project, epic, story, and tasks."""
    write_item(
        loom_dir,
        QualifiedId("acme"),
        title="Acme Corp",
        repo="https://github.com/acme/acme",
        default_branch="main",
        body="Top-level project.",
    )
    write_item(
        loom_dir,
        QualifiedId("acme", "backlog"),
        title="Backlog",
        status="ready",
    )
    write_item(
        loom_dir,
        QualifiedId("acme", "abcdefg"),
        title="Sprint 1",
        status="ready",
        body="First sprint.",
    )
    write_item(
        loom_dir,
        QualifiedId("acme", "abcdefg", 1),
        title="Auth story",
        status="in_progress",
        assignee="alice",
        body="Implement authentication.",
    )
    write_item(
        loom_dir,
        QualifiedId("acme", "abcdefg", 1, 1),
        title="Write login endpoint",
        status="ready",
        body="POST /auth/login",
    )
    write_item(
        loom_dir,
        QualifiedId("acme", "abcdefg", 1, 2),
        title="Write logout endpoint",
        status="ready",
        depends_on=["acme:abcdefg:1:1"],
        body="POST /auth/logout",
    )
    rebuild(loom_dir)
    return loom_dir


@pytest.fixture
def client(populated_loom_dir: Path) -> TestClient:
    """TestClient backed by the populated loom_dir."""
    app = create_app(root=str(populated_loom_dir))
    return TestClient(app)


# ---------------------------------------------------------------------------
# GET /api/projects
# ---------------------------------------------------------------------------


def test_list_projects_returns_all_projects(client: TestClient) -> None:
    resp = client.get("/api/projects")
    assert resp.status_code == 200
    data = resp.json()
    assert isinstance(data, list)
    qids = [p["qid"] for p in data]
    assert "acme" in qids


def test_list_projects_shape(client: TestClient) -> None:
    resp = client.get("/api/projects")
    assert resp.status_code == 200
    project = next(p for p in resp.json() if p["qid"] == "acme")
    assert project["title"] == "Acme Corp"
    assert project["repo"] == "https://github.com/acme/acme"
    assert project["default_branch"] == "main"
    assert project["archived"] is False


# ---------------------------------------------------------------------------
# GET /api/projects/{project}/tree
# ---------------------------------------------------------------------------


def test_tree_returns_root_and_items(client: TestClient) -> None:
    resp = client.get("/api/projects/acme/tree")
    assert resp.status_code == 200
    data = resp.json()
    assert data["root"] == "acme"
    assert isinstance(data["items"], list)
    qids = [item["qid"] for item in data["items"]]
    # Should include the project, epics, stories, and tasks.
    assert "acme" in qids
    assert "acme:abcdefg" in qids
    assert "acme:abcdefg:1" in qids
    assert "acme:abcdefg:1:1" in qids
    assert "acme:abcdefg:1:2" in qids


def test_tree_item_has_correct_fields(client: TestClient) -> None:
    resp = client.get("/api/projects/acme/tree")
    assert resp.status_code == 200
    items = {item["qid"]: item for item in resp.json()["items"]}
    story = items["acme:abcdefg:1"]
    assert story["type"] == "story"
    assert story["status"] == "in_progress"
    assert isinstance(story["children"], list)
    assert isinstance(story["deps"], list)


def test_tree_dep_edge_present(client: TestClient) -> None:
    """Task 2 depends on task 1; that dep edge must appear in the tree."""
    resp = client.get("/api/projects/acme/tree")
    assert resp.status_code == 200
    items = {item["qid"]: item for item in resp.json()["items"]}
    task2 = items["acme:abcdefg:1:2"]
    assert "acme:abcdefg:1:1" in task2["deps"]


def test_tree_unknown_project_returns_404(client: TestClient) -> None:
    resp = client.get("/api/projects/nonexistent/tree")
    assert resp.status_code == 404
    assert "detail" in resp.json()


def test_tree_nodes_have_title_and_updated_at(client: TestClient) -> None:
    """Every tree node must carry a non-empty title and an ISO updated_at."""
    resp = client.get("/api/projects/acme/tree")
    assert resp.status_code == 200
    items = resp.json()["items"]
    assert items, "tree must return at least one item"
    for node in items:
        assert node["title"], f"node {node['qid']} has empty title"
        assert node["updated_at"], f"node {node['qid']} missing updated_at"
        # Must be a valid ISO datetime string (contains 'T' separator)
        assert "T" in node["updated_at"], (
            f"node {node['qid']} updated_at is not ISO format: {node['updated_at']}"
        )


# ---------------------------------------------------------------------------
# GET /api/items/{qid}
# ---------------------------------------------------------------------------


def test_item_detail_project(client: TestClient) -> None:
    resp = client.get("/api/items/acme")
    assert resp.status_code == 200
    data = resp.json()
    assert data["qid"] == "acme"
    assert data["type"] == "project"
    assert data["title"] == "Acme Corp"
    assert "body" in data
    assert isinstance(data["dependencies"], list)
    assert isinstance(data["dependents"], list)
    assert isinstance(data["children"], list)


def test_item_detail_story_has_body(client: TestClient) -> None:
    resp = client.get("/api/items/acme:abcdefg:1")
    assert resp.status_code == 200
    data = resp.json()
    assert "Implement authentication." in data["body"]


def test_item_detail_task_with_dep(client: TestClient) -> None:
    """Task 2's dependencies list must include task 1."""
    resp = client.get("/api/items/acme:abcdefg:1:2")
    assert resp.status_code == 200
    data = resp.json()
    dep_qids = [d["qid"] for d in data["dependencies"]]
    assert "acme:abcdefg:1:1" in dep_qids


def test_item_detail_task_dependents(client: TestClient) -> None:
    """Task 1's dependents list must include task 2."""
    resp = client.get("/api/items/acme:abcdefg:1:1")
    assert resp.status_code == 200
    data = resp.json()
    dependent_qids = [d["qid"] for d in data["dependents"]]
    assert "acme:abcdefg:1:2" in dependent_qids


def test_item_detail_story_children(client: TestClient) -> None:
    """Story children list must include its two tasks."""
    resp = client.get("/api/items/acme:abcdefg:1")
    assert resp.status_code == 200
    children = resp.json()["children"]
    assert "acme:abcdefg:1:1" in children
    assert "acme:abcdefg:1:2" in children


def test_item_detail_unknown_qid_returns_404(client: TestClient) -> None:
    resp = client.get("/api/items/acme:abcdefg:1:999")
    assert resp.status_code == 404
    assert "detail" in resp.json()


def test_item_detail_completely_unknown_project_returns_404(client: TestClient) -> None:
    resp = client.get("/api/items/ghost")
    assert resp.status_code == 404
    assert "detail" in resp.json()


# ---------------------------------------------------------------------------
# GET /api/health
# ---------------------------------------------------------------------------


def test_health_returns_ok(client: TestClient) -> None:
    resp = client.get("/api/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}
