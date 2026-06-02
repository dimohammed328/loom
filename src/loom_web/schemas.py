"""Pydantic response schemas for the loom_web API."""

from __future__ import annotations

from pydantic import BaseModel


class ProjectSummary(BaseModel):
    """Lightweight project descriptor returned by GET /api/projects."""

    qid: str
    title: str
    repo: str | None
    default_branch: str | None
    archived: bool


class ItemRef(BaseModel):
    """Minimal cross-reference used in dependency/dependent lists."""

    qid: str
    type: str
    title: str
    status: str | None


class ItemNode(BaseModel):
    """One node in the project tree (no body).  Used by TreeResponse.items."""

    qid: str
    type: str
    title: str
    status: str | None
    assignee: str | None
    branch: str | None
    pr_url: str | None
    deps: list[str]
    children: list[str]


class TreeResponse(BaseModel):
    """Response shape for GET /api/projects/{project}/tree."""

    root: str
    items: list[ItemNode]


class ItemUpdate(BaseModel):
    """WebSocket payload for a changed item (record minus body).

    Broadcast to all ``/ws`` clients whenever a loom ``.md`` file is
    created or modified.  ``deleted`` is always ``False`` here; use
    :class:`ItemTombstone` for deletions.
    """

    qid: str
    type: str
    title: str
    status: str | None
    assignee: str | None
    branch: str | None
    pr_url: str | None
    tags: list[str]
    archived: bool
    deleted: bool = False


class ItemTombstone(BaseModel):
    """WebSocket payload for a deleted item.

    Broadcast when the item file has been removed and ``loom.get(qid)``
    raises :class:`loom.errors.NotFound`.
    """

    qid: str
    deleted: bool = True


class ItemDetail(BaseModel):
    """Full item descriptor returned by GET /api/items/{qid}."""

    qid: str
    type: str
    title: str
    status: str | None
    assignee: str | None
    branch: str | None
    pr_url: str | None
    tags: list[str]
    archived: bool
    body: str
    dependencies: list[ItemRef]
    dependents: list[ItemRef]
    children: list[str]
