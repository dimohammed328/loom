"""Async pub/sub broadcaster hub.

Each subscriber registers an :class:`asyncio.Queue`.  When a message is
published, it is placed on every subscriber's queue so that WebSocket
handlers can drain their own queue and forward the payload to the client.

Thread-safety note: ``subscribe`` / ``unsubscribe`` are called from the
event-loop thread only (inside ``async def`` handlers).  ``publish`` is
also async and must be called from the event-loop thread (or via
``loop.call_soon_threadsafe`` when bridging from a worker thread).
"""

from __future__ import annotations

import asyncio


class Broadcaster:
    """Fan-out hub: one publisher → many per-client queues."""

    def __init__(self) -> None:
        self._subscribers: set[asyncio.Queue] = set()

    def subscribe(self, q: asyncio.Queue) -> None:
        """Register *q* to receive all future messages."""
        self._subscribers.add(q)

    def unsubscribe(self, q: asyncio.Queue) -> None:
        """Remove *q*; it will receive no further messages."""
        self._subscribers.discard(q)

    async def publish(self, message: dict) -> None:
        """Deliver *message* to every subscribed queue."""
        for q in self._subscribers:
            await q.put(message)
