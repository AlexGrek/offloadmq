"""FastAPI dependencies replicating the auth middleware in
`src/middleware/auth.rs`.

* ``current_agent``       — JWT bearer auth for ``/private/agent/*``.
* ``require_mgmt``        — management token bearer auth for ``/management/*``.
* ``client_auth``         — client API-key auth for ``/api/*`` (X-MGMT-API-KEY
                            override, X-API-Key header, or ``apiKey`` JSON body).
* ``storage_api_key``     — X-API-Key header auth for ``/api/storage/*``.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from fastapi import Request

from .auth import Auth
from .config import settings
from .errors import AppError
from .state import Agent, AppStore

# Singletons wired up in main.py via init_runtime().
store: AppStore = None  # type: ignore[assignment]
auth: Auth = None  # type: ignore[assignment]


def init_runtime(app_store: AppStore, app_auth: Auth) -> None:
    global store, auth
    store = app_store
    auth = app_auth


@dataclass
class ClientAuth:
    mgmt_override: bool
    api_key: Optional[str]


def _bearer(request: Request) -> Optional[str]:
    header = request.headers.get("Authorization")
    if header and header.startswith("Bearer "):
        return header[len("Bearer ") :]
    return None


async def current_agent(request: Request) -> Agent:
    token = _bearer(request)
    if token is None:
        raise AppError.authorization("Unauthorized")
    try:
        claims = auth.decode_token(token)
    except AppError:
        raise AppError.authorization("JWT token invalid")
    sub = claims.get("sub", "")
    agent = store.get_agent(sub)
    if agent is None:
        raise AppError.authorization("Agent not found")
    return agent


async def require_mgmt(request: Request) -> None:
    token = _bearer(request)
    if token is None or token != settings.management_token:
        raise AppError.authorization("Unauthorized")


async def client_auth(request: Request) -> ClientAuth:
    # 1. Management override header.
    mgmt = request.headers.get("X-MGMT-API-KEY")
    if mgmt is not None:
        if mgmt == settings.management_token:
            return ClientAuth(mgmt_override=True, api_key=None)
        raise AppError.authorization("Invalid X-MGMT-API-KEY")

    # 2. Header-based client key.
    xkey = request.headers.get("X-API-Key")
    if xkey is not None:
        if not store.is_key_real_not_revoked(xkey):
            raise AppError.authorization("Unauthorized")
        return ClientAuth(mgmt_override=False, api_key=xkey)

    # 3. Fallback: read `apiKey` from the JSON body.
    try:
        body = await request.json()
    except Exception as e:  # noqa: BLE001
        raise AppError.authorization(f"Failed to parse JSON body: {e}")
    api_key = body.get("apiKey") if isinstance(body, dict) else None
    if api_key is None:
        raise AppError.authorization("Failed to parse JSON body: missing apiKey")
    if not store.is_key_real_not_revoked(api_key):
        raise AppError.authorization(f"Unauthorized: {body!r}")
    return ClientAuth(mgmt_override=False, api_key=api_key)


async def storage_api_key(request: Request) -> str:
    api_key = request.headers.get("X-API-Key")
    if api_key is None:
        raise AppError.authorization(
            "Missing X-API-Key header (use your regular client API key)"
        )
    if not store.is_key_real_not_revoked(api_key):
        raise AppError.authorization("Invalid client API key")
    return api_key
