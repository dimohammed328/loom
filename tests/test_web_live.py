"""Live WebSocket tests for loom_web.

Tests for the real-time update pipeline:
  broadcaster hub → /ws endpoint → client receives events.
"""

from __future__ import annotations

import asyncio
import threading

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


# ---------------------------------------------------------------------------
# Task 2: updates worker — run get_updates() and forward to broadcaster
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_updates_worker_forwards_qid_to_broadcaster() -> None:
    """UpdatesWorker feeds qids from get_updates() into the broadcaster."""
    from unittest.mock import MagicMock

    from loom_web.broadcaster import Broadcaster
    from loom_web.updates import UpdatesWorker

    hub = Broadcaster()
    received: asyncio.Queue = asyncio.Queue()
    # Capture the running loop so publish_threadsafe works from the worker thread.
    hub._loop = asyncio.get_running_loop()
    hub.subscribe(received)

    # Build a fake item whose _record has the right attributes.
    fake_record = MagicMock()
    fake_record.qualified_id = "proj:abc:1"
    fake_record.type = "task"
    fake_record.title = "A task"
    fake_record.status = "ready"
    fake_record.assignee = None
    fake_record.branch = None
    fake_record.pr_url = None
    fake_record.tags = []
    fake_record.archived = False
    fake_item = MagicMock()
    fake_item._record = fake_record

    def fake_get_updates(**kwargs):
        yield "proj:abc:1"

    mock_loom = MagicMock()
    mock_loom.get_updates = fake_get_updates
    mock_loom.get.return_value = fake_item

    worker = UpdatesWorker(loom=mock_loom, broadcaster=hub)
    t = threading.Thread(target=worker.run, daemon=True)
    t.start()
    t.join(timeout=2.0)
    assert not t.is_alive(), "Worker thread should have finished"

    msg = await asyncio.wait_for(received.get(), timeout=1.0)
    assert msg["qid"] == "proj:abc:1"
    assert msg["type"] == "task"


@pytest.mark.asyncio
async def test_updates_worker_tombstone_for_deleted_qid() -> None:
    """Tombstone payload {qid, deleted: true} is broadcast for unknown qid after deletion."""
    from unittest.mock import MagicMock

    from loom_web.broadcaster import Broadcaster
    from loom_web.updates import UpdatesWorker

    hub = Broadcaster()
    received: asyncio.Queue = asyncio.Queue()
    hub._loop = asyncio.get_running_loop()
    hub.subscribe(received)

    def fake_get_updates(**kwargs):
        yield "proj:abc:deleted"

    mock_loom = MagicMock()
    mock_loom.get_updates = fake_get_updates
    mock_loom.get.side_effect = Exception("not found")

    worker = UpdatesWorker(loom=mock_loom, broadcaster=hub, on_not_found="tombstone")
    t = threading.Thread(target=worker.run, daemon=True)
    t.start()
    t.join(timeout=2.0)
    assert not t.is_alive()

    msg = await asyncio.wait_for(received.get(), timeout=1.0)
    assert msg["qid"] == "proj:abc:deleted"
    assert msg.get("deleted") is True


# ---------------------------------------------------------------------------
# Task 3: WS payload shape — ItemUpdate and ItemTombstone schemas
# ---------------------------------------------------------------------------


def test_item_update_payload_schema_validates_item_fields() -> None:
    """ItemUpdate accepts a full item summary dict."""
    from loom_web.schemas import ItemUpdate

    payload = ItemUpdate(
        qid="proj:abc:1",
        type="task",
        title="A task",
        status="ready",
        assignee=None,
        branch=None,
        pr_url=None,
        tags=[],
        archived=False,
    )
    assert payload.qid == "proj:abc:1"
    assert payload.deleted is False


def test_item_tombstone_payload_schema_marks_deleted() -> None:
    """ItemTombstone carries qid and deleted=True."""
    from loom_web.schemas import ItemTombstone

    payload = ItemTombstone(qid="proj:abc:99")
    assert payload.qid == "proj:abc:99"
    assert payload.deleted is True


def test_item_update_serialises_to_dict_with_no_body() -> None:
    """ItemUpdate.model_dump() must NOT include a 'body' field."""
    from loom_web.schemas import ItemUpdate

    payload = ItemUpdate(
        qid="proj:abc:1",
        type="task",
        title="A task",
        status="ready",
        assignee=None,
        branch=None,
        pr_url=None,
        tags=[],
        archived=False,
    )
    d = payload.model_dump()
    assert "body" not in d
    assert d["qid"] == "proj:abc:1"


