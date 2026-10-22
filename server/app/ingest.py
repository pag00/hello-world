"""POST /sync/push event ingest (ARCHITECTURE §4–§7).

Each event is validated and appended in its own transaction so one bad event never fails the batch.
Rejections are structural/business-rule failures only; lock problems never reject evidence, they flag it.
"""

from __future__ import annotations

import datetime as dt
import json
import re
from typing import Any

from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from . import models
from .auth import CurrentUser
from .canonical import GENESIS_CHAIN_HASH, CanonicalJsonError, event_content_hash, validate
from .config import get_settings
from .db import log_change
from .ids import uuid7
from .ledger import (
    append,
    diverges,
    leases_for,
    lock_flags,
    lock_run,
    photo_refs,
    revision_content,
    stored_event_dicts,
)
from .projection import SUPERVISOR_TYPES, RunAnalysis, analyze, find_input, find_step, is_out_of_tolerance
from .schemas import PAYLOAD_MODELS, RunEventIn
from .serialize import missing_blob_events, sort_flags
from .timeutil import parse_iso

OPERATE_ROLES = ("operator", "inspector", "supervisor")
# Step results that are evaluated against step locks / run checkout. Notes, NCRs, supervisory actions
# and run-level events are reports about the work, not results that can diverge, so a supervisor or
# inspector adding one from their own device must not throw the step into conflict.
LOCK_BOUND_TYPES = frozenset({"step.started", "input.recorded", "step.completed", "step.verified"})
STEP_REQUIRED = frozenset(
    {"step.started", "input.recorded", "step.completed", "step.verified", "step.reopened", "conflict.resolved"}
)
STEP_FORBIDDEN = frozenset({"run.created", "run.completed", "run.aborted"})
DECIMAL = re.compile(r"^-?[0-9]+(\.[0-9]+)?$")
TOOL_QR = (re.compile(r"^st:tool:(.+)$"), re.compile(r"/q/tool/([^/?#]+)"))


class Rejected(Exception):
    pass


def _fmt_validation(e: ValidationError, prefix: str = "") -> str:
    parts = []
    for err in e.errors()[:5]:
        loc = ".".join(str(x) for x in err["loc"])
        parts.append(f"{prefix}{loc}: {err['msg']}")
    return "schema invalid: " + "; ".join(parts)


def structural_check(raw: Any, device_id: str) -> tuple[dict[str, Any], str]:
    """Schema, floats, hash. Returns (event, content_hash)."""
    if not isinstance(raw, dict):
        raise Rejected("schema invalid: event must be an object")
    try:
        validate(raw)
    except CanonicalJsonError as e:
        raise Rejected(str(e)) from e
    try:
        RunEventIn.model_validate(raw)
    except ValidationError as e:
        raise Rejected(_fmt_validation(e)) from e
    t = raw["type"]
    try:
        PAYLOAD_MODELS[t].model_validate(raw["payload"])
    except ValidationError as e:
        raise Rejected(_fmt_validation(e, "payload.")) from e
    try:
        parse_iso(raw["client_ts"])
    except ValueError as e:
        raise Rejected("schema invalid: client_ts is not a valid timestamp") from e
    if t in STEP_REQUIRED and raw["step_id"] is None:
        raise Rejected(f"schema invalid: {t} requires step_id")
    if t in STEP_FORBIDDEN and raw["step_id"] is not None:
        raise Rejected(f"schema invalid: {t} must not have step_id")
    if t == "note.added" and raw["payload"].get("system") is not None:
        raise Rejected("system notes are created by the server only")
    if raw["supersedes"] is not None and raw["supersedes"] == raw["id"]:
        raise Rejected("event cannot supersede itself")
    computed = event_content_hash(raw)
    if computed != raw["content_hash"]:
        raise Rejected(f"content_hash mismatch: computed {computed}")
    if raw["device_id"] != device_id:
        raise Rejected("device_id of event does not match pushing device")
    return raw, computed


