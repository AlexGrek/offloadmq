#!/usr/bin/env python3
"""
OpenAI API Proxy for OffloadMQ — entry point.

Listens on the Ollama/OpenAI port and translates OpenAI-compatible requests
into OffloadMQ urgent tasks. Supports streaming via task progress logs.

Run:
    python proxy.py [--port 11434] [--server http://localhost:3069] [--api-key ...]
"""

import argparse
import logging

import uvicorn

from app import create_app
from client import OffloadMQClient
from image_utils import MAX_DIMENSION


def main():
    parser = argparse.ArgumentParser(
        description="OpenAI/Ollama API proxy backed by OffloadMQ"
    )
    parser.add_argument(
        "--port", type=int, default=11434,
        help="Port to listen on (default: 11434, Ollama's default)",
    )
    parser.add_argument(
        "--host", type=str, default="127.0.0.1",
        help="Host to bind to (default: 127.0.0.1)",
    )
    parser.add_argument(
        "--server", type=str, default="http://localhost:3069",
        help="OffloadMQ server URL (default: http://localhost:3069)",
    )
    parser.add_argument(
        "--api-key", type=str, default="client_secret_key_123",
        help="OffloadMQ client API key",
    )
    parser.add_argument(
        "--log-level", type=str, default="info",
        choices=["debug", "info", "warning", "error"],
        help="Log level (default: info)",
    )
    parser.add_argument(
        "--max-image-dim", type=int, default=MAX_DIMENSION,
        help=f"Maximum image dimension in pixels before resizing (default: {MAX_DIMENSION})",
    )

    args = parser.parse_args()

    logging.basicConfig(
        level=getattr(logging, args.log_level.upper()),
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
    )

    # Apply image dimension override if requested
    if args.max_image_dim != MAX_DIMENSION:
        import image_utils
        image_utils.MAX_DIMENSION = args.max_image_dim

    mq = OffloadMQClient(args.server, args.api_key)

    # Quick connectivity + capability check
    logger = logging.getLogger("openai-proxy")
    try:
        caps = mq.capabilities_online()
        llm_caps = [c for c in caps if c.startswith("llm.")]
        if llm_caps:
            logger.info("Online LLM capabilities: %s", ", ".join(llm_caps))
        else:
            logger.warning(
                "No LLM capabilities online — requests will fail until an agent registers"
            )
    except Exception as e:
        logger.warning("Could not reach OffloadMQ server at %s: %s", args.server, e)
        logger.warning(
            "Proxy will start anyway — requests will fail until the server is reachable"
        )

    app = create_app(mq)

    logger.info("Starting OpenAI API proxy on %s:%d", args.host, args.port)
    logger.info("OffloadMQ server: %s", args.server)
    logger.info("Max image dimension: %d px", args.max_image_dim)
    logger.info("Endpoints:")
    logger.info("  OpenAI:  POST http://%s:%d/v1/chat/completions", args.host, args.port)
    logger.info("  Ollama:  POST http://%s:%d/api/chat", args.host, args.port)
    logger.info("  Models:  GET  http://%s:%d/v1/models", args.host, args.port)

    uvicorn.run(app, host=args.host, port=args.port, log_level=args.log_level)


if __name__ == "__main__":
    main()
