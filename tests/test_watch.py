"""Tests for loom.watch and Loom.get_updates()."""

from __future__ import annotations

import queue
import threading
import time
from pathlib import Path

from conftest import write_item
from loom.api import Loom
from loom.ids import QualifiedId
from loom.index import Index
from loom.watch import LoomEventHandler, _Debouncer

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_POLL_INTERVAL = 0.05  # seconds between queue-drain attempts
_TIMEOUT = 5.0  # maximum seconds to wait for an event


def _drain(q: queue.Queue[object], expected_count: int) -> list[str]:
    """Collect *expected_count* items from *q* within _TIMEOUT seconds."""
    results: list[str] = []
    deadline = time.monotonic() + _TIMEOUT
    while len(results) < expected_count:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        try:
            item = q.get(timeout=min(_POLL_INTERVAL, remaining))
            if isinstance(item, str):
                results.append(item)
        except queue.Empty:
            pass
    return results


# ---------------------------------------------------------------------------
# _Debouncer unit tests
# ---------------------------------------------------------------------------


def test_debouncer_first_acquire_passes() -> None:
    d = _Debouncer(delay=10.0)  # long delay so release doesn't fire
    p = Path("/tmp/x.md")
    assert d.acquire(p) is True


def test_debouncer_second_acquire_blocked() -> None:
    d = _Debouncer(delay=10.0)
    p = Path("/tmp/x.md")
    d.acquire(p)
    assert d.acquire(p) is False


def test_debouncer_different_paths_independent() -> None:
    d = _Debouncer(delay=10.0)
    p1 = Path("/tmp/a.md")
    p2 = Path("/tmp/b.md")
    assert d.acquire(p1) is True
    assert d.acquire(p2) is True  # different path — not blocked


def test_debouncer_cancel_clears_active() -> None:
    d = _Debouncer(delay=10.0)
    p = Path("/tmp/x.md")
    d.acquire(p)
    d.cancel()
    # After cancel the path should be acquirable again.
    assert d.acquire(p) is True


def test_debouncer_release_after_delay() -> None:
    d = _Debouncer(delay=0.05)
    p = Path("/tmp/x.md")
    d.acquire(p)
    assert d.acquire(p) is False
    time.sleep(0.2)
    assert d.acquire(p) is True


# ---------------------------------------------------------------------------
# LoomEventHandler unit tests (no real observer — push events directly)
# ---------------------------------------------------------------------------


def test_handler_ignores_non_md_files(loom_dir: Path) -> None:
    """Non-.md paths must be silently dropped."""
    q: queue.Queue[object] = queue.Queue()
    handler = LoomEventHandler(loom_dir, q)
    handler._handle_path(str(loom_dir / "projects" / "foo" / "project.txt"))
    assert q.empty()


def test_handler_ignores_paths_outside_loom_layout(loom_dir: Path) -> None:
    """Files that don't match the canonical layout should be silently dropped."""
    q: queue.Queue[object] = queue.Queue()
    handler = LoomEventHandler(loom_dir, q)
    handler._handle_path(str(loom_dir / "random_dir" / "whatever.md"))
    assert q.empty()


def test_handler_enqueues_valid_path(loom_dir: Path) -> None:
    """A valid canonical path should produce the correct qid in the queue."""
    qid = QualifiedId("myproj", "abcdefg", 1, 1)
    path = write_item(loom_dir, qid)
    # Rebuild index so sync_one can find the item.
    from loom.rebuild import rebuild

    rebuild(loom_dir)

    q: queue.Queue[object] = queue.Queue()
    handler = LoomEventHandler(loom_dir, q)
    handler._handle_path(str(path))
    assert not q.empty()
    assert q.get_nowait() == str(qid)


def test_handler_enqueues_on_deletion(loom_dir: Path) -> None:
    """Deleting a file (path still parseable) should still enqueue the qid."""
    qid = QualifiedId("myproj", "abcdefg", 1, 1)
    path = write_item(loom_dir, qid)
    from loom.rebuild import rebuild

    rebuild(loom_dir)

    # Remove file to simulate deletion.
    path.unlink()

    q: queue.Queue[object] = queue.Queue()
    handler = LoomEventHandler(loom_dir, q)
    handler._handle_path(str(path))
    # Should still enqueue — the qid is derivable from the path alone.
    assert not q.empty()
    assert q.get_nowait() == str(qid)


def test_handler_debounce_suppresses_duplicate(loom_dir: Path) -> None:
    """Second call within debounce window should not add a second entry."""
    qid = QualifiedId("myproj", "abcdefg", 1, 1)
    path = write_item(loom_dir, qid)
    from loom.rebuild import rebuild

    rebuild(loom_dir)

    debouncer = _Debouncer(delay=10.0)
    q: queue.Queue[object] = queue.Queue()
    handler = LoomEventHandler(loom_dir, q, debounce=debouncer)
    handler._handle_path(str(path))
    handler._handle_path(str(path))  # should be debounced
    debouncer.cancel()

    items = []
    while not q.empty():
        items.append(q.get_nowait())
    assert items == [str(qid)]


# ---------------------------------------------------------------------------
# _start_observer integration + Loom.get_updates() end-to-end tests
# The observer runs a real background thread, so we use polling with a timeout.
# ---------------------------------------------------------------------------


