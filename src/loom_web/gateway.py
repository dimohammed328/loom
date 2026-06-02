"""Gateway: wraps a single Loom() instance and runs all blocking reads off the event loop."""

from __future__ import annotations

import asyncio
from functools import cached_property

from loom.api import Loom
from loom.items import Item


class LoomGateway:
    """Thin async façade over the :class:`loom.api.Loom` SDK.

    A single ``Loom()`` instance is constructed lazily and shared for the
    lifetime of the gateway.  Every public method dispatches its blocking
    SQLite reads to a thread via :func:`asyncio.to_thread`.
    """

    def __init__(self, root: str | None = None) -> None:
        self._root = root

    @cached_property
    def _loom(self) -> Loom:
        return Loom(root=self._root) if self._root is not None else Loom()

    # ------------------------------------------------------------------
    # Public async API
    # ------------------------------------------------------------------

    async def list_projects(self) -> list[Item]:
        """Return all projects (non-archived)."""
        return await asyncio.to_thread(self._loom.projects)

    async def get_tree(self, project: str) -> dict:
        """Return the full subtree rooted at *project*.

        Raises :class:`loom.errors.NotFound` if *project* does not exist.
        """
        return await asyncio.to_thread(self._loom.tree, project)

    async def get_item_detail(self, qid: str) -> Item:
        """Return a single item by qualified id.

        Raises :class:`loom.errors.NotFound` if not found.
        """
        return await asyncio.to_thread(self._loom.get, qid)

    async def get_item_summary(self, qid: str) -> dict:
        """Return a lightweight summary dict for *qid* (no body).

        Shape::

            {
              "qid": "...",
              "type": "...",
              "title": "...",
              "status": "...",
              "assignee": "...",
              "branch": "...",
              "pr_url": "...",
              "tags": [...],
              "archived": bool,
            }

        Raises :class:`loom.errors.NotFound` if not found.
        """

        def _summary() -> dict:
            item = self._loom.get(qid)
            r = item._record
            return {
                "qid": r.qualified_id,
                "type": r.type,
                "title": r.title,
                "status": r.status,
                "assignee": r.assignee,
                "branch": r.branch,
                "pr_url": r.pr_url,
                "tags": list(r.tags),
                "archived": r.archived,
            }

        return await asyncio.to_thread(_summary)
