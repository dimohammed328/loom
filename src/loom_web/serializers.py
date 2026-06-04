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

    Each item in the tree dict carries ``title`` and ``updated_at`` sourced
    from the ``IndexRecord``.
    """
    nodes = []
    for raw in tree_dict.get("items", []):
        nodes.append(
            ItemNode(
                qid=raw["qid"],
                type=raw["type"],
                title=raw.get("title", ""),
                status=normalize_status(raw.get("status")),
                assignee=raw.get("assignee"),
                branch=raw.get("branch"),
                pr_url=raw.get("pr_url"),
                deps=raw.get("deps", []),
                children=raw.get("children", []),
                updated_at=raw.get("updated_at", ""),
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
    from loom.items import _Statused  # local import to avoid circular risk

    if isinstance(item, _Statused):
        deps = [serialize_item_ref(ref) for ref in item.dependencies()]
        dependents = [serialize_item_ref(ref) for ref in item.dependents()]
    else:
        # Project items have no status and therefore no dep edges.
        deps = []
        dependents = []

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
