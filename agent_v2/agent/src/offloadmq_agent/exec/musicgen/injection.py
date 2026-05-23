"""Payload → ComfyUI injection values for music generation tasks."""

import random
from pathlib import Path
from typing import Any


def build_injection_values(payload: dict[str, Any], task_type: str, data_path: Path) -> dict[str, Any]:
    """Flatten a txt2music payload into a field → value dict ready for injection.

    Supported payload fields:
        tags        — style/genre description string (the "prompt" equivalent)
        lyrics      — song lyrics with [Section] markers
        bpm         — integer tempo
        duration    — integer seconds
        timesignature — string, e.g. "4"
        language    — string, e.g. "en"
        keyscale    — string, e.g. "A minor"
        cfg_scale   — float
        temperature — float
        top_p       — float
        top_k       — float (cast to int by params mapping)
        min_p       — float
        steps       — integer sampler steps
        seed        — integer RNG seed (-1 or absent = random)
    """
    values: dict[str, Any] = {}

    # Always inject a seed to break ComfyUI's execution cache.
    values["seed"] = int(payload["seed"]) if payload.get("seed") and int(payload["seed"]) > 0 else random.randint(0, 2**32 - 1)

    for field in ("tags", "lyrics", "timesignature", "language", "keyscale"):
        if (val := payload.get(field)) is not None:
            values[field] = str(val)

    for field in ("bpm", "steps"):
        if (val := payload.get(field)) is not None:
            values[field] = int(val)

    if (duration := payload.get("duration")) is not None:
        values["duration"] = int(duration)

    for field in ("cfg_scale", "temperature", "top_p", "top_k", "min_p"):
        if (val := payload.get(field)) is not None:
            values[field] = float(val)

    return values
