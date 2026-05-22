"""
PyInstaller runtime hook — runs before any user code.
Sets SSL_CERT_FILE so the bundled Ubuntu OpenSSL finds system CA certs
on non-Ubuntu Linux (e.g. Fedora/RHEL where OPENSSLDIR=/usr/lib/ssl doesn't exist).
Do NOT set OPENSSL_CONF — distro-specific configs may reference providers
(e.g. FIPS) that the bundled Ubuntu OpenSSL cannot load.
"""
import os

for _cert in (
    "/etc/pki/tls/certs/ca-bundle.crt",
    "/etc/ssl/certs/ca-certificates.crt",
    "/etc/ssl/ca-bundle.pem",
    "/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem",
):
    if os.path.exists(_cert):
        os.environ.setdefault("SSL_CERT_FILE", _cert)
        break
