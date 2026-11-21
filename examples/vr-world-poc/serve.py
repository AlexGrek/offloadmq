# /// script
# requires-python = ">=3.11"
# dependencies = ["cryptography>=42"]
# ///
"""Serve the POC viewer.

  uv run serve.py               http://localhost:8443  (desktop preview, or Quest via Link)
  uv run serve.py --https       https://<lan-ip>:8443  (Quest browser over Wi-Fi; accept the
                                 self-signed certificate warning once - WebXR needs HTTPS)
"""

from __future__ import annotations

import argparse
import datetime as dt
import functools
import http.server
import ipaddress
import socket
import ssl
from pathlib import Path

HERE = Path(__file__).resolve().parent


def lan_ip() -> str:
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        try:
            s.connect(("10.255.255.255", 1))
            return s.getsockname()[0]
        except OSError:
            return "127.0.0.1"


def self_signed(cert: Path, key: Path, ip: str) -> None:
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import NameOID

    k = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "vr-world-poc")])
    now = dt.datetime.now(dt.timezone.utc)
    san = x509.SubjectAlternativeName([
        x509.DNSName("localhost"),
        x509.IPAddress(ipaddress.ip_address("127.0.0.1")),
        x509.IPAddress(ipaddress.ip_address(ip)),
    ])
    c = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(k.public_key())
         .serial_number(x509.random_serial_number()).not_valid_before(now - dt.timedelta(days=1))
         .not_valid_after(now + dt.timedelta(days=30)).add_extension(san, critical=False)
         .sign(k, hashes.SHA256()))
    cert.write_bytes(c.public_bytes(serialization.Encoding.PEM))
    key.write_bytes(k.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                    serialization.NoEncryption()))


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      ".ply": "application/octet-stream", ".json": "application/json"}

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8443)
    ap.add_argument("--https", action="store_true")
    ap.add_argument("--bind", default=None, help="default: 127.0.0.1, or 0.0.0.0 with --https")
    args = ap.parse_args()
    bind = args.bind or ("0.0.0.0" if args.https else "127.0.0.1")

    httpd = http.server.ThreadingHTTPServer((bind, args.port), functools.partial(Handler, directory=str(HERE)))
    if args.https:
        ip = lan_ip()
        certdir = HERE / "runs" / ".tls"
        certdir.mkdir(parents=True, exist_ok=True)
        cert, key = certdir / "cert.pem", certdir / "key.pem"
        if not cert.exists():
            self_signed(cert, key, ip)
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(cert, key)
        httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
        print(f"Quest browser: https://{ip}:{args.port}/  (accept the certificate warning)")
    else:
        print(f"Open http://localhost:{args.port}/")
    httpd.serve_forever()


if __name__ == "__main__":
    main()