def _duplicate_result(db: Session, existing: models.RunEvent, content_hash: str) -> dict[str, Any]:
    if existing.content_hash != content_hash:
        return {"id": existing.id, "status": "rejected", "error": "event id already exists with different content_hash"}
    flags = list(existing.flags or [])
    if missing_blob_events(db, [existing.id]):
        flags.append("blob_missing")
    return {"id": existing.id, "status": "duplicate", "seq": existing.seq, "flags": sort_flags(flags)}


def _actor_roles(db: Session, cu: CurrentUser, event: dict[str, Any]) -> set[str]:
    actor = db.get(models.User, event["actor_id"])
    if actor is None or not actor.active:
        raise Rejected("unknown actor")
    if event["auth_method"] == "oidc":
        if actor.id != cu.id:
            raise Rejected("auth_method oidc: actor must be the authenticated user")
        return set(cu.roles)
    # PIN countersign on a shared tablet: actor is another user who proved presence with a PIN
    if not actor.pin_verifier:
        raise Rejected("auth_method pin: actor has no PIN set")
    return set(actor.roles)


def _require(roles: set[str], allowed: tuple[str, ...], what: str) -> None:
    if not roles.intersection(allowed):
        raise Rejected(f"actor lacks role for {what}: requires {' or '.join(allowed)}")


def _check_role(event: dict[str, Any], roles: set[str], content: dict[str, Any] | None) -> None:
    t = event["type"]
    if t in SUPERVISOR_TYPES:
        _require(roles, ("supervisor",), t)
    elif t == "run.completed":
        _require(roles, ("inspector", "supervisor"), t)
    elif t == "step.verified":
        step = find_step(content or {}, event["step_id"])
        role = ((step or {}).get("verification") or {}).get("role")
        _require(roles, (role,) if role else ("inspector", "supervisor"), t)
    else:
        _require(roles, OPERATE_ROLES, t)


def _scan_matches(expect: str, value: str) -> bool:
    if len(expect) >= 2 and expect.startswith("/"):
        end = expect.rfind("/")
        if end > 0:
            pattern, flags = expect[1:end], expect[end + 1 :]
            try:
                return re.search(pattern, value, re.IGNORECASE if "i" in flags else 0) is not None
            except re.error:
                return False
    return value == expect


def _check_input(event: dict[str, Any], step: dict[str, Any], roles: set[str]) -> dict[str, Any]:
    p = event["payload"]
    inp = find_input(step, p["input_id"])
    if inp is None:
        raise Rejected("unknown input for step")
    value = p["value"]
    t = inp["type"]
    if t in ("check", "signoff"):
        if value is not True:
            raise Rejected(f"{t} input value must be true")
        if t == "signoff" and inp.get("role") and inp["role"] not in roles:
            raise Rejected(f"signoff requires role {inp['role']}")
    elif t == "text":
        if not isinstance(value, str):
            raise Rejected("text input value must be a string")
    elif t == "number":
        if not isinstance(value, str) or not DECIMAL.match(value):
            raise Rejected("number input value must be a decimal string")
    elif t == "photo":
        if not isinstance(value, list):
            raise Rejected("photo input value must be a list of sha256 refs")
        if inp.get("max_count") is not None and len(value) > inp["max_count"]:
            raise Rejected(f"photo input allows at most {inp['max_count']} photos")
    elif t == "scan":
        if not isinstance(value, str) or not value.strip():
            raise Rejected("scan input value must be a non-empty string")
        if inp.get("expect") and not _scan_matches(inp["expect"], value):
            raise Rejected("scanned value does not match expected value")
    return inp


def _has_value(inp_def: dict[str, Any], value: Any) -> bool:
    if value is None:
        return False
    t = inp_def["type"]
    if t == "photo":
        return isinstance(value, list) and len(value) >= max(inp_def.get("min_count") or 0, 1)
    if t in ("text", "scan", "number"):
        return isinstance(value, str) and value.strip() != ""
    return value is True


