"""FastAPI application factory for loom_web."""

from __future__ import annotations

import asyncio

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse

from loom.errors import NotFound

from .broadcaster import Broadcaster
from .gateway import LoomGateway
from .schemas import ItemDetail, ProjectSummary, TreeResponse
from .serializers import serialize_item_detail, serialize_project, serialize_tree

_GATEWAY_KEY = "loom_gateway"


def create_app(root: str | None = None) -> FastAPI:
    """Application factory.

    Parameters
    ----------
    root:
        Override ``$LOOM_DIR``; ``None`` uses the environment-resolved path.
    """
    app = FastAPI(title="Loom API", version="0.1.0")
    gateway = LoomGateway(root=root)

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
