"""Tools (calibration registry), workstations, NCRs."""

from __future__ import annotations

import datetime as dt

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import models
from ..auth import CurrentUser, get_current_user, require_roles
from ..db import get_db, log_change
from ..deps import J, UuidPath, conflict, not_found
from ..ids import uuid7
from ..schemas import Ncr, NcrStatus, Tool, ToolUpsert, Workstation, WorkstationUpsert
from ..serialize import ncr_dict, tool_dict, workstation_dict
from ..timeutil import now

router = APIRouter()


@router.get("/tools", response_model=list[Tool], tags=["tools"])
def list_tools(db: Session = Depends(get_db), cu: CurrentUser = Depends(get_current_user)):
    return J([tool_dict(t) for t in db.scalars(select(models.Tool).order_by(models.Tool.code))])


def save_tool(db: Session, body: ToolUpsert, tool: models.Tool | None, actor_id: str | None) -> models.Tool:
    other = db.scalar(select(models.Tool).where(models.Tool.code == body.code))
    if other is not None and (tool is None or other.id != tool.id):
        raise conflict(f"tool code {body.code} already exists")
    due = dt.date.fromisoformat(body.calibration_due) if body.calibration_due else None
    if tool is None:
        tool = models.Tool(id=body.id or uuid7())
        db.add(tool)
    tool.code = body.code
    tool.description = body.description
    tool.calibration_due = due
    tool.active = body.active
    tool.updated_at = now()
    db.flush()
    # history makes calibration status at an event's client_ts reconstructible
    db.add(
        models.ToolHistory(
            tool_id=tool.id, calibration_due=due, active=body.active, valid_from=tool.updated_at, changed_by=actor_id
        )
    )
    log_change(db, "tool", tool.id)
    return tool


@router.post("/tools", response_model=Tool, status_code=status.HTTP_201_CREATED, tags=["tools"])
def create_tool(body: ToolUpsert, db: Session = Depends(get_db), cu: CurrentUser = Depends(require_roles("admin"))):
    if body.id and db.get(models.Tool, body.id):
        raise conflict("tool id already exists")
    tool = save_tool(db, body, None, cu.id)
    db.commit()
    return J(tool_dict(tool), 201)


@router.put("/tools/{tool_id}", response_model=Tool, tags=["tools"])
def update_tool(
    tool_id: UuidPath,
    body: ToolUpsert,
    db: Session = Depends(get_db),
    cu: CurrentUser = Depends(require_roles("admin")),
):
    tool = db.scalar(
        select(models.Tool).where(models.Tool.id == tool_id).with_for_update().execution_options(populate_existing=True)
    )
    if tool is None:
        raise not_found("tool not found")
    save_tool(db, body, tool, cu.id)
    db.commit()
    return J(tool_dict(tool))


@router.get("/workstations", response_model=list[Workstation], tags=["workstations"])
def list_workstations(db: Session = Depends(get_db), cu: CurrentUser = Depends(get_current_user)):
    return J([workstation_dict(w) for w in db.scalars(select(models.Workstation).order_by(models.Workstation.code))])


@router.put("/workstations/{code}", response_model=Workstation, tags=["workstations"])
def upsert_workstation(
    code: str,
    body: WorkstationUpsert,
    db: Session = Depends(get_db),
    cu: CurrentUser = Depends(require_roles("admin")),
):
    if body.code != code:
        raise conflict("code in body must match the URL")
    ws = db.get(models.Workstation, code)
    if ws is None:
        ws = models.Workstation(code=code, name=body.name)
        db.add(ws)
    ws.name = body.name
    log_change(db, "workstation", code)
    db.commit()
    return J(workstation_dict(ws))


@router.get("/ncrs", response_model=list[Ncr], tags=["ncrs"])
def list_ncrs(
    status_: NcrStatus | None = Query(default=None, alias="status"),
    run_id: str | None = Query(default=None, pattern=r"^[0-9a-f-]{36}$"),
    db: Session = Depends(get_db),
    cu: CurrentUser = Depends(get_current_user),
):
    q = select(models.Ncr).order_by(models.Ncr.raised_at.desc())
    if status_:
        q = q.where(models.Ncr.status == status_)
    if run_id:
        q = q.where(models.Ncr.run_id == run_id)
    return J([ncr_dict(n) for n in db.scalars(q)])


@router.get("/ncrs/{ncr_id}", response_model=Ncr, tags=["ncrs"])
def get_ncr(ncr_id: UuidPath, db: Session = Depends(get_db), cu: CurrentUser = Depends(get_current_user)):
    ncr = db.get(models.Ncr, ncr_id)
    if ncr is None:
        raise not_found("NCR not found")
    return J(ncr_dict(ncr))
