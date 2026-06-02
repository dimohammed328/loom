"""Live WebSocket tests for loom_web.

Tests for the real-time update pipeline:
  broadcaster hub → /ws endpoint → client receives events.
"""

from __future__ import annotations

import asyncio

import pytest


# ---------------------------------------------------------------------------
# Task 1: Broadcaster hub unit tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_broadcaster_publishes_to_subscribed_queue() -> None:
    """A message published to the broadcaster appears in a subscribed queue."""
    from loom_web.broadcaster import Broadcaster

    hub = Broadcaster()
    q: asyncio.Queue = asyncio.Queue()
    hub.subscribe(q)
    await hub.publish({"qid": "proj:abc:1", "type": "task"})
    msg = q.get_nowait()
    assert msg == {"qid": "proj:abc:1", "type": "task"}


@pytest.mark.asyncio
async def test_broadcaster_publishes_to_multiple_queues() -> None:
    """A published message is broadcast to all subscribed queues."""
    from loom_web.broadcaster import Broadcaster

    hub = Broadcaster()
    queues = [asyncio.Queue() for _ in range(3)]
    for q in queues:
        hub.subscribe(q)
    await hub.publish({"qid": "proj:abc:2"})
    for q in queues:
        assert q.get_nowait() == {"qid": "proj:abc:2"}


@pytest.mark.asyncio
async def test_broadcaster_unsubscribe_stops_delivery() -> None:
    """After unsubscribing, the queue receives no further messages."""
    from loom_web.broadcaster import Broadcaster

    hub = Broadcaster()
    q: asyncio.Queue = asyncio.Queue()
    hub.subscribe(q)
    hub.unsubscribe(q)
    await hub.publish({"qid": "proj:abc:3"})
    assert q.empty()


@pytest.mark.asyncio
async def test_broadcaster_empty_publish_is_noop() -> None:
    """Publishing with no subscribers does not raise."""
    from loom_web.broadcaster import Broadcaster

    hub = Broadcaster()
    await hub.publish({"qid": "proj:abc:4"})  # must not raise
