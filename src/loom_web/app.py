"""FastAPI application factory for loom_web."""

from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from loom.errors import NotFound

from .gateway import LoomGateway
from .schemas import ProjectSummary
from .serializers import serialize_project

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
    # Store gateway on app.state so routes can reach it via request.app.state
    # ------------------------------------------------------------------
    app.state.gateway = gateway

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

    return app
