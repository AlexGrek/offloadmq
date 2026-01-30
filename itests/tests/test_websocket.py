import pytest
import json
import time
import threading
import requests
import websocket


SERVER_URL = "http://localhost:3069"
AGENT_API_KEY = "ak_live_7f8e9d2c1b4a6f3e8d9c2b1a4f6e8d9c2b1a4f6e"


def register_agent():
    """Register a new agent and return agent_id and key."""
    url = f"{SERVER_URL}/agent/register"
    payload = {
        "capabilities": ["debug.echo"],
        "tier": 5,
        "capacity": 1,
        "systemInfo": {
            "os": "linux",
            "client": "pytest-test-client",
            "runtime": "python3",
            "cpuArch": "x86_64",
            "totalMemoryMb": 8192,
        },
        "apiKey": AGENT_API_KEY,
    }
    response = requests.post(url, json=payload, timeout=30)
    response.raise_for_status()
    data = response.json()
    return data["agentId"], data["key"]


def authenticate_agent(agent_id: str, key: str) -> str:
    """Authenticate agent and return JWT token."""
    url = f"{SERVER_URL}/agent/auth"
    payload = {"agentId": agent_id, "key": key}
    response = requests.post(url, json=payload, timeout=30)
    response.raise_for_status()
    return response.json()["token"]


def build_ws_url(jwt_token: str) -> str:
    """Build WebSocket URL with token."""
    return f"ws://localhost:3069/private/agent/ws?token={jwt_token}"


class WebSocketTestClient:
    """Simple WebSocket client for testing."""

    def __init__(self):
        self.messages = []
        self.connected = False
        self.error = None
        self.closed = False

    def on_message(self, ws, message):
        self.messages.append(json.loads(message))

    def on_error(self, ws, error):
        self.error = error

    def on_close(self, ws, close_status_code, close_msg):
        self.closed = True

    def on_open(self, ws):
        self.connected = True


def test_websocket_connection_successful():
    """Test that WebSocket connection can be established with valid JWT."""
    # Register and authenticate agent
    agent_id, key = register_agent()
    jwt_token = authenticate_agent(agent_id, key)

    # Create WebSocket client
    client = WebSocketTestClient()
    ws_url = build_ws_url(jwt_token)

    ws = websocket.WebSocketApp(
        ws_url,
        on_message=client.on_message,
        on_error=client.on_error,
        on_close=client.on_close,
        on_open=client.on_open,
    )

    # Run WebSocket in background thread
    ws_thread = threading.Thread(target=ws.run_forever, daemon=True)
    ws_thread.start()

    # Wait for connection and first message
    timeout = 5
    start = time.time()
    while time.time() - start < timeout:
        if client.connected and len(client.messages) > 0:
            break
        time.sleep(0.1)

    # Close connection
    ws.close()
    ws_thread.join(timeout=2)

    # Assertions
    assert client.connected, "WebSocket should have connected"
    assert client.error is None, f"WebSocket should not have errors: {client.error}"
    assert len(client.messages) > 0, "Should have received at least one message"

    # Check the first message is the connection confirmation
    first_msg = client.messages[0]
    assert first_msg.get("type") == "connected", f"First message should be 'connected', got: {first_msg}"
    assert "agent_id" in first_msg, "Connection message should include agent_id"

    print(f"\nWebSocket connection successful!")
    print(f"Received {len(client.messages)} message(s)")
    print(f"First message: {json.dumps(first_msg, indent=2)}")


def test_websocket_connection_fails_with_invalid_token():
    """Test that WebSocket connection fails with invalid JWT."""
    client = WebSocketTestClient()
    ws_url = build_ws_url("invalid_token_12345")

    ws = websocket.WebSocketApp(
        ws_url,
        on_message=client.on_message,
        on_error=client.on_error,
        on_close=client.on_close,
        on_open=client.on_open,
    )

    # Run WebSocket in background thread
    ws_thread = threading.Thread(target=ws.run_forever, daemon=True)
    ws_thread.start()

    # Wait a bit for connection attempt
    time.sleep(2)

    # Close connection
    ws.close()
    ws_thread.join(timeout=2)

    # With invalid token, we should either get an error or not receive any messages
    # The server should reject the connection
    assert not client.connected or len(client.messages) == 0 or client.error is not None, \
        "Connection with invalid token should fail or receive no messages"

    print("\nWebSocket correctly rejected invalid token")


def test_websocket_receives_heartbeat():
    """Test that WebSocket receives heartbeat messages."""
    # Register and authenticate agent
    agent_id, key = register_agent()
    jwt_token = authenticate_agent(agent_id, key)

    # Create WebSocket client
    client = WebSocketTestClient()
    ws_url = build_ws_url(jwt_token)

    ws = websocket.WebSocketApp(
        ws_url,
        on_message=client.on_message,
        on_error=client.on_error,
        on_close=client.on_close,
        on_open=client.on_open,
    )

    # Run WebSocket in background thread
    ws_thread = threading.Thread(target=ws.run_forever, daemon=True)
    ws_thread.start()

    # Wait for connection and heartbeat (heartbeat is sent every 5 seconds)
    timeout = 8
    start = time.time()
    heartbeat_received = False
    while time.time() - start < timeout:
        for msg in client.messages:
            if msg.get("type") == "heartbeat":
                heartbeat_received = True
                break
        if heartbeat_received:
            break
        time.sleep(0.5)

    # Close connection
    ws.close()
    ws_thread.join(timeout=2)

    # Assertions
    assert client.connected, "WebSocket should have connected"
    assert heartbeat_received, "Should have received a heartbeat message"

    # Find heartbeat message
    heartbeat_msg = next((m for m in client.messages if m.get("type") == "heartbeat"), None)
    assert heartbeat_msg is not None
    assert "counter" in heartbeat_msg, "Heartbeat should include counter"
    assert "timestamp" in heartbeat_msg, "Heartbeat should include timestamp"

    print(f"\nHeartbeat received successfully!")
    print(f"Heartbeat: {json.dumps(heartbeat_msg, indent=2)}")
