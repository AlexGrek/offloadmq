import requests
from pathlib import Path
from typing import Optional, Dict, Any, List, Tuple

from app.ollama import *
from app.systeminfo import *
from app.url_utils import *


class HttpClient:
    def __init__(self, server_base: str, jwt: Optional[str] = None):
        self.base = server_base.rstrip("/")
        self.headers = {"Authorization": f"Bearer {jwt}"} if jwt else {}

    def get(self, *segments: str, timeout: int = 60):
        url = build_url(self.base, *segments)
        return requests.get(url, headers=self.headers, timeout=timeout)

    def post(self, *segments: str, json_body: Dict[str, Any], timeout: int = 60):
        url = build_url(self.base, *segments)
        return requests.post(url, headers=self.headers, json=json_body, timeout=timeout)


def register_agent(
    server: str, capabilities: List[str], tier: int, capacity: int, api_key: str
) -> Dict[str, Any]:
    system_info = collect_system_info()
    registration_data = {
        "capabilities": capabilities,
        "tier": tier,
        "capacity": capacity,
        "systemInfo": system_info,
        "apiKey": api_key,
    }
    url = server.rstrip("/") + "/agent/register"
    print(registration_data)
    resp = requests.post(url, json=registration_data, timeout=30)
    print(resp.content)
    resp.raise_for_status()
    return resp.json()


def authenticate_agent(server: str, agent_id: str, key: str) -> Dict[str, Any]:
    url = server.rstrip("/") + "/agent/auth"
    resp = requests.post(url, json={"agentId": agent_id, "key": key}, timeout=30)
    resp.raise_for_status()
    return resp.json()


def test_ping(server: str, jwt_token: str) -> bool:
    url = server.rstrip("/") + "/private/agent/ping"
    try:
        r = requests.get(
            url, headers={"Authorization": f"Bearer {jwt_token}"}, timeout=30
        )
        return r.status_code == 200
    except requests.RequestException:
        return False
