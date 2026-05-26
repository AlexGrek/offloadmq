"""Predefined (and randomized) task payload templates for the `/testing/*` API.

OffloadMock has no real executors, but the testing surface lets you *inject*
tasks into the in-memory queue so a real agent can poll, take, run, and resolve
them end-to-end. The payloads here are realistic enough that the V2 agent's
executors accept them (see ``agent_v2/.../exec/*``):

* ``debug.echo``      → ``{"message", "delay"}``
* ``shell.bash`` /
  ``shellcmd.bash``   → ``{"command"}``
* ``llm.*``           → ``{"prompt"}`` (executor wraps it into chat messages)
* ``imggen.*``        → ``{"prompt", "width", "height", "steps", "seed"}``
* ``txt2music.*``     → ``{"prompt", "duration"}``
* ``tts.kokoro``      → ``{"text", "voice"}``
* ``slavemode.*``     → control payloads (see :data:`SLAVEMODE_COMMANDS`)
* anything else       → a generic ``{"input", "nonce"}`` payload

Templates are keyed by *base* capability (extended ``[attr;...]`` brackets are
stripped) and then by the first dotted segment, so ``llm.qwen3:8b`` and
``llm.phi3`` both resolve to the ``llm`` template.
"""

from __future__ import annotations

import random
import secrets
from typing import Any, Callable, Dict, List

from .utils import base_capability

# ---------------------------------------------------------------------------
# Randomization pools
# ---------------------------------------------------------------------------

_PROMPTS: List[str] = [
    "Explain the CAP theorem in two sentences.",
    "Write a haiku about distributed systems.",
    "What is the difference between a queue and a stack?",
    "Summarize why idempotency matters for retries.",
    "Give me one tip for debugging a flaky integration test.",
]

_SCENES: List[str] = [
    "a lighthouse on a stormy coast, oil painting",
    "a neon-lit cyberpunk alley in the rain",
    "a cozy cabin in a snowy pine forest at dawn",
    "an astronaut planting a flag on a red desert moon",
    "a koi pond with autumn maple leaves, watercolor",
]

_SPEECH: List[str] = [
    "The quick brown fox jumps over the lazy dog.",
    "OffloadMock is pretending to be a real server right now.",
    "Testing one, two, three.",
    "All systems nominal.",
]

_MUSIC: List[str] = [
    "lo-fi hip hop beat to relax to",
    "uplifting orchestral cinematic score",
    "8-bit chiptune adventure theme",
    "ambient synth pad, slow and dreamy",
]

_VOICES: List[str] = ["af", "am", "bf", "bm"]


def _nonce() -> str:
    """Short random tag so otherwise-identical tasks stay distinguishable."""
    return secrets.token_hex(4)


# ---------------------------------------------------------------------------
# Per-capability payload builders
# ---------------------------------------------------------------------------


def _debug_payload(cap: str, randomize: bool) -> Dict[str, Any]:
    nonce = _nonce() if randomize else "fixed"
    return {"message": f"hello from OffloadMock ({nonce})", "delay": 0, "nonce": nonce}


def _shell_payload(cap: str, randomize: bool) -> Dict[str, Any]:
    nonce = _nonce() if randomize else "fixed"
    return {"command": f"echo offloadmock-{nonce}"}


def _llm_payload(cap: str, randomize: bool) -> Dict[str, Any]:
    prompt = random.choice(_PROMPTS) if randomize else _PROMPTS[0]
    return {"prompt": prompt}


def _imggen_payload(cap: str, randomize: bool) -> Dict[str, Any]:
    return {
        "prompt": random.choice(_SCENES) if randomize else _SCENES[0],
        "width": 512,
        "height": 512,
        "steps": 20,
        "seed": secrets.randbelow(2**31) if randomize else 0,
    }


def _music_payload(cap: str, randomize: bool) -> Dict[str, Any]:
    return {
        "prompt": random.choice(_MUSIC) if randomize else _MUSIC[0],
        "duration": random.choice([8, 12, 16]) if randomize else 8,
    }


def _tts_payload(cap: str, randomize: bool) -> Dict[str, Any]:
    return {
        "text": random.choice(_SPEECH) if randomize else _SPEECH[0],
        "voice": random.choice(_VOICES) if randomize else _VOICES[0],
    }


def _generic_payload(cap: str, randomize: bool) -> Dict[str, Any]:
    nonce = _nonce() if randomize else "fixed"
    return {"input": f"offloadmock-{nonce}", "nonce": nonce}


# First-segment → builder. Extend here when the agent gains executors.
_BUILDERS: Dict[str, Callable[[str, bool], Dict[str, Any]]] = {
    "debug": _debug_payload,
    "shell": _shell_payload,
    "shellcmd": _shell_payload,
    "llm": _llm_payload,
    "imggen": _imggen_payload,
    "txt2music": _music_payload,
    "musicgen": _music_payload,
    "tts": _tts_payload,
}


# ---------------------------------------------------------------------------
# Slavemode commands
# ---------------------------------------------------------------------------

# Maps each slavemode capability to a sensible default payload. Mirrors the
# executor catalog in agent_v2 (`exec/slavemode.py` → ALL_SLAVEMODE_CAPS).
SLAVEMODE_COMMANDS: Dict[str, Dict[str, Any]] = {
    "slavemode.force-rescan": {},
    "slavemode.ollama-list": {},
    "slavemode.ollama-pull": {"model": "qwen3:8b"},
    "slavemode.ollama-delete": {"model": "qwen3:8b"},
    "slavemode.onnx-models-list": {},
    "slavemode.onnx-models-prepare": {"model": "nudenet"},
    "slavemode.onnx-models-delete": {"model": "nudenet"},
    "slavemode.special-caps-ctrl": {"get": True},
}

SLAVEMODE_PREFIX = "slavemode."


def normalize_slavemode_capability(command: str) -> str:
    """Accept ``force-rescan`` or ``slavemode.force-rescan`` → fully-qualified cap.

    Returns an empty string for inputs that look like a *different* capability
    (e.g. ``debug.echo``) so the caller can reject them with a clear error
    rather than silently producing ``slavemode.debug.echo``.
    """
    command = command.strip()
    if not command:
        return ""
    if command.startswith(SLAVEMODE_PREFIX):
        return command
    if "." in command:
        # Looks like a non-slavemode cap (e.g. "debug.echo"); refuse to prepend.
        return ""
    return f"{SLAVEMODE_PREFIX}{command}"


def slavemode_default_payload(capability: str) -> Dict[str, Any]:
    """Default payload for a known slavemode command (empty dict if unknown)."""
    return dict(SLAVEMODE_COMMANDS.get(capability, {}))


def known_slavemode_commands() -> List[str]:
    return sorted(SLAVEMODE_COMMANDS.keys())


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def generate_payload(capability: str, randomize: bool = True) -> Any:
    """Build a payload for ``capability``.

    Slavemode caps use their documented default payload; everything else uses
    the per-prefix builder, falling back to a generic payload for unknown caps.
    """
    base = base_capability(capability)
    if base.startswith(SLAVEMODE_PREFIX):
        return slavemode_default_payload(base)
    segment = base.split(".", 1)[0]
    builder = _BUILDERS.get(segment, _generic_payload)
    return builder(base, randomize)


def known_capabilities() -> List[str]:
    """Sample base capabilities the generator has dedicated templates for."""
    return [
        "debug.echo",
        "shell.bash",
        "shellcmd.bash",
        "llm.qwen3:8b",
        "imggen.sdxl",
        "txt2music.musicgen",
        "tts.kokoro",
    ]
