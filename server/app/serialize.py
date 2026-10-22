"""ORM rows -> wire dicts (types.ts shapes).

Responses are returned as these plain dicts rather than re-serialised through pydantic: revision content
and event payloads are hashed, so optional keys must round-trip exactly as the client sent them
(pydantic would add `"multiline": null` etc. and break the client's hash check).
"""

from __future__ import annotations

import json
from collections.abc import Iterable
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from . import models
from .timeutil import date_iso, iso

FLAG_ORDER = ("conflict", "unlocked", "late_lock", "tool_expired", "tool_unknown", "out_of_tolerance", "blob_missing")


def sort_flags(flags: Iterable[str]) -> list[str]:
    fs = set(flags)
    return [f for f in FLAG_ORDER if f in fs] + sorted(fs - set(FLAG_ORDER))


def user_dict(u: models.User, roles: Iterable[str] | None = None) -> dict[str, Any]:
    return {
        "id": u.id,
        "name": u.name,
        "email": u.email,
        "roles": sorted(set(roles if roles is not None else u.roles)),
        "pin_verifier": u.pin_verifier,
    }


def procedure_dict(p: models.Procedure) -> dict[str, Any]:
    return {"id": p.id, "number": p.number, "title": p.title, "created_at": iso(p.created_at)}


def revision_dict(r: models.ProcedureRevision) -> dict[str, Any]:
    return {
        "id": r.id,
        "procedure_id": r.procedure_id,
        "rev": r.rev,
        "status": r.status,
        "content": r.content,
        "content_hash": r.content_hash,
        "change_reason": r.change_reason,
        "author_id": r.author_id,
        "created_at": iso(r.created_at),
        "submitted_at": iso(r.submitted_at),
        "released_at": iso(r.released_at),
        "obsoleted_at": iso(r.obsoleted_at),
    }


def approval_dict(a: models.Approval) -> dict[str, Any]:
    return {
        "id": a.id,
        "revision_id": a.revision_id,
        "approver_id": a.approver_id,
        "decision": a.decision,
        "comment": a.comment,
        "signed_at": iso(a.signed_at),
    }


def run_dict(r: models.Run) -> dict[str, Any]:
    return {
        "id": r.id,
        "procedure_id": r.procedure_id,
        "revision_id": r.revision_id,
        "serial": r.serial,
        "work_order": r.work_order,
        "status": r.status,
        "created_by": r.created_by,
        "created_at": iso(r.created_at),
        "closed_at": iso(r.closed_at),
    }


def missing_blob_events(db: Session, event_ids: Iterable[str]) -> set[str]:
    """Event ids whose referenced photo blobs are not (yet) uploaded — the derived blob_missing flag."""
    ids = list(event_ids)
    if not ids:
        return set()
    q = (
        select(models.EventBlobRef.event_id)
        .outerjoin(models.Blob, models.Blob.sha256 == models.EventBlobRef.sha256)
        .where(models.EventBlobRef.event_id.in_(ids), models.Blob.sha256.is_(None))
    )
    return set(db.scalars(q))


def event_dict(e: models.RunEvent, blob_missing: bool = False) -> dict[str, Any]:
    d = json.loads(e.canonical)
    flags = list(e.flags or [])
    if blob_missing:
        flags.append("blob_missing")
    d.update(
        content_hash=e.content_hash,
        seq=e.seq,
        prev_chain_hash=e.prev_chain_hash,
        chain_hash=e.chain_hash,
        server_ts=iso(e.server_ts),
        flags=sort_flags(flags),
    )
    return d


def event_dicts(db: Session, events: list[models.RunEvent]) -> list[dict[str, Any]]:
    missing = missing_blob_events(db, [e.id for e in events])
    return [event_dict(e, e.id in missing) for e in events]


def ncr_dict(n: models.Ncr) -> dict[str, Any]:
    return {
        "id": n.id,
        "run_id": n.run_id,
        "step_id": n.step_id,
        "input_id": n.input_id,
        "number": n.number,
        "description": n.description,
        "status": n.status,
        "disposition": n.disposition,
        "disposition_note": n.disposition_note,
        "raised_by": n.raised_by,
        "raised_at": iso(n.raised_at),
        "dispositioned_by": n.dispositioned_by,
        "dispositioned_at": iso(n.dispositioned_at),
        "closed_by": n.closed_by,
        "closed_at": iso(n.closed_at),
    }


def tool_dict(t: models.Tool) -> dict[str, Any]:
    return {
        "id": t.id,
        "code": t.code,
        "description": t.description,
        "calibration_due": date_iso(t.calibration_due),
        "active": t.active,
    }


def workstation_dict(w: models.Workstation) -> dict[str, Any]:
    return {"code": w.code, "name": w.name}


def lock_dict(lock: models.StepLock) -> dict[str, Any]:
    return {
        "lock_id": lock.id,
        "run_id": lock.run_id,
        "step_id": lock.step_id,
        "holder_user": lock.holder_user,
        "holder_device": lock.holder_device,
        "expires_at": iso(lock.expires_at),
    }


def checkout_dict(c: models.RunCheckout) -> dict[str, Any]:
    return {
        "run_id": c.run_id,
        "holder_user": c.holder_user,
        "holder_device": c.holder_device,
        "expires_at": iso(c.expires_at),
    }
