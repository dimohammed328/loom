"""Async pub/sub broadcaster hub.

Each subscriber registers an :class:`asyncio.Queue`.  When a message is
published, it is placed on every subscriber's queue so that WebSocket
handlers can drain their own queue and forward the payload to the client.

Thread-safety note: ``subscribe`` / ``unsubscribe`` are called from the
event-loop thread only (inside ``async def`` handlers).  ``publish`` is
also async and must be called from the event-loop thread.

To publish from a worker thread, use :meth:`publish_threadsafe` which
schedules the coroutine on the event loop via
``loop.call_soon_threadsafe``.
"""

from __future__ import annotations

import asyncio


class Broadcaster:
    """Fan-out hub: one publisher → many per-client queues."""

    def __init__(self) -> None:
        self._subscribers: set[asyncio.Queue] = set()
        self._loop: asyncio.AbstractEventLoop | None = None

    def subscribe(self, q: asyncio.Queue) -> None:
        """Register *q* to receive all future messages.

        Must be called from within the running event loop.  Captures the
        loop on the first subscription so worker threads can use
        :meth:`publish_threadsafe`.
        """
        if self._loop is None:
            try:
                self._loop = asyncio.get_running_loop()
            except RuntimeError:
                pass
        self._subscribers.add(q)

    def unsubscribe(self, q: asyncio.Queue) -> None:
        """Remove *q*; it will receive no further messages."""
        self._subscribers.discard(q)

    async def publish(self, message: dict) -> None:
        """Deliver *message* to every subscribed queue."""
        for q in self._subscribers:
            await q.put(message)

    def publish_threadsafe(self, message: dict) -> None:
        """Deliver *message* from a worker thread.

        Schedules :meth:`publish` on the captured event loop via
        ``loop.call_soon_threadsafe``.  Raises ``RuntimeError`` if no
        subscriber has connected yet (no loop captured).
        """
        if self._loop is None:
            raise RuntimeError(
                "No event loop captured yet — call publish_threadsafe only "
                "after at least one client has subscribed."
            )
        self._loop.call_soon_threadsafe(
            lambda: asyncio.ensure_future(self.publish(message), loop=self._loop)
        )
