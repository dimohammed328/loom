"""FastAPI application factory for loom_web."""

from __future__ import annotations

import asyncio
import importlib.resources
import threading
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from loom.api import Loom
from loom.errors import NotFound

from .broadcaster import Broadcaster
from .gateway import LoomGateway
from .schemas import ItemDetail, ProjectSummary, TreeResponse
from .serializers import serialize_item_detail, serialize_project, serialize_tree
from .updates import UpdatesWorker


def _static_dir() -> Path:
    """Resolve the built frontend static assets directory.

    During development the package is installed in editable mode so we can
    reach ``src/loom_web/static/`` relative to this file.  When installed as
    a wheel the ``static/`` sub-package is included via ``[tool.uv_build]``
    (or equivalent) and we locate it via ``importlib.resources``.
    """
    here = Path(__file__).parent
    candidate = here / "static"
    if candidate.is_dir():
        return candidate
    # Fallback: importlib.resources (wheel installs)
    try:
        ref = importlib.resources.files("loom_web") / "static"
        return Path(str(ref))
    except Exception:
        return candidate


_GATEWAY_KEY = "loom_gateway"


def create_app(root: str | None = None) -> FastAPI:
    """Application factory.

    Parameters
    ----------
    root:
        Override ``$LOOM_DIR``; ``None`` uses the environment-resolved path.
    """
    gateway = LoomGateway(root=root)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        """Start the UpdatesWorker thread on startup; stop it on shutdown."""
        hub: Broadcaster = app.state.broadcaster
        loom: Loom = gateway._loom  # type: ignore[attr-defined]
        worker = UpdatesWorker(loom=loom, broadcaster=hub)
        t = threading.Thread(target=worker.run, daemon=True, name="loom-updates-worker")
        t.start()
        app.state.updates_worker = worker
        app.state.updates_thread = t
        try:
            yield
        finally:
            worker.stop()
            t.join(timeout=5.0)

    app = FastAPI(title="Loom API", version="0.1.0", lifespan=lifespan)

    # ------------------------------------------------------------------
    # Store gateway and broadcaster on app.state
    # ------------------------------------------------------------------
    app.state.gateway = gateway
    # Only initialise a fresh Broadcaster if one hasn't been injected
    # already (tests may inject their own hub via app.state.broadcaster).
    if not hasattr(app.state, "broadcaster"):
        app.state.broadcaster = Broadcaster()

    # ------------------------------------------------------------------
    # Exception handlers
    # ------------------------------------------------------------------

    @app.exception_handler(NotFound)
    async def _not_found_handler(request: Request, exc: NotFound) -> JSONResponse:
        return JSONResponse(status_code=404, content={"detail": str(exc)})

    # ------------------------------------------------------------------
    # Routes
    # ------------------------------------------------------------------

    @app.get("/api/projects", response_model=list[ProjectSummary])
    async def list_projects(request: Request) -> list[ProjectSummary]:
        """Return all projects."""
        gw: LoomGateway = request.app.state.gateway
        projects = await gw.list_projects()
        return [serialize_project(p) for p in projects]

    @app.get("/api/projects/{project}/tree", response_model=TreeResponse)
    async def get_project_tree(project: str, request: Request) -> TreeResponse:
        """Return the full epic→story→task hierarchy for *project*."""
        gw: LoomGateway = request.app.state.gateway
        tree_dict = await gw.get_tree(project)
        return serialize_tree(tree_dict)

    @app.get("/api/items/{qid:path}", response_model=ItemDetail)
    async def get_item(qid: str, request: Request) -> ItemDetail:
        """Return full item detail including body, dependencies, dependents, children."""
        gw: LoomGateway = request.app.state.gateway
        item = await gw.get_item_detail(qid)
        detail = serialize_item_detail(item)
        children = await gw.get_children(qid)
        return detail.model_copy(update={"children": children})

    @app.get("/api/health")
    async def health() -> dict:
        """Liveness probe."""
        return {"status": "ok"}

    # ------------------------------------------------------------------
    # Static assets + SPA fallback
    # ------------------------------------------------------------------
    static_dir = _static_dir()
    if static_dir.is_dir():
        # Mount static files at /static so JS/CSS are reachable.
        # The catch-all below serves index.html for every other path so
        # client-side routing works.  API routes registered above take
        # priority over this catch-all because FastAPI evaluates routes
        # in declaration order before the mount.
        app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")

        @app.get("/{full_path:path}", include_in_schema=False)
        async def spa_fallback(full_path: str) -> FileResponse:
            """Serve index.html for any non-API path (SPA client-side routing)."""
            index = static_dir / "index.html"
            return FileResponse(str(index))

    # ------------------------------------------------------------------
    # WebSocket endpoint
    # ------------------------------------------------------------------

    @app.websocket("/ws")
    async def ws_endpoint(websocket: WebSocket) -> None:
        """Stream item-change events to connected clients.

        Each client gets its own :class:`asyncio.Queue`; the broadcaster
        puts messages on every registered queue.  This handler drains its
        queue and forwards each message as JSON until the client disconnects.
        """
        await websocket.accept()
        hub: Broadcaster = websocket.app.state.broadcaster
        q: asyncio.Queue = asyncio.Queue()
        hub.subscribe(q)
        try:
            while True:
                msg = await q.get()
                await websocket.send_json(msg)
        except WebSocketDisconnect:
            pass
        finally:
            hub.unsubscribe(q)

    return app
