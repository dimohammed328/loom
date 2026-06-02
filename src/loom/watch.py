"""Filesystem watch: emit qids as `.md` files change under ``$LOOM_DIR``.

``LoomEventHandler`` is a ``watchdog`` ``FileSystemEventHandler`` that
filters raw FS events down to ``.md`` files, maps each path to a loom
qualified id, calls ``rebuild.sync_one`` to keep the index fresh, and
enqueues the affected qid for the consumer.

Usage via the ``Loom`` facade::

    from loom import Loom
    loom = Loom()
    for qid in loom.get_updates():       # blocks; iterate to consume
        print("changed:", qid)

The generator stops (and the background observer is joined) when the
caller breaks out of the loop or closes the generator.
"""

from __future__ import annotations

import queue
import threading
from pathlib import Path

from watchdog.events import FileSystemEvent, FileSystemEventHandler

from .ids import InvalidQualifiedId, qid_from_path

# Sentinel pushed into the queue when the observer stops unexpectedly.
_STOP = object()


class LoomEventHandler(FileSystemEventHandler):
    """Watchdog handler that filters ``.md`` events and enqueues qids.

    :param root: The ``$LOOM_DIR`` root path.
    :param q: The queue to push qualified id strings onto.
    :param debounce_lock: A per-path debounce set + lock managed externally;
        pass ``None`` to skip debouncing (used in tests).
    """

    def __init__(
        self,
        root: Path,
        q: queue.Queue[object],
        *,
        debounce: _Debouncer | None = None,
    ) -> None:
        super().__init__()
        self._root = root
        self._q = q
        self._debounce = debounce

    # watchdog calls on_created / on_modified / on_deleted / on_moved
    def on_created(self, event: FileSystemEvent) -> None:
        self._handle(event)

    def on_modified(self, event: FileSystemEvent) -> None:
        self._handle(event)

    def on_deleted(self, event: FileSystemEvent) -> None:
        self._handle(event)

    def on_moved(self, event: FileSystemEvent) -> None:
        # src_path is gone; dest_path is new.  Handle both.
        self._handle_path(str(event.src_path))
        self._handle_path(str(event.dest_path))

    # ------------------------------------------------------------------

    def _handle(self, event: FileSystemEvent) -> None:
        if event.is_directory:
            return
        self._handle_path(str(event.src_path))

    def _handle_path(self, src_path: str) -> None:
        path = Path(src_path)
        if path.suffix != ".md":
            return
        if self._debounce is not None and not self._debounce.acquire(path):
            return
        try:
            qid, _archived = qid_from_path(path, self._root)
        except (InvalidQualifiedId, ValueError):
            return
        qid_str = str(qid)
        # Sync the index; swallow errors (file may have already vanished).
        try:
            from .rebuild import sync_one

            sync_one(self._root, qid_str)
        except Exception:
            pass
        self._q.put(qid_str)


class _Debouncer:
    """Thread-safe per-path debouncer.

    ``acquire(path)`` returns ``True`` the first time a path is seen within a
    ``delay``-second window and schedules its release.  Subsequent calls within
    the same window return ``False`` so that rapid bursts of FS events for the
    same file produce only a single queue entry.

    ``cancel()`` cancels all pending timers (called during observer teardown).
    """

    def __init__(self, delay: float = 0.05) -> None:
        self._delay = delay
        self._active: set[Path] = set()
        self._timers: list[threading.Timer] = []
        self._lock = threading.Lock()

    def acquire(self, path: Path) -> bool:
        with self._lock:
            if path in self._active:
                return False
            self._active.add(path)
        t = threading.Timer(self._delay, self._release, args=(path,))
        t.daemon = True
        with self._lock:
            self._timers.append(t)
        t.start()
        return True

    def cancel(self) -> None:
        """Cancel all pending release timers and clear the active set."""
        with self._lock:
            timers = list(self._timers)
            self._timers.clear()
            self._active.clear()
        for t in timers:
            t.cancel()

    def _release(self, path: Path) -> None:
        with self._lock:
            self._active.discard(path)
