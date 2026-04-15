from __future__ import annotations

import requests
from pathlib import Path
from typing import Optional, Dict, Any, List, Tuple, TYPE_CHECKING

from app.ollama import *
from app.systeminfo import *
from app.url_utils import *

if TYPE_CHECKING:
    from app.transport import AgentTransport

# Version is injected at build time; provide fallback for local dev
try:
    from app._version import APP_VERSION
except ModuleNotFoundError:
    APP_VERSION = "dev"


class HttpClient:
    def __init__(self, server_base: str, jwt: Optional[str] = None):
        self.base = server_base.rstrip("/")
        self.headers = {"Authorization": f"Bearer {jwt}"} if jwt else {}

    def get(self, *segments: str, timeout: int = 60) -> requests.Response:
        url = build_url(self.base, *segments)
        return requests.get(url, headers=self.headers, timeout=timeout)

    def post(self, *segments: str, json_body: Dict[str, Any], timeout: int = 60) -> requests.Response:
        url = build_url(self.base, *segments)
        return requests.post(url, headers=self.headers, json=json_body, timeout=timeout)


def _effective_display_name(
    display_name: Optional[str], system_info: Dict[str, Any]
) -> str:
    """Non-empty custom name from config, else hardware-derived default (same as register)."""
    if display_name is not None:
        stripped = str(display_name).strip()
        if stripped:
            return stripped[:50]
    return compute_default_display_name(system_info)


def register_agent(
    server: str, capabilities: List[str], tier: int, capacity: int, api_key: str,
    display_name: Optional[str] = None,
) -> Dict[str, Any]:
    system_info = collect_system_info()
    resolved_display_name = _effective_display_name(display_name, system_info)
    registration_data = {
        "capabilities": capabilities,
        "tier": tier,
        "capacity": capacity,
        "systemInfo": system_info,
        "apiKey": api_key,
        "appVersion": APP_VERSION,
        "displayName": resolved_display_name,
    }
    url = server.rstrip("/") + "/agent/register"
    print(registration_data)
    resp = requests.post(url, json=registration_data, timeout=30)
    print(resp.content)
    resp.raise_for_status()
    result: Dict[str, Any] = resp.json()
    return result


def authenticate_agent(server: str, agent_id: str, key: str) -> Dict[str, Any]:
    url = server.rstrip("/") + "/agent/auth"
    resp = requests.post(url, json={"agentId": agent_id, "key": key}, timeout=30)
    resp.raise_for_status()
    auth_result: Dict[str, Any] = resp.json()
    return auth_result


def update_agent_capabilities(
    http: AgentTransport, capabilities: List[str], tier: int, capacity: int,
    display_name: Optional[str] = None,
) -> None:
    # Must send the resolved name, not null: the server overwrites display_name on every
    # update, so null would clear the value set at registration (typical Mac install).
    system_info = collect_system_info()
    resolved = _effective_display_name(display_name, system_info)
    body: Dict[str, Any] = {
        "capabilities": capabilities,
        "tier": tier,
        "capacity": capacity,
        "systemInfo": system_info,
        "appVersion": APP_VERSION,
        "displayName": resolved,
    }
    resp = http.post("private", "agent", "info", "update", json_body=body, timeout=30)
    resp.raise_for_status()


def test_ping(server: str, jwt_token: str) -> bool:
    url = server.rstrip("/") + "/private/agent/ping"
    try:
        r = requests.get(
            url, headers={"Authorization": f"Bearer {jwt_token}"}, timeout=30
        )
        return r.status_code == 200
    except requests.RequestException:
        return False
