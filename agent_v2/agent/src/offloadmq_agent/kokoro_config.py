"""Kokoro TTS endpoint settings (read from ~/.offloadmq-agent.json)."""
from __future__ import annotations

from urllib.parse import urlparse

from offloadmq_agent.settings_util import load_agent_settings

_DEFAULT_SPEECH_URL = "https://localhost:8443/v1/audio/speech"


def kokoro_speech_url() -> str:
    """OpenAI-compatible ``/v1/audio/speech`` URL used for synthesis requests."""
    cfg = load_agent_settings()
    url = (cfg.get("kokoro_api_url") or "").strip()
    return url or _DEFAULT_SPEECH_URL


def kokoro_api_key() -> str:
    """Bearer token for Kokoro; empty means no Authorization header."""
    return (load_agent_settings().get("kokoro_api_key") or "").strip()


def kokoro_base_url() -> str:
    """Scheme + host derived from the configured speech URL (for /v1/audio/voices)."""
    parsed = urlparse(kokoro_speech_url())
    return f"{parsed.scheme}://{parsed.netloc}"


def kokoro_verify_tls() -> bool:
    """Skip TLS verification for localhost (matches capability probe behaviour)."""
    host = urlparse(kokoro_speech_url()).hostname or ""
    return host not in ("localhost", "127.0.0.1", "::1")
