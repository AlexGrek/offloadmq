"""
Backward-compatibility shim.

The WebSocket transport is now implemented in ``app.transport`` as
``WebSocketAgentTransport``.  This module is kept only so that PyInstaller
hidden-import declarations (``--hidden-import app.websocket_client``) in the
build scripts continue to resolve.
"""
from .transport import build_ws_url, WebSocketAgentTransport  # noqa: F401

__all__ = ["build_ws_url", "WebSocketAgentTransport"]
