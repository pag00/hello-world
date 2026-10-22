"""Runs: read access, step locks, run checkout (§6), verification and record export (§10)."""

from __future__ import annotations

import datetime as dt

from fastapi import APIRouter, Depends, Query, Response, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import models
from ..auth import CurrentUser, get_current_user, require_roles
from ..config import get_settings
from ..db import get_db, log_change
from ..deps import J, UuidPath, conflict, forbidden, not_found
from ..ids import uuid7
from ..ledger import append_server_event, lock_run, revision_content, stored_event_dicts
from ..projection import find_step, project
from ..record_export import build_record, render_pdf
from ..schemas import (
    UUID_RE,
    CheckoutRequest,
    LockRequest,
    Run,
    RunCheckout,
    RunEvent,
    RunLocks,
    RunStatus,
    StepLock,
    VerifyResult,
)
from ..serialize import checkout_dict, event_dicts, lock_dict, run_dict
from ..timeutil import now
from ..verify import verify_run

router = APIRouter(tags=["runs"])
OPERATE = ("operator", "inspector", "supervisor")


def _run(db: Session, run_id: str) -> models.Run:
    run = db.get(models.Run, run_id)
    if run is None:
        raise not_found("run not found")
    return run


def _locked_run(db: Session, run_id: str) -> models.Run:
    run = lock_run(db, run_id)
    if run is None:
        raise not_found("run not found")
    return run


def active_locks(db: Session, run_id: str, at: dt.datetime) -> list[models.StepLock]:
    return list(
        db.scalars(
            select(models.StepLock).where(
                models.StepLock.run_id == run_id,
                models.StepLock.released_at.is_(None),
                models.StepLock.expires_at > at,
            )
        )
    )


def active_checkout(db: Session, run_id: str, at: dt.datetime) -> models.RunCheckout | None:
    return db.scalar(
        select(models.RunCheckout)
        .where(
            models.RunCheckout.run_id == run_id,
            models.RunCheckout.released_at.is_(None),
            models.RunCheckout.expires_at > at,
        )
        .order_by(models.RunCheckout.acquired_at.desc())
        .limit(1)
    )


@router.get("/runs", response_model=list[Run])
def list_runs(
    status_: RunStatus | None = Query(default=None, alias="status"),
    procedure_id: str | None = Query(default=None, pattern=UUID_RE),
    serial: str | None = None,
    limit: int = Query(default=200, ge=1, le=1000),
    db: Session = Depends(get_db),
    cu: CurrentUser = Depends(get_current_user),
):
    q = select(models.Run).order_by(models.Run.created_at.desc()).limit(limit)
    if status_:
        q = q.where(models.Run.status == status_)
    if procedure_id:
        q = q.where(models.Run.procedure_id == procedure_id)
    if serial:
        q = q.where(models.Run.serial == serial)
    return J([run_dict(r) for r in db.scalars(q)])


@router.get("/runs/{run_id}", response_model=Run)
def get_run(run_id: UuidPath, db: Session = Depends(get_db), cu: CurrentUser = Depends(get_current_user)):
    return J(run_dict(_run(db, run_id)))


@router.get("/runs/{run_id}/events", response_model=list[RunEvent])
def get_run_events(run_id: UuidPath, db: Session = Depends(get_db), cu: CurrentUser = Depends(get_current_user)):
    _run(db, run_id)
    rows = list(
        db.scalars(select(models.RunEvent).where(models.RunEvent.run_id == run_id).order_by(models.RunEvent.seq))
    )
    return J(event_dicts(db, rows))


@router.get("/runs/{run_id}/projection")
def get_run_projection(run_id: UuidPath, db: Session = Depends(get_db), cu: CurrentUser = Depends(get_current_user)):
    """Server-side RunProjection (same rules as the client); useful for debugging divergence."""
    run = _run(db, run_id)
    return J(project(revision_content(db, run), stored_event_dicts(db, run.id), run.id))


# ---------------------------------------------------------------------------
# Locks & checkout


