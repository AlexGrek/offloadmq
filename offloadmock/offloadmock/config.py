"""Runtime configuration, mirroring `src/config.rs`.

Defaults match the Rust server, except that the API-key/token defaults are the
documented local-dev values (see CLAUDE.md) so the mock works out of the box.
Every value is overridable through the same environment variables.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field


def _split_keys(raw: str) -> list[str]:
    # Rust splits AGENT_API_KEYS / CLIENT_API_KEYS on ':' (not ',').
    return [s for s in raw.split(":") if s]


@dataclass
class StorageConfig:
    backend: str = "local"
    local_root: str = "./data/file_storage"
    max_buckets_per_key: int = 256
    bucket_size_bytes: int = 1_073_741_824  # 1 GiB
    bucket_ttl_minutes: int = 1440  # 24 h

    @classmethod
    def from_env(cls, database_root_path: str) -> "StorageConfig":
        return cls(
            backend=os.getenv("STORAGE_BACKEND", "local"),
            local_root=os.getenv(
                "STORAGE_LOCAL_ROOT", f"{database_root_path}/file_storage"
            ),
            max_buckets_per_key=int(os.getenv("STORAGE_MAX_BUCKETS_PER_KEY", "256")),
            bucket_size_bytes=int(os.getenv("STORAGE_BUCKET_SIZE_BYTES", str(1_073_741_824))),
            bucket_ttl_minutes=int(os.getenv("STORAGE_BUCKET_TTL_MINUTES", "1440")),
        )


@dataclass
class AppConfig:
    jwt_secret: str = "your-super-secret-and-long-jwt-key"
    database_root_path: str = "./data"
    agent_api_keys: list[str] = field(
        default_factory=lambda: ["ak_live_7f8e9d2c1b4a6f3e8d9c2b1a4f6e8d9c2b1a4f6e"]
    )
    client_api_keys: list[str] = field(default_factory=lambda: ["client_secret_key_123"])
    management_token: str = "this-is-for-testing-management-tokens"
    host: str = "0.0.0.0"
    port: int = 3069
    max_request_body_bytes: int = 2 * 1024 * 1024 * 1024
    # Stale-agent / heuristics cleanup knobs (returned by management endpoints).
    stale_agents_ttl_days: int = 7
    heuristics_ttl_days: int = 7
    heuristics_max_records_per_runner_cap: int = 500
    app_version: str = "unknown"
    storage: StorageConfig = field(default_factory=StorageConfig)

    @classmethod
    def from_env(cls) -> "AppConfig":
        database_root_path = os.getenv("DATABASE_ROOT_PATH", "./data")

        agent_env = os.getenv("AGENT_API_KEYS")
        client_env = os.getenv("CLIENT_API_KEYS")

        return cls(
            jwt_secret=os.getenv("JWT_SECRET", "your-super-secret-and-long-jwt-key"),
            database_root_path=database_root_path,
            agent_api_keys=_split_keys(agent_env)
            if agent_env is not None
            else ["ak_live_7f8e9d2c1b4a6f3e8d9c2b1a4f6e8d9c2b1a4f6e"],
            client_api_keys=_split_keys(client_env)
            if client_env is not None
            else ["client_secret_key_123"],
            management_token=os.getenv("MGMT_TOKEN", "this-is-for-testing-management-tokens"),
            host=os.getenv("HOST", "0.0.0.0"),
            port=int(os.getenv("PORT", "3069")),
            stale_agents_ttl_days=int(os.getenv("STALE_AGENTS_TTL_DAYS", "7")),
            heuristics_ttl_days=int(os.getenv("HEURISTICS_TTL_DAYS", "7")),
            heuristics_max_records_per_runner_cap=int(
                os.getenv("HEURISTICS_MAX_RECORDS_PER_RUNNER_CAP", "500")
            ),
            app_version=os.getenv("APP_VERSION", "unknown"),
            storage=StorageConfig.from_env(database_root_path),
        )


settings = AppConfig.from_env()
