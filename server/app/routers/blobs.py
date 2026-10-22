"""Content-addressed blobs (photos, reference images) in S3 (§7)."""

from __future__ import annotations

import hashlib

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy.orm import Session

from .. import models
from ..auth import CurrentUser, get_current_user
from ..config import get_settings
from ..db import get_db
from ..deps import J, not_found, parse_sha256
from ..ingest import log_blob_arrival
from ..schemas import BlobMeta
from ..storage import get_storage
from ..timeutil import iso

router = APIRouter(tags=["blobs"])


async def limited_body(request: Request) -> bytes:
    limit = get_settings().blob_max_bytes
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > limit:
        raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, f"blob exceeds {limit} bytes")
    chunks = []
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > limit:
            raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, f"blob exceeds {limit} bytes")
        chunks.append(chunk)
    return b"".join(chunks)


def _meta(b: models.Blob) -> dict:
    return {"sha256": b.sha256, "size": b.size, "mime": b.mime, "created_at": iso(b.created_at)}


@router.put(
    "/blobs/{sha256}",
    response_model=BlobMeta,
    status_code=status.HTTP_201_CREATED,
    openapi_extra={
        "requestBody": {
            "required": True,
            "content": {"application/octet-stream": {"schema": {"type": "string", "format": "binary"}}},
        }
    },
)
def put_blob(
    sha256: str,
    request: Request,
    data: bytes = Depends(limited_body),
    db: Session = Depends(get_db),
    cu: CurrentUser = Depends(get_current_user),
):
    hex_ = parse_sha256(sha256)
    actual = hashlib.sha256(data).hexdigest()
    if actual != hex_:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, f"sha256 mismatch: body hashes to {actual}")
    existing = db.get(models.Blob, hex_)
    if existing is not None:
        return J(_meta(existing), 200)
    mime = (request.headers.get("content-type") or "application/octet-stream").split(";")[0].strip()[:255]
    get_storage().put(hex_, data, mime)
    blob = models.Blob(sha256=hex_, size=len(data), mime=mime, uploaded_by=cu.id)
    db.add(blob)
    log_blob_arrival(db, hex_)
    db.commit()
    db.refresh(blob)
    return J(_meta(blob), 201)


@router.head("/blobs/{sha256}")
def head_blob(sha256: str, db: Session = Depends(get_db), cu: CurrentUser = Depends(get_current_user)):
    blob = db.get(models.Blob, parse_sha256(sha256))
    if blob is None:
        return Response(status_code=404)
    return Response(status_code=200, headers={"Content-Length": str(blob.size), "Content-Type": blob.mime})


@router.get(
    "/blobs/{sha256}",
    responses={200: {"content": {"application/octet-stream": {"schema": {"type": "string", "format": "binary"}}}}},
    response_class=Response,
)
def get_blob(sha256: str, db: Session = Depends(get_db), cu: CurrentUser = Depends(get_current_user)):
    hex_ = parse_sha256(sha256)
    blob = db.get(models.Blob, hex_)
    if blob is None:
        raise not_found("blob not found")
    data = get_storage().get(hex_)
    if data is None:
        raise not_found("blob bytes missing from storage")
    # content-addressed: bytes for a hash never change
    return Response(
        content=data,
        media_type=blob.mime,
        headers={"Cache-Control": "private, max-age=31536000, immutable", "ETag": f'"{hex_}"'},
    )
