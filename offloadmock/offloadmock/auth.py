"""JWT handling, mirroring `src/middleware/auth.rs` (`Auth`).

HS256, claims `{sub, exp}`, one-week expiry. `create_token` returns the token
plus the **absolute** expiry timestamp (same as the Rust impl, which feeds that
value straight into `AgentLoginResponse.expires_in`).
"""

from __future__ import annotations

import time

import jwt

from .errors import AppError

ONE_WEEK = 60 * 60 * 24 * 7  # seconds


class Auth:
    def __init__(self, jwt_secret: str) -> None:
        self._secret = jwt_secret

    def create_token(self, subject: str) -> tuple[str, int]:
        exp = int(time.time()) + ONE_WEEK
        token = jwt.encode({"sub": subject, "exp": exp}, self._secret, algorithm="HS256")
        return token, exp

    def decode_token(self, token: str) -> dict:
        try:
            return jwt.decode(token, self._secret, algorithms=["HS256"])
        except jwt.PyJWTError as e:  # noqa: BLE001 - mirror AppError::Jwt
            raise AppError("jwt", str(e)) from e