@router.get("/runs/{run_id}/locks", response_model=RunLocks)
def get_locks(run_id: UuidPath, db: Session = Depends(get_db), cu: CurrentUser = Depends(get_current_user)):
    _run(db, run_id)
    t = now()
    co = active_checkout(db, run_id, t)
    return J(
        {"locks": [lock_dict(lk) for lk in active_locks(db, run_id, t)], "checkout": checkout_dict(co) if co else None}
    )


def _takeover_note(db: Session, run: models.Run, cu: CurrentUser, device_id: str, what: str, holder: str) -> None:
    prev = db.get(models.User, holder)
    append_server_event(
        db,
        run,
        type_="note.added",
        # run-level note: a step-bound note would count as step activity and change the step's state
        step_id=None,
        payload={
            "text": f"{what} taken over by {cu.user.name} from {prev.name if prev else holder}",
            "system": "lock_takeover",
        },
        actor_id=cu.id,
        device_id=device_id,
        event_id=uuid7(),
    )


@router.post("/runs/{run_id}/steps/{step_id}/lock", response_model=StepLock)
def lock_step(
    run_id: UuidPath,
    step_id: UuidPath,
    body: LockRequest,
    db: Session = Depends(get_db),
    cu: CurrentUser = Depends(require_roles(*OPERATE)),
):
    run = _locked_run(db, run_id)
    if run.status in ("completed", "aborted"):
        raise conflict(f"run is {run.status}")
    step = find_step(revision_content(db, run), step_id)
    if step is None:
        raise not_found("step not found in this run's revision")
    if body.force and not cu.has("supervisor"):
        raise forbidden("force takeover requires supervisor")
    s = get_settings()
    t = now()

    co = active_checkout(db, run_id, t)
    if co is not None and co.holder_device != body.device_id:
        if not body.force:
            raise conflict({"message": "run is checked out by another device", "checkout": checkout_dict(co)})
        co.released_at, co.released_reason, co.released_by = t, "takeover", cu.id
        _takeover_note(db, run, cu, body.device_id, "Run checkout", co.holder_user)

    mine = None
    for lk in active_locks(db, run_id, t):
        if lk.step_id != step_id:
            continue
        if lk.holder_device == body.device_id:
            mine = lk
        elif not body.force:
            raise conflict({"message": "step is locked by another device", "lock": lock_dict(lk)})
        else:
            lk.released_at, lk.released_reason, lk.released_by = t, "takeover", cu.id
            _takeover_note(db, run, cu, body.device_id, f"Step lock on '{step['title']}'", lk.holder_user)

    if mine is not None:
        # same device re-locking: extend the existing (still valid) lease
        mine.expires_at = t + dt.timedelta(seconds=s.lock_ttl_seconds)
        mine.holder_user = cu.id
        lock = mine
    else:
        lock = models.StepLock(
            id=uuid7(),
            run_id=run_id,
            step_id=step_id,
            holder_user=cu.id,
            holder_device=body.device_id,
            acquired_at=t,
            expires_at=t + dt.timedelta(seconds=s.lock_ttl_seconds),
        )
        db.add(lock)
    db.commit()
    return J(lock_dict(lock))


