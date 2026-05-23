"""Entry point: start the UI server in headless / server mode."""
from __future__ import annotations

import argparse

import uvicorn

from ui_server.server import create_app


def main() -> None:
    parser = argparse.ArgumentParser(description="OffloadMQ Agent UI Server")
    parser.add_argument("--host", default="127.0.0.1", help="Bind host")
    parser.add_argument("--port", type=int, default=8090, help="Bind port")
    parser.add_argument("--reload", action="store_true", help="Enable hot-reload (dev only)")
    args = parser.parse_args()

    app = create_app()
    print(f"OffloadMQ Agent UI → http://{args.host}:{args.port}")
    uvicorn.run(
        app,
        host=args.host,
        port=args.port,
        reload=args.reload,
        log_level="warning",
    )


if __name__ == "__main__":
    main()
