"""
WebSocket client for connecting to the OffloadMQ server.
"""
import json
import logging
import threading
import time
from urllib.parse import urlparse, urlencode

import websocket

logger = logging.getLogger("agent")


def build_ws_url(server_url: str, jwt_token: str) -> str:
    """Convert HTTP server URL to WebSocket URL with token query param."""
    parsed = urlparse(server_url)

    # Convert http(s) to ws(s)
    if parsed.scheme == "https":
        ws_scheme = "wss"
    else:
        ws_scheme = "ws"

    # Build WebSocket URL with token as query parameter
    ws_url = f"{ws_scheme}://{parsed.netloc}/private/agent/ws?token={jwt_token}"
    return ws_url


class AgentWebSocketClient:
    """WebSocket client that connects to the server and receives messages."""

    def __init__(self, server_url: str, jwt_token: str):
        self.server_url = server_url
        self.jwt_token = jwt_token
        self.ws_url = build_ws_url(server_url, jwt_token)
        self.ws: websocket.WebSocketApp | None = None
        self.connected = False
        self.should_run = True
        self._thread: threading.Thread | None = None

    def on_message(self, ws, message: str):
        """Handle incoming WebSocket messages."""
        try:
            data = json.loads(message)
            msg_type = data.get("type", "unknown")

            if msg_type == "connected":
                logger.info(f"WebSocket connected: {data.get('message')}")
                logger.info(f"Agent ID: {data.get('agent_id')}")
            elif msg_type == "heartbeat":
                counter = data.get("counter", 0)
                timestamp = data.get("timestamp", "")
                logger.debug(f"Heartbeat #{counter} at {timestamp}")
            else:
                logger.info(f"Received message: {data}")

        except json.JSONDecodeError:
            logger.warning(f"Received non-JSON message: {message}")

    def on_error(self, ws, error):
        """Handle WebSocket errors."""
        logger.error(f"WebSocket error: {error}")

    def on_close(self, ws, close_status_code, close_msg):
        """Handle WebSocket connection close."""
        self.connected = False
        logger.info(f"WebSocket connection closed (code={close_status_code}, msg={close_msg})")

    def on_open(self, ws):
        """Handle WebSocket connection open."""
        self.connected = True
        logger.info("WebSocket connection established")

    def connect(self):
        """Establish WebSocket connection."""
        logger.info(f"Connecting to WebSocket: {self.ws_url.split('?')[0]}...")

        self.ws = websocket.WebSocketApp(
            self.ws_url,
            on_message=self.on_message,
            on_error=self.on_error,
            on_close=self.on_close,
            on_open=self.on_open,
        )

        # Run WebSocket in a separate thread
        self._thread = threading.Thread(target=self._run_forever, daemon=True)
        self._thread.start()

    def _run_forever(self):
        """Run the WebSocket connection with auto-reconnect."""
        while self.should_run:
            try:
                self.ws.run_forever(ping_interval=30, ping_timeout=10)
            except Exception as e:
                logger.error(f"WebSocket run error: {e}")

            if self.should_run:
                logger.info("Reconnecting in 5 seconds...")
                time.sleep(5)

    def disconnect(self):
        """Close the WebSocket connection."""
        self.should_run = False
        if self.ws:
            self.ws.close()
        if self._thread:
            self._thread.join(timeout=5)
        logger.info("WebSocket client disconnected")

    def send(self, data: dict):
        """Send a message to the server."""
        if self.ws and self.connected:
            self.ws.send(json.dumps(data))
        else:
            logger.warning("Cannot send message: WebSocket not connected")


def serve_websocket(server_url: str, jwt_token: str) -> None:
    """
    Connect to server via WebSocket and handle messages.
    This replaces the polling mechanism when --ws flag is used.
    """
    client = AgentWebSocketClient(server_url, jwt_token)

    try:
        client.connect()

        # Keep the main thread alive while WebSocket runs
        while client.should_run:
            time.sleep(1)

    except KeyboardInterrupt:
        logger.info("Received interrupt signal, shutting down...")
    finally:
        client.disconnect()
