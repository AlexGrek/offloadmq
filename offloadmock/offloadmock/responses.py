"""Custom JSON response that serializes datetimes chrono-style (trailing ``Z``)
and dumps Pydantic models by alias, so output matches the Rust server byte-shape.
"""

from __future__ import annotations

import json
from datetime import datetime
from typing import Any

from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse

from .utils import iso_z


class OffloadJSONResponse(JSONResponse):
    media_type = "application/json"

    def render(self, content: Any) -> bytes:
        # jsonable_encoder defaults to by_alias=True and keeps None values,
        # matching serde camelCase + (mostly) non-skipped Option fields.
        encoded = jsonable_encoder(content, custom_encoder={datetime: iso_z})
        return json.dumps(
            encoded, ensure_ascii=False, allow_nan=False, separators=(",", ":")
        ).encode("utf-8")
