"""Per-run append-only ledger: sequencing, hash chain, derived tables (NCRs, run status, blob refs)."""

from __future__ import annotations

import datetime as dt
import json
import re
from dataclasses import dataclass
from typing import Any

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from . import models
from .canonical import GENESIS_CHAIN_HASH, canonical_json, chain_hash, event_content, sha256_ref
from .db import log_change
from .projection import RunAnalysis, analyze
from .serialize import sort_flags
from .timeutil import iso, now, parse_iso

SHA_REF = re.compile(r"^sha256:([0-9a-f]{64})$")


def lock_run(db: Session, run_id: str) -> models.Run | None:
    """Row lock serialising all appends to one run (gap-free seq, linear chain).

    populate_existing: one push session handles many events, and with expire_on_commit=False an
    identity-mapped Run would otherwise keep a last_seq/last_chain_hash another session has advanced.
    """
    return db.scalar(
        select(models.Run).where(models.Run.id == run_id).with_for_update().execution_options(populate_existing=True)
    )


def stored_event_dicts(db: Session, run_id: str) -> list[dict[str, Any]]:
    rows = db.scalars(select(models.RunEvent).where(models.RunEvent.run_id == run_id).order_by(models.RunEvent.seq))
    out = []
    for r in rows:
        d = json.loads(r.canonical)
        d["seq"] = r.seq
        d["flags"] = list(r.flags or [])
        d["content_hash"] = r.content_hash
        out.append(d)
    return out


def revision_content(db: Session, run: models.Run) -> dict[str, Any]:
    rev = db.get(models.ProcedureRevision, run.revision_id)
    assert rev is not None
    return rev.content


@dataclass
class Appended:
    row: models.RunEvent
    analysis: RunAnalysis


def photo_refs(content: dict[str, Any], event: dict[str, Any]) -> list[str]:
    if event["type"] != "input.recorded":
        return []
    value = event["payload"].get("value")
    if not isinstance(value, list):
        return []
    out = []
    for ref in value:
        m = SHA_REF.match(ref) if isinstance(ref, str) else None
        if m:
            out.append(m.group(1))
    return sorted(set(out))


