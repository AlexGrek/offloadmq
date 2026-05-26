"""Error model mirroring `src/error.rs` (`AppError`).

Produces the exact same JSON envelope, status codes, `type` strings and
`Display`-formatted messages as the Rust server.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class _Kind:
    prefix: str  # Display prefix, e.g. "Not found"
    status: int
    type_str: str


# Mapping mirrors AppError::status_code_number / error_type / Display.
_KINDS = {
    "database": _Kind("Database error", 500, "database_error"),
    "internal": _Kind("Internal error", 500, "internal_error"),
    "serialization": _Kind("Serialization error", 500, "serialization_error"),
    "authentication": _Kind("Authentication failed", 401, "authentication_error"),
    "authorization": _Kind("Authorization failed", 403, "authorization_error"),
    "validation": _Kind("Validation error", 400, "validation_error"),
    "not_found": _Kind("Not found", 404, "not_found"),
    "conflict": _Kind("Conflict", 409, "conflict"),
    "bad_request": _Kind("Bad request", 400, "bad_request"),
    "scheduling_impossible": _Kind("Scheduling impossible", 503, "scheduling impossible"),
    "jwt": _Kind("JWT error", 401, "jwt_error"),
    "io": _Kind("IO error", 500, "io_error"),
    "parse": _Kind("Parse error", 400, "parse_error"),
    "bcrypt": _Kind("Bcrypt error", 500, "bcrypt_error"),
    "client_closed_request": _Kind("Client closed request", 499, "client_closed_request"),
}


class AppError(Exception):
    """Transport-agnostic application error, matching the Rust `AppError` enum."""

    def __init__(self, kind: str, detail: str) -> None:
        self._kind_name = kind
        self._kind = _KINDS[kind]
        self.detail = detail
        super().__init__(self.message)

    # ── derived properties ────────────────────────────────────────────────
    @property
    def message(self) -> str:
        # Mirrors thiserror Display: "<prefix>: <detail>".
        return f"{self._kind.prefix}: {self.detail}"

    @property
    def status(self) -> int:
        return self._kind.status

    @property
    def error_type(self) -> str:
        return self._kind.type_str

    def to_error_json(self) -> dict:
        return {
            "error": {
                "type": self.error_type,
                "message": self.message,
                "status": self.status,
            }
        }

    # ── convenience constructors (mirror AppError::*) ──────────────────────
    @classmethod
    def authentication(cls, msg: str) -> "AppError":
        return cls("authentication", msg)

    @classmethod
    def authorization(cls, msg: str) -> "AppError":
        return cls("authorization", msg)

    @classmethod
    def validation(cls, msg: str) -> "AppError":
        return cls("validation", msg)

    @classmethod
    def not_found(cls, msg: str) -> "AppError":
        return cls("not_found", msg)

    @classmethod
    def conflict(cls, msg: str) -> "AppError":
        return cls("conflict", msg)

    @classmethod
    def bad_request(cls, msg: str) -> "AppError":
        return cls("bad_request", msg)

    @classmethod
    def scheduling_impossible(cls, msg: str) -> "AppError":
        return cls("scheduling_impossible", msg)

    @classmethod
    def internal(cls, msg: str) -> "AppError":
        return cls("internal", msg)

    @classmethod
    def client_closed_request(cls, msg: str) -> "AppError":
        return cls("client_closed_request", msg)
