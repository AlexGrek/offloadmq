"""OffloadMock — a FastAPI mock of the OffloadMQ server.

Replicates the OffloadMQ HTTP/WS API surface and Rust schema definitions
(`src/schema.rs`, `src/models.rs`) so clients and agents can be developed and
tested without the real Rust service. There is **no task subsystem**: the
queue is always empty (see README).
"""

from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

from .auth import Auth
from .config import settings
from .deps import init_runtime
from .errors import AppError
from .responses import OffloadJSONResponse
from .routers import agent, client, client_storage, management, root, testing, ws
from .state import AppStore


def create_app() -> FastAPI:
    store = AppStore(settings)
    auth = Auth(settings.jwt_secret)
    init_runtime(store, auth)

    app = FastAPI(
        title="OffloadMock",
        description="Mock of the OffloadMQ server — mirrors its API and schemas.",
        version=settings.app_version,
        default_response_class=OffloadJSONResponse,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.exception_handler(AppError)
    async def _app_error_handler(_request: Request, exc: AppError) -> OffloadJSONResponse:
        return OffloadJSONResponse(status_code=exc.status, content=exc.to_error_json())

    # Top-level utility + public agent routes.
    app.include_router(root.router)
    app.include_router(agent.public_router)
    app.include_router(ws.router)

    # Nested API surfaces (match main.rs prefixes).
    app.include_router(agent.private_router, prefix="/private/agent")
    app.include_router(management.router, prefix="/management")
    app.include_router(testing.router, prefix="/testing")
    app.include_router(client_storage.router, prefix="/api/storage")
    app.include_router(client.router, prefix="/api")

    return app


app = create_app()


def main() -> None:
    import uvicorn

    uvicorn.run(app, host=settings.host, port=settings.port)


if __name__ == "__main__":
    main()