def _get_lock(db: Session, lock_id: str) -> models.StepLock:
    lock = db.scalar(
        select(models.StepLock)
        .where(models.StepLock.id == lock_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if lock is None:
        raise not_found("lock not found")
    return lock


@router.post("/locks/{lock_id}/heartbeat", response_model=StepLock)
def heartbeat(
    lock_id: UuidPath,
    device_id: str | None = Query(default=None, pattern=UUID_RE),
    db: Session = Depends(get_db),
    cu: CurrentUser = Depends(get_current_user),
):
    lock = _get_lock(db, lock_id)
    if lock.holder_user != cu.id and lock.holder_device != device_id:
        raise forbidden("not the lock holder")
    t = now()
    if lock.released_at is not None or lock.expires_at <= t:
        # never revive an expired lease: the gap must stay visible (events in it get late_lock)
        raise conflict({"message": "lease expired or released; lock again", "lock": lock_dict(lock)})
    lock.expires_at = t + dt.timedelta(seconds=get_settings().lock_ttl_seconds)
    db.commit()
    return J(lock_dict(lock))


@router.delete("/locks/{lock_id}", status_code=status.HTTP_204_NO_CONTENT)
def release_lock(
    lock_id: UuidPath,
    device_id: str | None = Query(default=None, pattern=UUID_RE),
    db: Session = Depends(get_db),
    cu: CurrentUser = Depends(get_current_user),
):
    lock = _get_lock(db, lock_id)
    if lock.holder_user != cu.id and lock.holder_device != device_id and not cu.has("supervisor"):
        raise forbidden("not the lock holder")
    if lock.released_at is None:
        lock.released_at, lock.released_reason, lock.released_by = now(), "released", cu.id
    db.commit()
    return Response(status_code=204)


@router.post("/runs/{run_id}/checkout", response_model=RunCheckout)
def checkout(
    run_id: UuidPath,
    body: CheckoutRequest,
    db: Session = Depends(get_db),
    cu: CurrentUser = Depends(require_roles(*OPERATE)),
):
    s = get_settings()
    run = _locked_run(db, run_id)
    if run.status in ("completed", "aborted"):
        raise conflict(f"run is {run.status}")
    hours = min(body.hours or s.checkout_default_hours, s.checkout_max_hours)
    t = now()
    others = [lk for lk in active_locks(db, run_id, t) if lk.holder_device != body.device_id]
    if others:
        raise conflict(
            {"message": "steps of this run are locked by another device", "locks": [lock_dict(lk) for lk in others]}
        )
    co = active_checkout(db, run_id, t)
    if co is not None and co.holder_device != body.device_id:
        raise conflict({"message": "run is checked out by another device", "checkout": checkout_dict(co)})
    if co is not None:
        co.expires_at = max(co.expires_at, t + dt.timedelta(hours=hours))
        co.holder_user = cu.id
    else:
        co = models.RunCheckout(
            id=uuid7(),
            run_id=run_id,
            holder_user=cu.id,
            holder_device=body.device_id,
            acquired_at=t,
            expires_at=t + dt.timedelta(hours=hours),
            source="request",
        )
        db.add(co)
    log_change(db, "run", run_id)
    db.commit()
    return J(checkout_dict(co))


@router.delete("/runs/{run_id}/checkout", status_code=status.HTTP_204_NO_CONTENT)
def release_checkout(
    run_id: UuidPath,
    device_id: str | None = Query(default=None, pattern=UUID_RE),
    db: Session = Depends(get_db),
    cu: CurrentUser = Depends(get_current_user),
):
    _locked_run(db, run_id)
    co = active_checkout(db, run_id, now())
    if co is None:
        return Response(status_code=204)
    if co.holder_user != cu.id and co.holder_device != device_id and not cu.has("supervisor"):
        raise forbidden("not the checkout holder")
    co.released_at, co.released_reason, co.released_by = now(), "released", cu.id
    db.commit()
    return Response(status_code=204)


# ---------------------------------------------------------------------------
# Integrity & record


@router.get("/runs/{run_id}/verify", response_model=VerifyResult)
def verify(run_id: UuidPath, db: Session = Depends(get_db), cu: CurrentUser = Depends(get_current_user)):
    return J(verify_run(db, _run(db, run_id)))


@router.get("/runs/{run_id}/record.json")
def record_json(run_id: UuidPath, db: Session = Depends(get_db), cu: CurrentUser = Depends(get_current_user)):
    return J(build_record(db, _run(db, run_id)))


@router.get(
    "/runs/{run_id}/record.pdf",
    response_class=Response,
    responses={200: {"content": {"application/pdf": {"schema": {"type": "string", "format": "binary"}}}}},
)
def record_pdf(run_id: UuidPath, db: Session = Depends(get_db), cu: CurrentUser = Depends(get_current_user)):
    run = _run(db, run_id)
    record = build_record(db, run)
    pdf = render_pdf(record, db)
    filename = f"record-{record['procedure']['number']}-{record['run']['serial']}.pdf".replace('"', "")
    return Response(
        pdf, media_type="application/pdf", headers={"Content-Disposition": f'inline; filename="{filename}"'}
    )