def _check_step_completed(analysis: RunAnalysis, step_id: str) -> None:
    st = analysis.steps[step_id]
    missing = [
        inp.definition.get("label") or iid
        for iid, inp in st.inputs.items()
        if inp.definition.get("required") and not _has_value(inp.definition, inp.value)
    ]
    if missing:
        raise Rejected("required inputs missing: " + ", ".join(missing))
    blocking = [r for r in st.block_reasons if r != "depends_on"]
    if blocking:
        raise Rejected("step is blocked: " + ", ".join(blocking))


def _check_supersedes(db: Session, event: dict[str, Any]) -> None:
    target_id = event.get("supersedes")
    if target_id is None:
        return
    target = db.get(models.RunEvent, target_id)
    if target is None or target.run_id != event["run_id"]:
        raise Rejected("supersedes references an unknown event of this run")
    if target.type == "run.created":
        raise Rejected("run.created cannot be superseded")
    if target.step_id != event.get("step_id"):
        raise Rejected("supersedes must reference an event of the same step")
    if (
        event["type"] == "input.recorded"
        and target.type == "input.recorded"
        and json.loads(target.canonical)["payload"].get("input_id") != event["payload"]["input_id"]
    ):
        raise Rejected("correction must reference the same input")


def _tool_code(value: str) -> str:
    v = value.strip()
    for rx in TOOL_QR:
        m = rx.search(v)
        if m:
            return m.group(1)
    return v


def tool_check(db: Session, code: str, at: dt.datetime) -> tuple[str, models.Tool | None, dt.date | None]:
    """Calibration status of tool `code` as effective at `at`: ok | expired | inactive | unknown."""
    tool = db.scalar(select(models.Tool).where(models.Tool.code == code))
    if tool is None:
        return "unknown", None, None
    hist = db.scalar(
        select(models.ToolHistory)
        .where(models.ToolHistory.tool_id == tool.id, models.ToolHistory.valid_from <= at)
        .order_by(models.ToolHistory.valid_from.desc(), models.ToolHistory.id.desc())
        .limit(1)
    ) or db.scalar(
        select(models.ToolHistory)
        .where(models.ToolHistory.tool_id == tool.id)
        .order_by(models.ToolHistory.valid_from, models.ToolHistory.id)
        .limit(1)
    )
    due, active = (hist.calibration_due, hist.active) if hist else (tool.calibration_due, tool.active)
    if not active:
        return "inactive", tool, due
    # calibration is valid through the due date (inclusive)
    if due is not None and at.astimezone(dt.UTC).date() > due:
        return "expired", tool, due
    return "ok", tool, due


def _run_created(db: Session, event: dict[str, Any], content_hash: str, cu: CurrentUser) -> dict[str, Any]:
    p = event["payload"]
    if event.get("supersedes") is not None:
        raise Rejected("run.created cannot supersede")
    roles = _actor_roles(db, cu, event)
    _check_role(event, roles, None)
    rev = db.get(models.ProcedureRevision, p["revision_id"])
    if rev is None or rev.procedure_id != p["procedure_id"]:
        raise Rejected("unknown procedure revision")
    ts = parse_iso(event["client_ts"])
    # a tablet offline may start a run on a revision that was obsoleted while it was disconnected
    obsoleted_meanwhile = rev.status == "obsolete" and event["offline"] and rev.obsoleted_at and rev.obsoleted_at > ts
    if rev.status != "released" and not obsoleted_meanwhile:
        raise Rejected(f"revision is {rev.status}; runs can only be started on a released revision")
    run = models.Run(
        id=event["run_id"],
        procedure_id=p["procedure_id"],
        revision_id=rev.id,
        serial=p["serial"],
        work_order=p.get("work_order"),
        status="active",
        created_by=event["actor_id"],
        created_at=ts,
        last_seq=0,
        last_chain_hash=GENESIS_CHAIN_HASH,
    )
    db.add(run)
    db.flush()
    appended = append(db, run, rev.content, [], event, content_hash, [], cu.id)
    if event["offline"]:
        s = get_settings()
        db.add(
            models.RunCheckout(
                id=uuid7(),
                run_id=run.id,
                holder_user=event["actor_id"],
                holder_device=event["device_id"],
                acquired_at=ts,
                expires_at=ts + dt.timedelta(hours=s.checkout_default_hours),
                source="offline_run_created",
            )
        )
    return {"id": event["id"], "status": "accepted", "seq": appended.row.seq, "flags": []}


