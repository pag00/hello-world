"""Ledger integrity check: recompute content hashes and the chain from stored canonical content (§5)."""

from __future__ import annotations

import json
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from . import models
from .canonical import GENESIS_CHAIN_HASH, CanonicalJsonError, canonical_json, chain_hash, sha256_ref
from .timeutil import parse_iso

# denormalised columns that must agree with the hashed content
COLUMNS = ("id", "run_id", "type", "step_id", "actor_id", "auth_method", "device_id", "offline", "supersedes")


def verify_run(db: Session, run: models.Run) -> dict[str, Any]:
    rows = list(
        db.scalars(select(models.RunEvent).where(models.RunEvent.run_id == run.id).order_by(models.RunEvent.seq))
    )
    errors: list[str] = []
    first_bad: int | None = None

    def bad(seq: int, msg: str) -> None:
        nonlocal first_bad
        errors.append(f"seq {seq}: {msg}")
        if first_bad is None:
            first_bad = seq

    prev = GENESIS_CHAIN_HASH
    for expected_seq, row in enumerate(rows, start=1):
        seq = row.seq
        if seq != expected_seq:
            bad(seq, f"sequence gap: expected seq {expected_seq}")
        try:
            content = json.loads(row.canonical)
            recanon = canonical_json(content)
        except (ValueError, CanonicalJsonError) as e:
            bad(seq, f"stored content is not valid canonical JSON: {e}")
            content, recanon = None, None
        if recanon is not None:
            if recanon != row.canonical:
                bad(seq, "stored content is not in canonical form")
            if sha256_ref(recanon) != row.content_hash:
                bad(seq, "content_hash does not match content")
        if isinstance(content, dict):
            for col in COLUMNS:
                if str(content.get(col)) != str(getattr(row, col)):
                    bad(seq, f"column {col} differs from hashed content")
            try:
                if parse_iso(content.get("client_ts", "")) != row.client_ts:
                    bad(seq, "column client_ts differs from hashed content")
            except (ValueError, TypeError):
                bad(seq, "client_ts in content is invalid")
        if row.prev_chain_hash != prev:
            bad(seq, "prev_chain_hash does not link to the previous event")
        if row.chain_hash != chain_hash(row.prev_chain_hash, row.content_hash):
            bad(seq, "chain_hash does not match prev_chain_hash + content_hash")
        # continue from the recomputed value so one bad link doesn't hide later independent damage
        prev = chain_hash(prev, row.content_hash)

    if rows:
        if run.last_seq != rows[-1].seq:
            errors.append(f"run.last_seq {run.last_seq} != last event seq {rows[-1].seq}")
        if run.last_chain_hash != rows[-1].chain_hash:
            errors.append("run head chain hash does not match the last event")
            if first_bad is None:
                first_bad = rows[-1].seq
    elif run.last_seq != 0:
        errors.append("run has a non-zero sequence but no events")

    out: dict[str, Any] = {"ok": not errors, "event_count": len(rows), "errors": errors}
    if first_bad is not None:
        out["first_bad_seq"] = first_bad
    return out
