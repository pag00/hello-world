"""Procedures, revisions and approvals (§3.1 state machine, server-enforced)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .. import models
from ..auth import CurrentUser, get_current_user, require_roles
from ..canonical import hash_canonical
from ..db import get_db, log_change
from ..deps import J, UuidPath, conflict, forbidden, not_found, unprocessable
from ..ids import uuid7
from ..revisions import empty_content, find_nul, release_problems, rev_letter
from ..schemas import (
    Approval,
    CreateProcedureRequest,
    CreateProcedureResponse,
    CreateRevisionRequest,
    DecisionRequest,
    Procedure,
    ProcedureDetail,
    ProcedureRevision,
    RevisionContent,
    UpdateDraftRequest,
)
from ..serialize import approval_dict, procedure_dict, revision_dict
from ..timeutil import now

router = APIRouter(tags=["procedures"])


def can_see_unreleased(cu: CurrentUser) -> bool:
    return cu.has("author", "approver")


def visible(rev: models.ProcedureRevision, cu: CurrentUser) -> bool:
    return rev.status in ("released", "obsolete") or can_see_unreleased(cu)


def content_dict(content: RevisionContent) -> dict:
    # strict + extra=forbid validation means this reproduces the client's JSON exactly (absent optional
    # keys stay absent), so the stored content hashes the same on the client.
    d = content.model_dump(mode="python", by_alias=True, exclude_unset=True)
    nul = find_nul(d)
    if nul:
        raise unprocessable(f"NUL character not allowed in content at {nul}")
    return d


def _get_revision(db: Session, revision_id: str, *, lock: bool = False) -> models.ProcedureRevision:
    q = select(models.ProcedureRevision).where(models.ProcedureRevision.id == revision_id)
    if lock:
        q = q.with_for_update().execution_options(populate_existing=True)
    rev = db.scalar(q)
    if rev is None:
        raise not_found("revision not found")
    return rev


def _lock_procedure(db: Session, procedure_id: str) -> models.Procedure:
    proc = db.scalar(
        select(models.Procedure)
        .where(models.Procedure.id == procedure_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if proc is None:
        raise not_found("procedure not found")
    return proc


@router.get("/procedures", response_model=list[Procedure])
def list_procedures(db: Session = Depends(get_db), cu: CurrentUser = Depends(get_current_user)):
    procs = db.scalars(select(models.Procedure).order_by(models.Procedure.number))
    return J([procedure_dict(p) for p in procs])


@router.post("/procedures", response_model=CreateProcedureResponse, status_code=status.HTTP_201_CREATED)
def create_procedure(
    body: CreateProcedureRequest,
    db: Session = Depends(get_db),
    cu: CurrentUser = Depends(require_roles("author")),
):
    content = content_dict(body.content) if body.content else empty_content()
    if db.scalar(select(models.Procedure.id).where(models.Procedure.number == body.number)):
        raise conflict(f"procedure number {body.number} already exists")
    proc = models.Procedure(id=uuid7(), number=body.number, title=body.title, created_by=cu.id, created_at=now())
    rev = models.ProcedureRevision(
        id=uuid7(),
        procedure_id=proc.id,
        rev=rev_letter(1),
        seq=1,
        status="draft",
        content=content,
        content_hash=None,
        change_reason=None,
        author_id=cu.id,
        contributor_ids=[cu.id],
        created_at=now(),
        updated_at=now(),
    )
    db.add(proc)
    db.flush()
    db.add(rev)
    log_change(db, "procedure", proc.id)
    log_change(db, "revision", rev.id)
    try:
        db.commit()
    except IntegrityError as e:
        db.rollback()
        raise conflict(f"procedure number {body.number} already exists") from e
    return J({"procedure": procedure_dict(proc), "revision": revision_dict(rev)}, 201)


@router.get("/procedures/{procedure_id}", response_model=ProcedureDetail)
def get_procedure(procedure_id: UuidPath, db: Session = Depends(get_db), cu: CurrentUser = Depends(get_current_user)):
    proc = db.get(models.Procedure, procedure_id)
    if proc is None:
        raise not_found("procedure not found")
    revs = db.scalars(
        select(models.ProcedureRevision)
        .where(models.ProcedureRevision.procedure_id == procedure_id)
        .order_by(models.ProcedureRevision.seq)
    )
    return J({"procedure": procedure_dict(proc), "revisions": [revision_dict(r) for r in revs if visible(r, cu)]})


@router.post(
    "/procedures/{procedure_id}/revisions", response_model=ProcedureRevision, status_code=status.HTTP_201_CREATED
)
def create_revision(
    procedure_id: UuidPath,
    body: CreateRevisionRequest,
    db: Session = Depends(get_db),
    cu: CurrentUser = Depends(require_roles("author")),
):
    _lock_procedure(db, procedure_id)
    revs = list(
        db.scalars(
            select(models.ProcedureRevision)
            .where(models.ProcedureRevision.procedure_id == procedure_id)
            .order_by(models.ProcedureRevision.seq)
        )
    )
    open_rev = next((r for r in revs if r.status in ("draft", "in_review")), None)
    if open_rev is not None:
        raise conflict(f"revision {open_rev.rev} is still {open_rev.status}; finish it first")
    if not body.change_reason.strip():
        raise unprocessable("change_reason is required")
    latest = revs[-1] if revs else None
    seq = (latest.seq if latest else 0) + 1
    rev = models.ProcedureRevision(
        id=uuid7(),
        procedure_id=procedure_id,
        rev=rev_letter(seq),
        seq=seq,
        status="draft",
        content=latest.content if latest else empty_content(),
        content_hash=None,
        change_reason=body.change_reason,
        author_id=cu.id,
        contributor_ids=[cu.id],
        created_at=now(),
        updated_at=now(),
    )
    db.add(rev)
    log_change(db, "revision", rev.id)
    db.commit()
    return J(revision_dict(rev), 201)


@router.get("/revisions/{revision_id}", response_model=ProcedureRevision)
def get_revision(revision_id: UuidPath, db: Session = Depends(get_db), cu: CurrentUser = Depends(get_current_user)):
    rev = _get_revision(db, revision_id)
    if not visible(rev, cu):
        raise not_found("revision not found")
    return J(revision_dict(rev))


@router.put("/revisions/{revision_id}/content", response_model=ProcedureRevision)
def update_draft(
    revision_id: UuidPath,
    body: UpdateDraftRequest,
    db: Session = Depends(get_db),
    cu: CurrentUser = Depends(require_roles("author")),
):
    rev = _get_revision(db, revision_id, lock=True)
    if rev.status != "draft":
        raise conflict(f"revision is {rev.status}; only drafts can be edited")
    rev.content = content_dict(body.content)
    if body.change_reason is not None:
        if rev.seq > 1 and not body.change_reason.strip():
            raise unprocessable("change_reason is required after the first revision")
        rev.change_reason = body.change_reason or None
    if cu.id not in rev.contributor_ids:
        rev.contributor_ids = [*rev.contributor_ids, cu.id]
    rev.updated_at = now()
    log_change(db, "revision", rev.id)
    db.commit()
    return J(revision_dict(rev))


@router.post("/revisions/{revision_id}/submit", response_model=ProcedureRevision)
def submit_revision(
    revision_id: UuidPath, db: Session = Depends(get_db), cu: CurrentUser = Depends(require_roles("author"))
):
    rev = _get_revision(db, revision_id, lock=True)
    if rev.status != "draft":
        raise conflict(f"revision is {rev.status}; only drafts can be submitted")
    if rev.seq > 1 and not (rev.change_reason or "").strip():
        raise unprocessable("change_reason is required after the first revision")
    RevisionContent.model_validate(rev.content)
    problems = release_problems(db, rev.content)
    if problems:
        raise unprocessable({"message": "revision content is not releasable", "problems": problems})
    rev.status = "in_review"
    rev.content_hash = hash_canonical(rev.content)
    rev.submitted_at = now()
    log_change(db, "revision", rev.id)
    db.commit()
    return J(revision_dict(rev))


def _decide(db: Session, revision_id: str, cu: CurrentUser) -> models.ProcedureRevision:
    rev = _get_revision(db, revision_id)
    _lock_procedure(db, rev.procedure_id)
    rev = _get_revision(db, revision_id, lock=True)
    if rev.status != "in_review":
        raise conflict(f"revision is {rev.status}; only revisions in review can be decided")
    if cu.id == rev.author_id or cu.id in (rev.contributor_ids or []):
        raise forbidden("approvers may not decide on a revision they authored or edited")
    return rev


@router.post("/revisions/{revision_id}/approve", response_model=ProcedureRevision)
def approve_revision(
    revision_id: UuidPath,
    body: DecisionRequest | None = None,
    db: Session = Depends(get_db),
    cu: CurrentUser = Depends(require_roles("approver")),
):
    rev = _decide(db, revision_id, cu)
    if hash_canonical(rev.content) != rev.content_hash:
        # content must be exactly what was submitted for review
        raise conflict("revision content does not match its frozen content_hash")
    ts = now()
    previous = db.scalars(
        select(models.ProcedureRevision).where(
            models.ProcedureRevision.procedure_id == rev.procedure_id,
            models.ProcedureRevision.status == "released",
        )
    )
    for prev in previous:
        prev.status = "obsolete"
        prev.obsoleted_at = ts
        log_change(db, "revision", prev.id)
    db.flush()
    rev.status = "released"
    rev.released_at = ts
    db.add(
        models.Approval(
            id=uuid7(),
            revision_id=rev.id,
            approver_id=cu.id,
            decision="approve",
            comment=(body.comment if body else None) or None,
            content_hash=rev.content_hash,
            signed_at=ts,
        )
    )
    log_change(db, "revision", rev.id)
    db.commit()
    return J(revision_dict(rev))


@router.post("/revisions/{revision_id}/reject", response_model=ProcedureRevision)
def reject_revision(
    revision_id: UuidPath,
    body: DecisionRequest,
    db: Session = Depends(get_db),
    cu: CurrentUser = Depends(require_roles("approver")),
):
    if not (body.comment or "").strip():
        raise unprocessable("a comment is required when rejecting")
    rev = _decide(db, revision_id, cu)
    ts = now()
    db.add(
        models.Approval(
            id=uuid7(),
            revision_id=rev.id,
            approver_id=cu.id,
            decision="reject",
            comment=body.comment,
            content_hash=rev.content_hash or hash_canonical(rev.content),
            signed_at=ts,
        )
    )
    # back to draft: content is editable again, so the frozen hash no longer applies
    rev.status = "draft"
    rev.content_hash = None
    rev.submitted_at = None
    rev.updated_at = ts
    log_change(db, "revision", rev.id)
    db.commit()
    return J(revision_dict(rev))


@router.get("/revisions/{revision_id}/approvals", response_model=list[Approval])
def list_approvals(revision_id: UuidPath, db: Session = Depends(get_db), cu: CurrentUser = Depends(get_current_user)):
    rev = _get_revision(db, revision_id)
    if not visible(rev, cu):
        raise not_found("revision not found")
    rows = db.scalars(
        select(models.Approval).where(models.Approval.revision_id == revision_id).order_by(models.Approval.signed_at)
    )
    return J([approval_dict(a) for a in rows])