def _run_event(db: Session, event: dict[str, Any], content_hash: str, cu: CurrentUser) -> dict[str, Any]:
    run = lock_run(db, event["run_id"])
    if run is None:
        raise Rejected("unknown run")
    # re-check under the run lock: a concurrent push of the same event may have just committed
    existing = db.get(models.RunEvent, event["id"])
    if existing is not None:
        return _duplicate_result(db, existing, content_hash)
    if run.status in ("completed", "aborted"):
        raise Rejected(f"run is {run.status}")

    content = revision_content(db, run)
    t = event["type"]
    step = None
    if event.get("step_id") is not None:
        step = find_step(content, event["step_id"])
        if step is None:
            raise Rejected("unknown step for this revision")

    roles = _actor_roles(db, cu, event)
    _check_role(event, roles, content)
    _check_supersedes(db, event)

    prior = stored_event_dicts(db, run.id)
    analysis = analyze(content, prior, run.id)
    p = event["payload"]
    flags: list[str] = []
    tool_snapshot: tuple[str, str, models.Tool | None, dt.date | None] | None = None
    ts = parse_iso(event["client_ts"])

    if t == "input.recorded":
        assert step is not None
        inp = _check_input(event, step, roles)
        if is_out_of_tolerance(inp, p["value"]):
            flags.append("out_of_tolerance")
        if inp["type"] == "scan" and inp.get("entity") == "tool":
            code = _tool_code(p["value"])
            status, tool, due = tool_check(db, code, ts)
            tool_snapshot = (code, status, tool, due)
            if status in ("expired", "inactive"):
                flags.append("tool_expired")
            elif status == "unknown":
                flags.append("tool_unknown")
    elif t == "step.completed":
        _check_step_completed(analysis, event["step_id"])
    elif t == "step.verified":
        st = analysis.steps[event["step_id"]]
        if not st.completed:
            raise Rejected("step is not completed")
        if st.completion and st.completion["actor_id"] == event["actor_id"]:
            raise Rejected("verifier must not be the person who completed the step")
    elif t == "ncr.raised":
        if db.get(models.Ncr, p["ncr_id"]) is not None:
            raise Rejected("ncr_id already exists")
        if p.get("input_id") is not None and find_input(step, p["input_id"]) is None:
            raise Rejected("ncr input_id is not an input of the step")
    elif t in ("ncr.dispositioned", "ncr.closed"):
        ncr = analysis.ncrs.get(p["ncr_id"])
        if ncr is None:
            raise Rejected("unknown NCR for this run")
        if ncr.status == "closed":
            raise Rejected("NCR is closed")
        if t == "ncr.closed" and ncr.status != "dispositioned":
            raise Rejected("NCR must be dispositioned before it can be closed")
    elif t == "conflict.resolved":
        ids = set(p["kept_event_ids"]) | set(p["rejected_event_ids"])
        if set(p["kept_event_ids"]) & set(p["rejected_event_ids"]):
            raise Rejected("an event cannot be both kept and rejected")
        by_id = {e["id"]: e for e in prior}
        for eid in ids:
            if eid not in by_id or by_id[eid].get("step_id") != event["step_id"]:
                raise Rejected(f"conflict.resolved references unknown event {eid} for this step")
    elif t == "run.completed":
        if not analysis.can_complete:
            raise Rejected("run cannot be completed: steps incomplete, verification missing, open NCR or conflict")
        live_refs = {sha for e in analysis.ordered if analysis.is_live(e["id"]) for sha in photo_refs(content, e)}
        if live_refs:
            present = set(db.scalars(select(models.Blob.sha256).where(models.Blob.sha256.in_(live_refs))))
            if live_refs - present:
                raise Rejected("referenced photos not uploaded yet: " + ", ".join(sorted(live_refs - present)))

    if t in LOCK_BOUND_TYPES and event.get("step_id") is not None:
        flags += lock_flags(
            leases_for(db, run.id, event["step_id"]), event["device_id"], ts, diverges(analysis, content, event)
        )

    appended = append(db, run, content, prior, event, content_hash, flags, cu.id)
    if tool_snapshot:
        code, status, tool, due = tool_snapshot
        db.add(
            models.EventToolCheck(
                event_id=event["id"],
                run_id=run.id,
                code=code,
                tool_id=tool.id if tool else None,
                status=status,
                calibration_due=due,
                checked_for=ts.date(),
            )
        )
    return {"id": event["id"], "status": "accepted", "seq": appended.row.seq, "flags": list(appended.row.flags)}