# ---------------------------------------------------------------------------
# Task 4: /ws endpoint — subscribe, receive, unsubscribe on disconnect
# ---------------------------------------------------------------------------


def test_ws_endpoint_delivers_message_and_unsubscribes(loom_dir) -> None:
    """WS client receives a published message, and is unsubscribed on disconnect."""
    import time

    from starlette.testclient import TestClient

    from loom_web.app import create_app
    from loom_web.broadcaster import Broadcaster

    hub = Broadcaster()
    app = create_app(root=str(loom_dir))
    app.state.broadcaster = hub

    received: list[dict] = []

    def _ws_session() -> None:
        """Run inside a thread: connect, receive a message, then disconnect."""
        with TestClient(app) as client, client.websocket_connect("/ws") as ws:
            data = ws.receive_json()
            received.append(data)

    t = threading.Thread(target=_ws_session, daemon=True)
    t.start()

    # Wait until the WS handler has subscribed (and captured the event loop).
    deadline = time.monotonic() + 2.0
    while (not hub._subscribers or hub._loop is None) and time.monotonic() < deadline:
        time.sleep(0.005)
    assert hub._subscribers, "WS handler never subscribed"
    assert hub._loop is not None, "Event loop never captured"

    # Publish from this (worker) thread via the captured event loop.
    msg = {"qid": "proj:abc:1", "type": "task", "deleted": False}
    hub.publish_threadsafe(msg)

    t.join(timeout=3.0)
    assert not t.is_alive(), "WS thread did not finish in time"
    assert received == [msg]
    assert len(hub._subscribers) == 0


# ---------------------------------------------------------------------------
# Task 5: Lifespan — observer thread starts on startup, stops on shutdown
# ---------------------------------------------------------------------------


def test_lifespan_starts_observer_thread_on_startup(loom_dir) -> None:
    """The UpdatesWorker thread is alive after app startup."""
    from starlette.testclient import TestClient

    from loom_web.app import create_app

    app = create_app(root=str(loom_dir))
    with TestClient(app):
        # The lifespan startup has run; worker thread must be running.
        assert app.state.updates_thread is not None
        assert app.state.updates_thread.is_alive()

    # After __exit__ the lifespan shutdown has run; thread must have stopped.
    assert not app.state.updates_thread.is_alive()


def test_lifespan_worker_is_none_before_startup(loom_dir) -> None:
    """Before the lifespan starts, updates_thread is not set on app.state."""
    from loom_web.app import create_app

    app = create_app(root=str(loom_dir))
    # Before entering the lifespan context, updates_thread must not exist.
    assert not hasattr(app.state, "updates_thread")


# ---------------------------------------------------------------------------
# Task 6: Full end-to-end live WS test — file change → client receives payload
# ---------------------------------------------------------------------------


def test_ws_client_receives_payload_when_fixture_file_changes(loom_dir) -> None:
    """End-to-end: WS client connects, a .md file changes, client gets the payload."""
    import time

    from starlette.testclient import TestClient

    from conftest import write_item
    from loom.ids import QualifiedId
    from loom.rebuild import rebuild
    from loom_web.app import create_app

    # Pre-populate a project/epic/story/task so the file path maps to a qid.
    write_item(loom_dir, QualifiedId("live"), title="Live Project")
    write_item(loom_dir, QualifiedId("live", "backlog"), title="Backlog", status="ready")
    write_item(loom_dir, QualifiedId("live", "backlog", 1), title="Story 1", status="ready")
    task_path = write_item(
        loom_dir,
        QualifiedId("live", "backlog", 1, 1),
        title="Task 1",
        status="ready",
    )
    rebuild(loom_dir)

    app = create_app(root=str(loom_dir))
    received: list[dict] = []

    def _ws_session() -> None:
        with TestClient(app) as client, client.websocket_connect("/ws") as ws:
            data = ws.receive_json()
            received.append(data)

    t = threading.Thread(target=_ws_session, daemon=True)
    t.start()

    # Wait for the broadcaster to have a subscriber (WS connected + loop captured).
    deadline = time.monotonic() + 3.0
    while (
        not app.state.broadcaster._subscribers or app.state.broadcaster._loop is None
    ) and time.monotonic() < deadline:
        time.sleep(0.01)

    # Touch the task file to trigger a watchdog event.
    task_path.write_text(task_path.read_text())

    t.join(timeout=5.0)
    assert not t.is_alive(), "WS session thread did not finish in time"
    assert len(received) == 1
    payload = received[0]
    assert payload["qid"] == "live:backlog:1:1"
    # Must not contain body.
    assert "body" not in payload
