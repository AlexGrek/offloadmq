"""Make TLS verification work in PyInstaller builds on any Linux distro.

A frozen binary carries the *build host's* OpenSSL, whose compiled-in CA
location (``/usr/lib/ssl`` on the Ubuntu CI runner) doesn't exist on e.g.
Fedora (``/etc/pki/tls``). ``requests`` is unaffected (it uses certifi), but
aiohttp — the agent's server connection — and urllib fail every handshake with
CERTIFICATE_VERIFY_FAILED. OpenSSL reads ``SSL_CERT_FILE`` whenever a context
loads its default paths, so pointing it at the host's bundle fixes both.
"""
from __future__ import annotations

import os
import ssl
import sys

#: True once ensure_ca_bundle() set SSL_CERT_FILE itself (vs. inherited).
injected = False

_SYSTEM_BUNDLES = (
    "/etc/ssl/certs/ca-certificates.crt",  # Debian, Ubuntu, Arch, Alpine
    "/etc/pki/tls/certs/ca-bundle.crt",  # Fedora, RHEL, CentOS
    "/etc/ssl/ca-bundle.pem",  # openSUSE
    "/etc/ssl/cert.pem",  # Alpine, others
)


def _default_paths_usable() -> bool:
    paths = ssl.get_default_verify_paths()
    if paths.cafile and os.path.isfile(paths.cafile):
        return True
    return bool(paths.capath and os.path.isdir(paths.capath) and os.listdir(paths.capath))


def ensure_ca_bundle() -> None:
    """Set ``SSL_CERT_FILE`` if OpenSSL's built-in CA location is missing (Linux only)."""
    global injected
    if sys.platform != "linux":
        return
    if os.environ.get("SSL_CERT_FILE") or os.environ.get("SSL_CERT_DIR"):
        return
    if _default_paths_usable():
        return
    for bundle in _SYSTEM_BUNDLES:
        if os.path.isfile(bundle):
            os.environ["SSL_CERT_FILE"] = bundle
            injected = True
            return
    try:
        import certifi
    except ImportError:
        return
    os.environ["SSL_CERT_FILE"] = certifi.where()
    injected = True
