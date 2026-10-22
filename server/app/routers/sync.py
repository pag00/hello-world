"""POST /sync/push and GET /sync/pull (§7)."""

from __future__ import annotations

import re
from collections import defaultdict
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import models
from ..auth import CurrentUser, get_current_user
from ..db import get_db
from ..deps import J, raw_json_body
from ..ingest import ingest_batch
from ..schemas import UUID_RE, PullResponse, PushResponse
from ..serialize import (
    event_dicts,
    ncr_dict,
    procedure_dict,
    revision_dict,
    run_dict,
    tool_dict,
    user_dict,
    workstation_dict,
)
from .procedures import visible

router = APIRouter(prefix="/sync", tags=["sync"])

MAX_PUSH = 500


@router.post(
    "/push",
    response_model=PushResponse,
    openapi_extra={
        "requestBody": {
            "required": True,
            "content": {"application/json": {"schema": {"$ref": "#/components/schemas/PushRequest"}}},
        }
    },
)
def push(
    body: Any = Depends(raw_json_body),
    db: Session = Depends(get_db),
    cu: CurrentUser = Depends(get_current_user),
):
    # Parsed by hand (not as a pydantic body) so each event is hashed exactly as sent and an invalid
    # event is rejected individually instead of failing the whole request with a 422.
    if not isinstance(body, dict) or not isinstance(body.get("events"), list):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "body must be {device_id, events[]}")
    device_id = body.get("device_id")
    if not isinstance(device_id, str) or not re.fullmatch(UUID_RE, device_id):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "device_id must be a lowercase uuid")
    if len(body["events"]) > MAX_PUSH:
        raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, f"at most {MAX_PUSH} events per push")
    return J({"results": ingest_batch(db, body["events"], cu, device_id)})


@router.get("/pull", response_model=PullResponse)
def pull(
    cursor: str | None = Query(default=None, description="opaque cursor from the previous pull; empty = from start"),
    limit: int = Query(default=500, ge=1, le=1000),
    db: Session = Depends(get_db),
    cu: CurrentUser = Depends(get_current_user),
):
    if cursor in (None, ""):
        after = 0
    elif cursor.isdigit():
        after = int(cursor)
    else:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "invalid cursor")

    rows = list(
        db.execute(
            select(models.ChangeLog.id, models.ChangeLog.entity, models.ChangeLog.entity_id)
            .where(models.ChangeLog.id > after)
            .order_by(models.ChangeLog.id)
            .limit(limit + 1)
        )
    )
    has_more = len(rows) > limit
    rows = rows[:limit]
    next_cursor = str(rows[-1].id) if rows else str(after)

    ids: dict[str, list[str]] = defaultdict(list)
    for r in rows:
        if r.entity_id not in ids[r.entity]:
            ids[r.entity].append(r.entity_id)

    def load(model, key, entity):
        if not ids.get(entity):
            return []
        return list(db.scalars(select(model).where(key.in_(ids[entity]))))

    procedures = sorted(load(models.Procedure, models.Procedure.id, "procedure"), key=lambda p: p.number)
    revisions = [r for r in load(models.ProcedureRevision, models.ProcedureRevision.id, "revision") if visible(r, cu)]
    revisions.sort(key=lambda r: (r.procedure_id, r.seq))
    runs = sorted(load(models.Run, models.Run.id, "run"), key=lambda r: r.created_at)
    events = sorted(load(models.RunEvent, models.RunEvent.id, "event"), key=lambda e: (e.run_id, e.seq))
    tools = sorted(load(models.Tool, models.Tool.id, "tool"), key=lambda t: t.code)
    workstations = sorted(load(models.Workstation, models.Workstation.code, "workstation"), key=lambda w: w.code)
    ncrs = sorted(load(models.Ncr, models.Ncr.id, "ncr"), key=lambda n: n.raised_at)
    users = sorted(load(models.User, models.User.id, "user"), key=lambda u: u.name)

    return J(
        {
            "cursor": next_cursor,
            "has_more": has_more,
            "procedures": [procedure_dict(p) for p in procedures],
            "revisions": [revision_dict(r) for r in revisions],
            "runs": [run_dict(r) for r in runs],
            "events": event_dicts(db, events),
            "tools": [tool_dict(t) for t in tools],
            "workstations": [workstation_dict(w) for w in workstations],
            "ncrs": [ncr_dict(n) for n in ncrs],
            # devices need verifiers to check PINs offline (§8); email is not shipped to devices
            # deactivated users are still sent (without roles/PIN) so devices revoke their offline PIN
            "users": [
                {**user_dict(u), "email": None}
                if u.active
                else {**user_dict(u, []), "email": None, "pin_verifier": None}
                for u in users
            ],
        }
    )