def test_get_updates_detects_creation(loom_dir: Path) -> None:
    """Creating a new .md file under loom_dir should yield its qid."""
    # Bootstrap a valid project tree first so the path is canonical.
    qid = QualifiedId("myproj")
    write_item(loom_dir, qid)
    write_item(loom_dir, QualifiedId("myproj", "backlog"))
    from loom.rebuild import rebuild

    rebuild(loom_dir)

    loom = Loom(root=loom_dir)
    gen = loom.get_updates()
    received: list[str] = []
    done = threading.Event()

    def _consumer() -> None:
        try:
            for qid_str in gen:
                received.append(qid_str)
                if len(received) >= 1:
                    break
        finally:
            done.set()

    t = threading.Thread(target=_consumer, daemon=True)
    t.start()

    # Give observer time to start watching.
    time.sleep(0.2)

    # Create a new task file.
    new_qid = QualifiedId("myproj", "backlog", 1, 1)
    write_item(loom_dir, new_qid)

    done.wait(timeout=_TIMEOUT)
    gen.close()
    t.join(timeout=2.0)

    assert str(new_qid) in received, f"expected {new_qid!s} in {received}"


def test_get_updates_detects_modification(loom_dir: Path) -> None:
    """Modifying an existing .md file should yield its qid."""
    qid = QualifiedId("myproj", "abcdefg", 1, 1)
    write_item(loom_dir, qid)
    write_item(loom_dir, QualifiedId("myproj"))
    write_item(loom_dir, QualifiedId("myproj", "abcdefg"))
    write_item(loom_dir, QualifiedId("myproj", "abcdefg", 1))
    from loom.rebuild import rebuild

    rebuild(loom_dir)

    loom = Loom(root=loom_dir)
    gen = loom.get_updates()
    received: list[str] = []
    done = threading.Event()

    def _consumer() -> None:
        try:
            for qid_str in gen:
                received.append(qid_str)
                if len(received) >= 1:
                    break
        finally:
            done.set()

    t = threading.Thread(target=_consumer, daemon=True)
    t.start()
    time.sleep(0.2)

    # Modify the task file.
    write_item(loom_dir, qid, title="Updated title")

    done.wait(timeout=_TIMEOUT)
    gen.close()
    t.join(timeout=2.0)

    assert str(qid) in received, f"expected {qid!s} in {received}"


def test_get_updates_syncs_index_on_creation(loom_dir: Path) -> None:
    """After yielding, the index should reflect the new item."""
    write_item(loom_dir, QualifiedId("myproj"))
    write_item(loom_dir, QualifiedId("myproj", "backlog"))
    write_item(loom_dir, QualifiedId("myproj", "backlog", 1))
    from loom.rebuild import rebuild

    rebuild(loom_dir)

    loom = Loom(root=loom_dir)
    gen = loom.get_updates()
    received: list[str] = []
    done = threading.Event()

    def _consumer() -> None:
        try:
            for qid_str in gen:
                received.append(qid_str)
                if len(received) >= 1:
                    break
        finally:
            done.set()

    t = threading.Thread(target=_consumer, daemon=True)
    t.start()
    time.sleep(0.2)

    new_qid = QualifiedId("myproj", "backlog", 1, 1)
    write_item(loom_dir, new_qid)

    done.wait(timeout=_TIMEOUT)
    gen.close()
    t.join(timeout=2.0)

    assert str(new_qid) in received
    # Index must reflect the new item after yield.
    idx = Index(loom_dir)
    assert idx.get(str(new_qid)) is not None, "index not updated after yield"


def test_get_updates_clean_shutdown(loom_dir: Path) -> None:
    """Closing the generator must stop and join the observer without hanging."""
    loom = Loom(root=loom_dir)
    gen = loom.get_updates()

    # Start but immediately close.
    start = time.monotonic()
    gen.close()
    elapsed = time.monotonic() - start

    # Should shut down in well under a second.
    assert elapsed < 5.0, f"close took {elapsed:.2f}s — observer may be hanging"


def test_get_updates_detects_archive(loom_dir: Path) -> None:
    """Moving a file to _archive/ should yield the qid."""
    qid = QualifiedId("myproj", "abcdefg", 1, 1)
    write_item(loom_dir, QualifiedId("myproj"))
    write_item(loom_dir, QualifiedId("myproj", "abcdefg"))
    write_item(loom_dir, QualifiedId("myproj", "abcdefg", 1))
    write_item(loom_dir, qid)
    from loom.rebuild import rebuild

    rebuild(loom_dir)

    loom_obj = Loom(root=loom_dir)
    gen = loom_obj.get_updates()
    received: list[str] = []
    done = threading.Event()

    def _consumer() -> None:
        try:
            for qid_str in gen:
                received.append(qid_str)
                if len(received) >= 1:
                    break
        finally:
            done.set()

    t = threading.Thread(target=_consumer, daemon=True)
    t.start()
    time.sleep(0.2)

    # Use the loom API to archive — this moves the file under _archive/.
    task = loom_obj.get(str(qid))
    task.archive()

    done.wait(timeout=_TIMEOUT)
    gen.close()
    t.join(timeout=2.0)

    assert str(qid) in received, f"expected {qid!s} in {received}"
