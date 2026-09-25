"""Running agent version.

The release tooling stamps the version into the *entry point* package
(``cli_manager/_version.py``), which core must not import. The entry point
hands it over with :func:`set_app_version` at startup instead; until then (and
in unstamped dev builds) the version is :data:`DEV_VERSION`.
"""
from __future__ import annotations

import re

#: Version reported by unstamped dev builds. Never auto-updated.
DEV_VERSION = "0.0.0.dev0"

_app_version = DEV_VERSION

_RELEASE_RE = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)$")


def set_app_version(version: str) -> None:
    global _app_version
    _app_version = version.strip() or DEV_VERSION


def get_app_version() -> str:
    return _app_version


def parse_version(version: str) -> tuple[int, int, int] | None:
    """Parse a release version (``v0.3.260`` / ``0.3.260``); None if not a release."""
    m = _RELEASE_RE.match(version.strip())
    if m is None:
        return None
    return int(m.group(1)), int(m.group(2)), int(m.group(3))


def is_release_version(version: str) -> bool:
    return parse_version(version) is not None


def is_newer(candidate: str, current: str) -> bool:
    """True only if both are release versions and ``candidate`` > ``current``.

    Dev builds and unparseable versions never compare as newer, so a dev binary
    is never replaced and a garbled server response never triggers a downgrade.
    """
    a, b = parse_version(candidate), parse_version(current)
    return a is not None and b is not None and a > b
