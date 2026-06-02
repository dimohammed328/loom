"""UpdatesWorker: runs Loom.get_updates() in a worker thread and forwards each
qid to the async Broadcaster via Broadcaster.publish_threadsafe.

Usage::

    worker = UpdatesWorker(loom=loom_instance, broadcaster=hub)
    t = threading.Thread(target=worker.run, daemon=True)
    t.start()
    # ... on shutdown:
    worker.stop()
    t.join()
"""

from __future__ import annotations

import threading
from typing import Literal

from loom.api import Loom

from .broadcaster import Broadcaster


class UpdatesWorker:
    """Runs ``Loom.get_updates()`` in a worker thread and publishes each
    changed qid to *broadcaster*.

    :param loom: A :class:`loom.api.Loom` instance.
    :param broadcaster: The :class:`~loom_web.broadcaster.Broadcaster` hub.
    :param on_not_found: When the item cannot be retrieved after a change event
        (``"tombstone"``), broadcast ``{qid, deleted: true}``; or ``"skip"``
        to silently drop.  Defaults to ``"tombstone"``.
    """

    def __init__(
        self,
        *,
        loom: Loom,
        broadcaster: Broadcaster,
        on_not_found: Literal["tombstone", "skip"] = "tombstone",
    ) -> None:
        self._loom = loom
        self._broadcaster = broadcaster
        self._on_not_found = on_not_found
        self._stop_event = threading.Event()

    def stop(self) -> None:
        """Signal the worker to stop after the current get_updates() iteration."""
        self._stop_event.set()

    def run(self) -> None:
        """Blocking entry point — call this from a worker thread.

        Iterates ``loom.get_updates(timeout=0.1)`` so the loop can be
        interrupted cleanly via :meth:`stop`.  Publishes payloads via
        :meth:`~loom_web.broadcaster.Broadcaster.publish_threadsafe`.
        """
        try:
            for qid in self._loom.get_updates(timeout=0.1):
                if self._stop_event.is_set():
                    break
                payload = self._build_payload(qid)
                self._broadcaster.publish_threadsafe(payload)
        except Exception:
            pass  # observer stopped unexpectedly; exit cleanly

    # ------------------------------------------------------------------

    def _build_payload(self, qid: str) -> dict:
        """Return the broadcast payload for *qid*.

        On success: the item summary dict (record minus body).
        On failure (item deleted/not found): ``{qid, deleted: True}``.
        """
        try:
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
        except Exception:
            if self._on_not_found == "tombstone":
                return {"qid": qid, "deleted": True}
            return {}  # skip — caller should filter empty dicts