def ingest_one(db: Session, raw: Any, cu: CurrentUser, device_id: str) -> dict[str, Any]:
    eid = raw.get("id") if isinstance(raw, dict) and isinstance(raw.get("id"), str) else ""
    try:
        event, content_hash = structural_check(raw, device_id)
    except Rejected as e:
        return {"id": eid, "status": "rejected", "error": str(e)}

    for attempt in range(2):
        try:
            existing = db.get(models.RunEvent, event["id"])
            if existing is not None:
                result = _duplicate_result(db, existing, content_hash)
                db.rollback()
                return result
            if event["type"] == "run.created":
                if db.get(models.Run, event["run_id"]) is not None:
                    raise Rejected("run already exists")
                result = _run_created(db, event, content_hash, cu)
            else:
                result = _run_event(db, event, content_hash, cu)
            if result["status"] == "accepted":
                missing = missing_blob_events(db, [event["id"]])
                db.commit()
                if missing:
                    result["flags"] = sort_flags([*result["flags"], "blob_missing"])
            else:
                db.rollback()
            return result
        except Rejected as e:
            db.rollback()
            return {"id": eid, "status": "rejected", "error": str(e)}
        except IntegrityError:
            # lost a race (same run.created / event id committed concurrently): retry once, which
            # turns into duplicate / rejected through the normal checks
            db.rollback()
            if attempt == 1:
                return {"id": eid, "status": "rejected", "error": "concurrent write conflict, retry"}
    raise AssertionError("unreachable")


def ingest_batch(db: Session, events: list[Any], cu: CurrentUser, device_id: str) -> list[dict[str, Any]]:
    # run.created first so a batch holding a new run and its first events works in any order;
    # otherwise keep the client's order (outbox order).
    order = sorted(
        range(len(events)),
        key=lambda i: 0 if isinstance(events[i], dict) and events[i].get("type") == "run.created" else 1,
    )
    results: list[dict[str, Any] | None] = [None] * len(events)
    for i in order:
        results[i] = ingest_one(db, events[i], cu, device_id)
    return [r for r in results if r is not None]


def log_blob_arrival(db: Session, sha256_hex: str) -> None:
    """A newly uploaded blob clears derived blob_missing: re-deliver referencing events via pull."""
    for eid, run_id in db.execute(
        select(models.EventBlobRef.event_id, models.EventBlobRef.run_id).where(models.EventBlobRef.sha256 == sha256_hex)
    ):
        log_change(db, "event", eid)
        log_change(db, "run", run_id)
