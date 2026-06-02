"""Serializers: map loom SDK objects to loom_web Pydantic schemas."""

from __future__ import annotations

from loom.deps import ItemRef as LoomItemRef
from loom.items import Item, Project

from .schemas import ItemDetail, ItemNode, ItemRef, ProjectSummary, TreeResponse


def normalize_status(status: str | None) -> str | None:
    """Pass known status labels through; return raw string for custom statuses."""
    # Currently a passthrough — all statuses are valid as-is in the schema.
    return status


def serialize_project(project: Project) -> ProjectSummary:
    """Map a loom Project item to a ProjectSummary schema."""
    return ProjectSummary(
        qid=project.qualified_id,
        title=project.title,
        repo=project.repo,
        default_branch=project.default_branch,
        archived=project.archived,
    )


def serialize_item_ref(ref: LoomItemRef) -> ItemRef:
    """Map a loom ItemRef (from deps) to an ItemRef schema."""
    return ItemRef(
        qid=ref.qualified_id,
        type=ref.type,
        title=ref.title,
        status=normalize_status(ref.status),
    )


def serialize_tree(tree_dict: dict) -> TreeResponse:
    """Map the dict returned by Loom.tree() to a TreeResponse schema.

    The incoming shape is::

        {
          "root": "<qid>",
          "items": [
            {
              "qid": "...", "type": "...", "status": "...",
              "branch": "...", "pr_url": "...", "assignee": "...",
              "deps": ["..."], "children": ["..."],
            },
            ...
          ]
        }

    Each item in the tree dict does not carry ``title`` — we drop that
    field and rely on ``ItemNode`` having only what the tree dict provides.
    """
    nodes = []
    for raw in tree_dict.get("items", []):
        # The tree dict has no title field; use an empty string as placeholder
        # since ItemNode requires it. Callers wanting titles should use
        # get_item_detail instead.
        nodes.append(
            ItemNode(
                qid=raw["qid"],
                type=raw["type"],
                title="",
                status=normalize_status(raw.get("status")),
                assignee=raw.get("assignee"),
                branch=raw.get("branch"),
                pr_url=raw.get("pr_url"),
                deps=raw.get("deps", []),
                children=raw.get("children", []),
            )
        )
    return TreeResponse(root=tree_dict["root"], items=nodes)


def serialize_item_detail(item: Item) -> ItemDetail:
    """Map a loom Item to an ItemDetail schema (includes body, deps, children)."""
    r = item._record

    # Direct children: items whose parent_id is this item's qid.
    # We derive children from the record's qualified_id — the tree
    # endpoint returns the full subtree; here we surface children via
    # the index stored in the item's own record (not available directly).
    # We compute children as empty here; the router will augment if needed,
    # or callers use the tree endpoint for full hierarchy.
    # For now we expose the list of children qids from the index via the
    # item's own record — they are not stored on IndexRecord, so we default to [].
    deps = [serialize_item_ref(ref) for ref in item.dependencies()]
    dependents = [serialize_item_ref(ref) for ref in item.dependents()]

    return ItemDetail(
        qid=r.qualified_id,
        type=r.type,
        title=r.title,
        status=normalize_status(r.status),
        assignee=r.assignee,
        branch=r.branch,
        pr_url=r.pr_url,
        tags=list(r.tags),
        archived=r.archived,
        body=item.body,
        dependencies=deps,
        dependents=dependents,
        children=[],  # populated by router from index query
    )
