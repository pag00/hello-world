from __future__ import annotations

import re
from typing import Annotated, Any

from fastapi import HTTPException, Path, Request, status
from fastapi.responses import JSONResponse

from .canonical import loads_strict
from .schemas import UUID_RE

HEX64 = re.compile(r"^(?:sha256:)?([0-9a-f]{64})$")


def J(data: Any, status_code: int = 200) -> JSONResponse:
    """Plain-dict JSON response (bypasses response_model re-serialisation, see serialize.py)."""
    return JSONResponse(content=data, status_code=status_code)


def not_found(what: str = "not found") -> HTTPException:
    return HTTPException(status.HTTP_404_NOT_FOUND, what)


def conflict(detail: Any) -> HTTPException:
    return HTTPException(status.HTTP_409_CONFLICT, detail)


def unprocessable(detail: Any) -> HTTPException:
    return HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, detail)


def forbidden(detail: str) -> HTTPException:
    return HTTPException(status.HTTP_403_FORBIDDEN, detail)


async def raw_json_body(request: Request) -> Any:
    """Request JSON parsed without floats (FloatToken markers), for hashed content."""
    body = await request.body()
    try:
        return loads_strict(body)
    except ValueError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"invalid JSON: {e}") from e


def parse_sha256(value: str) -> str:
    m = HEX64.match(value)
    if not m:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "expected 64 lowercase hex chars (optionally 'sha256:' prefix)"
        )
    return m.group(1)


UuidPath = Annotated[str, Path(pattern=UUID_RE)]
