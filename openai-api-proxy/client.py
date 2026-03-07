"""OffloadMQ thin HTTP client."""

import logging
from urllib.parse import quote

import requests

logger = logging.getLogger("openai-proxy.client")


class OffloadMQClient:
    """Thin client for the OffloadMQ server's client API."""

    def __init__(self, server_url: str, api_key: str):
        self.base = server_url.rstrip("/")
        self.api_key = api_key

    def submit_blocking(self, capability: str, payload: dict, timeout: float = 300) -> dict:
        """Submit an urgent task and block until the agent finishes."""
        body = {
            "capability": capability,
            "urgent": True,
            "restartable": False,
            "payload": payload,
            "apiKey": self.api_key,
        }
        r = requests.post(
            f"{self.base}/api/task/submit_blocking",
            json=body,
            timeout=timeout,
        )
        r.raise_for_status()
        return r.json()

    def submit_nonurgent(self, capability: str, payload: dict) -> dict:
        """Submit a non-blocking, non-urgent task; returns task id immediately."""
        body = {
            "capability": capability,
            "urgent": False,
            "restartable": False,
            "payload": payload,
            "apiKey": self.api_key,
        }
        r = requests.post(
            f"{self.base}/api/task/submit",
            json=body,
            timeout=30,
        )
        r.raise_for_status()
        return r.json()

    def poll_task(self, cap: str, task_id: str) -> dict:
        """Poll task status / progress logs."""
        encoded_cap = quote(cap, safe="")
        r = requests.post(
            f"{self.base}/api/task/poll/{encoded_cap}/{task_id}",
            json={"apiKey": self.api_key},
            timeout=30,
        )
        r.raise_for_status()
        return r.json()

    def capabilities_online(self) -> list[str]:
        """Return the list of currently-online capability strings."""
        r = requests.post(
            f"{self.base}/api/capabilities/online",
            json={"apiKey": self.api_key},
            timeout=10,
        )
        r.raise_for_status()
        return r.json()
