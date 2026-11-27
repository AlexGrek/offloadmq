"""Replace credential values with ``[MASKED]`` in everything a shell job reports."""
from __future__ import annotations

import re
from typing import Iterable

MASK = "[MASKED]"
MIN_SECRET_LEN = 4


class Masker:
    def __init__(self, secrets: Iterable[str] = ()) -> None:
        self._secrets: set[str] = set()
        self._pattern: re.Pattern[str] | None = None
        for secret in secrets:
            self.add(secret)

    def add(self, value: str) -> None:
        parts = {value.strip()}
        if "\n" in value:  # multi-line values (keys, kubeconfigs) leak line by line
            parts.update(line.strip() for line in value.splitlines())
        added = {p for p in parts if len(p) >= MIN_SECRET_LEN} - self._secrets
        if added:
            self._secrets |= added
            ordered = sorted(self._secrets, key=len, reverse=True)  # longest first
            self._pattern = re.compile("|".join(re.escape(s) for s in ordered))

    def __call__(self, text: str) -> str:
        if not text or self._pattern is None:
            return text
        return self._pattern.sub(MASK, text)