def next_ncr_number(db: Session, year: int) -> str:
    db.execute(text("INSERT INTO ncr_counters (year, last) VALUES (:y, 0) ON CONFLICT (year) DO NOTHING"), {"y": year})
    counter = db.scalar(
        select(models.NcrCounter)
        .where(models.NcrCounter.year == year)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    assert counter is not None
    while True:
        counter.last += 1
        number = f"NCR-{year}-{counter.last:04d}"
        if db.scalar(select(models.Ncr.id).where(models.Ncr.number == number)) is None:
            return number


def apply_ncr(db: Session, event: dict[str, Any]) -> None:
    p = event["payload"]
    ts = parse_iso(event["client_ts"])
    t = event["type"]
    if t == "ncr.raised":
        number = p.get("number")
        if not number or db.scalar(select(models.Ncr.id).where(models.Ncr.number == number)) is not None:
            number = next_ncr_number(db, ts.year)
        db.add(
            models.Ncr(
                id=p["ncr_id"],
                run_id=event["run_id"],
                step_id=event.get("step_id"),
                input_id=p.get("input_id"),
                number=number,
                description=p["description"],
                status="open",
                raised_by=event["actor_id"],
                raised_at=ts,
            )
        )
        log_change(db, "ncr", p["ncr_id"])
    elif t in ("ncr.dispositioned", "ncr.closed"):
        ncr = db.get(models.Ncr, p["ncr_id"])
        assert ncr is not None
        if t == "ncr.dispositioned":
            ncr.status = "dispositioned"
            ncr.disposition = p["disposition"]
            ncr.disposition_note = p.get("note")
            ncr.dispositioned_by = event["actor_id"]
            ncr.dispositioned_at = ts
        else:
            ncr.status = "closed"
            ncr.closed_by = event["actor_id"]
            ncr.closed_at = ts
        log_change(db, "ncr", ncr.id)


def append(
    db: Session,
    run: models.Run,
    content: dict[str, Any],
    prior: list[dict[str, Any]],
    event: dict[str, Any],
    content_hash: str,
    flags: list[str],
    pushed_by: str,
) -> Appended:
    """Append one validated event. Caller holds the run row lock and commits."""
    server_ts = now()
    seq = run.last_seq + 1
    prev = run.last_chain_hash or GENESIS_CHAIN_HASH
    canonical = canonical_json(event_content(event))
    assert sha256_ref(canonical) == content_hash
    flags = sort_flags(f for f in flags if f != "blob_missing")  # blob_missing is derived, never stored
    row = models.RunEvent(
        id=event["id"],
        run_id=run.id,
        seq=seq,
        canonical=canonical,
        content_hash=content_hash,
        prev_chain_hash=prev,
        chain_hash=chain_hash(prev, content_hash),
        server_ts=server_ts,
        flags=flags,
        type=event["type"],
        step_id=event.get("step_id"),
        actor_id=event["actor_id"],
        auth_method=event["auth_method"],
        device_id=event["device_id"],
        client_ts=parse_iso(event["client_ts"]),
        offline=event["offline"],
        supersedes=event.get("supersedes"),
        pushed_by=pushed_by,
    )
    db.add(row)
    db.flush()
    run.last_seq = seq
    run.last_chain_hash = row.chain_hash

    for sha in photo_refs(content, event):
        db.add(models.EventBlobRef(event_id=row.id, sha256=sha, run_id=run.id))
    apply_ncr(db, event)

    stored = {**event_content(event), "seq": seq, "flags": flags, "content_hash": content_hash}
    analysis = analyze(content, [*prior, stored], run.id)
    if analysis.status != run.status:
        run.status = analysis.status
    if analysis.status in ("completed", "aborted") and run.closed_at is None:
        run.closed_at = server_ts
    log_change(db, "event", row.id)
    log_change(db, "run", run.id)
    return Appended(row, analysis)


def append_server_event(
    db: Session,
    run: models.Run,
    *,
    type_: str,
    step_id: str | None,
    payload: dict[str, Any],
    actor_id: str,
    device_id: str,
    event_id: str,
) -> models.RunEvent:
    """Event originated by the server on behalf of an authenticated user (e.g. lock takeover note)."""
    ts = now()
    event = {
        "id": event_id,
        "run_id": run.id,
        "type": type_,
        "step_id": step_id,
        "payload": payload,
        "actor_id": actor_id,
        "auth_method": "oidc",
        "device_id": device_id,
        "client_ts": iso(ts),
        "offline": False,
        "supersedes": None,
    }
    h = sha256_ref(canonical_json(event))
    content = revision_content(db, run)
    prior = stored_event_dicts(db, run.id)
    return append(db, run, content, prior, event, h, [], actor_id).row


# ---------------------------------------------------------------------------
# Lock / checkout evaluation at client_ts (§6)


@dataclass
class Lease:
    device: str
    start: dt.datetime
    end: dt.datetime


def leases_for(db: Session, run_id: str, step_id: str | None) -> list[Lease]:
    out: list[Lease] = []
    if step_id is not None:
        for lk in db.scalars(
            select(models.StepLock).where(models.StepLock.run_id == run_id, models.StepLock.step_id == step_id)
        ):
            end = min(lk.expires_at, lk.released_at) if lk.released_at else lk.expires_at
            out.append(Lease(lk.holder_device, lk.acquired_at, end))
    for co in db.scalars(select(models.RunCheckout).where(models.RunCheckout.run_id == run_id)):
        end = min(co.expires_at, co.released_at) if co.released_at else co.expires_at
        out.append(Lease(co.holder_device, co.acquired_at, end))
    return out


def lock_flags(leases: list[Lease], device: str, t: dt.datetime, diverged: bool) -> list[str]:
    """
    held at t                                       -> []
    another device held at t                        -> conflict (+ unlocked if this device never held before t)
    own lease ended before t, nobody else since      -> late_lock
    own lease ended before t, someone else since     -> conflict
    never held, nobody else held, results diverge    -> conflict + unlocked
    never held, nobody else held                     -> unlocked
    """
    own = [lease for lease in leases if lease.device == device]
    others = [lease for lease in leases if lease.device != device]
    if any(lease.start <= t <= lease.end for lease in own):
        return []
    held_before = [lease for lease in own if lease.start <= t]
    if any(lease.start <= t <= lease.end for lease in others):
        return ["conflict"] if held_before else ["conflict", "unlocked"]
    if held_before:
        last_end = max(lease.end for lease in held_before)
        if any(lease.start <= t and lease.end >= last_end for lease in others):
            return ["conflict"]
        return ["conflict"] if diverged else ["late_lock"]
    return ["conflict", "unlocked"] if diverged else ["unlocked"]


def diverges(analysis: RunAnalysis, content: dict[str, Any], event: dict[str, Any]) -> bool:
    """Another device's live value for the same input differs from this one (and isn't being corrected)."""
    if event["type"] != "input.recorded":
        return False
    step = analysis.steps.get(event.get("step_id") or "")
    if step is None:
        return False
    inp = step.inputs.get(event["payload"].get("input_id"))
    if inp is None:
        return False
    value = event["payload"].get("value")
    return any(
        e["device_id"] != event["device_id"]
        and e["id"] != event.get("supersedes")
        and e["payload"].get("value") != value
        for e in inp.live_events
    )
