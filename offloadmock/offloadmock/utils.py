"""Utility helpers mirroring `src/utils.rs` from the Rust server.

These are deliberately byte-for-byte faithful to the originals so the mock
produces identifiers and capability parsing identical to the real service.
"""

from __future__ import annotations

import secrets
import time
from datetime import datetime, timezone

# Crockford base32 alphabet used by ULID (excludes I, L, O, U).
_ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"


def time_sortable_uid() -> str:
    """Generate a ULID — 48-bit ms timestamp + 80 bits of randomness.

    Mirrors `utils::time_sortable_uid()` (the `ulid` crate). The 26-char
    Crockford base32 string is lexicographically sortable by creation time.
    """
    ts = int(time.time() * 1000) & ((1 << 48) - 1)
    rand = secrets.randbits(80)
    value = (ts << 80) | rand
    chars = []
    for _ in range(26):
        chars.append(_ULID_ALPHABET[value & 0x1F])
        value >>= 5
    return "".join(reversed(chars))


def get_last_six_chars(s: str) -> str:
    """Mirror `utils::get_last_six_chars` (byte length, like Rust `str` slicing)."""
    raw = s.encode("utf-8")
    if len(raw) <= 6:
        return s
    return raw[len(raw) - 6:].decode("utf-8", errors="ignore")


def base_capability(cap: str) -> str:
    """Strip extended-attribute notation: ``llm.qwen3:8b[vision]`` -> ``llm.qwen3:8b``."""
    idx = cap.find("[")
    return cap[:idx] if idx != -1 else cap


def capability_attrs(cap: str) -> list[str]:
    """Parse extended attributes: ``llm.x[a;b;c]`` -> ``["a", "b", "c"]``."""
    start = cap.find("[")
    end = cap.rfind("]")
    if start != -1 and end != -1 and end > start:
        return [s for s in cap[start + 1:end].split(";") if s]
    return []


def mb_to_gb_rounded(mb: int) -> int:
    """Mirror `schema::mb_to_gb_rounded` — convert legacy MB counts to whole GB."""
    if mb == 0:
        return 0
    return max(1, (mb + 512) // 1024)


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def iso_z(dt: datetime) -> str:
    """Serialize a datetime the way chrono serializes ``DateTime<Utc>`` — RFC 3339
    with a trailing ``Z`` rather than ``+00:00``.
    """
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
