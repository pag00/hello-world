from __future__ import annotations

import datetime as dt
from typing import Any

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    Uuid,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

UUID = Uuid(as_uuid=False)
TS = DateTime(timezone=True)


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"
    id: Mapped[str] = mapped_column(UUID, primary_key=True)
    oidc_sub: Mapped[str | None] = mapped_column(String(255), unique=True)
    name: Mapped[str] = mapped_column(String(255))
    email: Mapped[str | None] = mapped_column(String(255))
    roles: Mapped[list[str]] = mapped_column(ARRAY(Text), default=list, server_default="{}")
    pin_verifier: Mapped[str | None] = mapped_column(Text)
    active: Mapped[bool] = mapped_column(Boolean, default=True, server_default=text("true"))
    created_at: Mapped[dt.datetime] = mapped_column(TS, server_default=func.now())


class Procedure(Base):
    __tablename__ = "procedures"
    id: Mapped[str] = mapped_column(UUID, primary_key=True)
    number: Mapped[str] = mapped_column(String(64), unique=True)
    title: Mapped[str] = mapped_column(String(500))
    created_by: Mapped[str] = mapped_column(UUID, ForeignKey("users.id"))
    created_at: Mapped[dt.datetime] = mapped_column(TS, server_default=func.now())


class ProcedureRevision(Base):
    __tablename__ = "procedure_revisions"
    __table_args__ = (
        UniqueConstraint("procedure_id", "rev"),
        CheckConstraint("status IN ('draft','in_review','released','obsolete')", name="ck_revision_status"),
        # at most one released revision per procedure
        Index(
            "uq_one_released_per_procedure",
            "procedure_id",
            unique=True,
            postgresql_where=text("status = 'released'"),
        ),
    )
    id: Mapped[str] = mapped_column(UUID, primary_key=True)
    procedure_id: Mapped[str] = mapped_column(UUID, ForeignKey("procedures.id"), index=True)
    rev: Mapped[str] = mapped_column(String(8))
    seq: Mapped[int] = mapped_column(Integer)  # 1-based ordinal; rev letter derived from it
    status: Mapped[str] = mapped_column(String(16))
    content: Mapped[dict[str, Any]] = mapped_column(JSONB)
    content_hash: Mapped[str | None] = mapped_column(String(80))
    change_reason: Mapped[str | None] = mapped_column(Text)
    author_id: Mapped[str] = mapped_column(UUID, ForeignKey("users.id"))
    # everyone who edited the draft; none of them may approve it
    contributor_ids: Mapped[list[str]] = mapped_column(ARRAY(Text), default=list, server_default="{}")
    created_at: Mapped[dt.datetime] = mapped_column(TS, server_default=func.now())
    updated_at: Mapped[dt.datetime] = mapped_column(TS, server_default=func.now())
    submitted_at: Mapped[dt.datetime | None] = mapped_column(TS)
    released_at: Mapped[dt.datetime | None] = mapped_column(TS)
    obsoleted_at: Mapped[dt.datetime | None] = mapped_column(TS)


class Approval(Base):
    __tablename__ = "approvals"
    __table_args__ = (CheckConstraint("decision IN ('approve','reject')", name="ck_approval_decision"),)
    id: Mapped[str] = mapped_column(UUID, primary_key=True)
    revision_id: Mapped[str] = mapped_column(UUID, ForeignKey("procedure_revisions.id"), index=True)
    approver_id: Mapped[str] = mapped_column(UUID, ForeignKey("users.id"))
    decision: Mapped[str] = mapped_column(String(16))
    comment: Mapped[str | None] = mapped_column(Text)
    # the exact content the decision applies to
    content_hash: Mapped[str] = mapped_column(String(80))
    signed_at: Mapped[dt.datetime] = mapped_column(TS, server_default=func.now())


class Run(Base):
    __tablename__ = "runs"
    __table_args__ = (CheckConstraint("status IN ('active','blocked','completed','aborted')", name="ck_run_status"),)
    id: Mapped[str] = mapped_column(UUID, primary_key=True)
    procedure_id: Mapped[str] = mapped_column(UUID, ForeignKey("procedures.id"), index=True)
    revision_id: Mapped[str] = mapped_column(UUID, ForeignKey("procedure_revisions.id"))
    serial: Mapped[str] = mapped_column(String(255), index=True)
    work_order: Mapped[str | None] = mapped_column(String(255))
    status: Mapped[str] = mapped_column(String(16))
    created_by: Mapped[str] = mapped_column(UUID, ForeignKey("users.id"))
    created_at: Mapped[dt.datetime] = mapped_column(TS)
    closed_at: Mapped[dt.datetime | None] = mapped_column(TS)
    last_seq: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    last_chain_hash: Mapped[str] = mapped_column(String(80))


class RunEvent(Base):
    __tablename__ = "run_events"
    __table_args__ = (UniqueConstraint("run_id", "seq"),)
    id: Mapped[str] = mapped_column(UUID, primary_key=True)
    run_id: Mapped[str] = mapped_column(UUID, ForeignKey("runs.id"), index=True)
    seq: Mapped[int] = mapped_column(Integer)
    # Exact canonical JSON of the client content (what content_hash covers). Source of truth;
    # the columns below are denormalised copies for querying and are cross-checked by /verify.
    canonical: Mapped[str] = mapped_column(Text)
    content_hash: Mapped[str] = mapped_column(String(80))
    prev_chain_hash: Mapped[str] = mapped_column(String(80))
    chain_hash: Mapped[str] = mapped_column(String(80))
    server_ts: Mapped[dt.datetime] = mapped_column(TS)
    flags: Mapped[list[str]] = mapped_column(ARRAY(Text), default=list, server_default="{}")
    type: Mapped[str] = mapped_column(String(32))
    step_id: Mapped[str | None] = mapped_column(UUID)
    actor_id: Mapped[str] = mapped_column(UUID, ForeignKey("users.id"))
    auth_method: Mapped[str] = mapped_column(String(8))
    device_id: Mapped[str] = mapped_column(UUID)
    client_ts: Mapped[dt.datetime] = mapped_column(TS)
    offline: Mapped[bool] = mapped_column(Boolean)
    supersedes: Mapped[str | None] = mapped_column(UUID)
    # authenticated user whose session pushed the event (differs from actor for PIN countersign)
    pushed_by: Mapped[str] = mapped_column(UUID, ForeignKey("users.id"))


class EventBlobRef(Base):
    """Photo blobs referenced by input.recorded events; drives the derived blob_missing flag."""

    __tablename__ = "event_blob_refs"
    event_id: Mapped[str] = mapped_column(UUID, ForeignKey("run_events.id"), primary_key=True)
    sha256: Mapped[str] = mapped_column(String(64), primary_key=True, index=True)
    run_id: Mapped[str] = mapped_column(UUID, index=True)


class EventToolCheck(Base):
    """Calibration status of a scanned tool as evaluated at ingest for the event's client_ts."""

    __tablename__ = "event_tool_checks"
    event_id: Mapped[str] = mapped_column(UUID, ForeignKey("run_events.id"), primary_key=True)
    run_id: Mapped[str] = mapped_column(UUID, index=True)
    code: Mapped[str] = mapped_column(String(255))
    tool_id: Mapped[str | None] = mapped_column(UUID)
    status: Mapped[str] = mapped_column(String(16))  # ok | expired | inactive | unknown
    calibration_due: Mapped[dt.date | None] = mapped_column(Date)
    checked_for: Mapped[dt.date] = mapped_column(Date)


class Ncr(Base):
    __tablename__ = "ncrs"
    __table_args__ = (CheckConstraint("status IN ('open','dispositioned','closed')", name="ck_ncr_status"),)
    id: Mapped[str] = mapped_column(UUID, primary_key=True)
    run_id: Mapped[str] = mapped_column(UUID, ForeignKey("runs.id"), index=True)
    step_id: Mapped[str | None] = mapped_column(UUID)
    input_id: Mapped[str | None] = mapped_column(UUID)
    number: Mapped[str] = mapped_column(String(64), unique=True)
    description: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(16))
    disposition: Mapped[str | None] = mapped_column(String(32))
    disposition_note: Mapped[str | None] = mapped_column(Text)
    raised_by: Mapped[str] = mapped_column(UUID, ForeignKey("users.id"))
    raised_at: Mapped[dt.datetime] = mapped_column(TS)
    dispositioned_by: Mapped[str | None] = mapped_column(UUID, ForeignKey("users.id"))
    dispositioned_at: Mapped[dt.datetime | None] = mapped_column(TS)
    closed_by: Mapped[str | None] = mapped_column(UUID, ForeignKey("users.id"))
    closed_at: Mapped[dt.datetime | None] = mapped_column(TS)


class NcrCounter(Base):
    __tablename__ = "ncr_counters"
    year: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=False)
    last: Mapped[int] = mapped_column(Integer)


class Tool(Base):
    __tablename__ = "tools"
    id: Mapped[str] = mapped_column(UUID, primary_key=True)
    code: Mapped[str] = mapped_column(String(64), unique=True)
    description: Mapped[str] = mapped_column(Text, default="")
    calibration_due: Mapped[dt.date | None] = mapped_column(Date)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    updated_at: Mapped[dt.datetime] = mapped_column(TS, server_default=func.now())


class ToolHistory(Base):
    """Every state a tool record has had. Offline events are checked against the calibration that
    was effective at their client_ts, not the one current at ingest (a tool recalibrated between
    use and sync must still be flagged)."""

    __tablename__ = "tool_history"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    tool_id: Mapped[str] = mapped_column(UUID, ForeignKey("tools.id"), index=True)
    calibration_due: Mapped[dt.date | None] = mapped_column(Date)
    active: Mapped[bool] = mapped_column(Boolean)
    valid_from: Mapped[dt.datetime] = mapped_column(TS)
    changed_by: Mapped[str | None] = mapped_column(UUID, ForeignKey("users.id"))


class Workstation(Base):
    __tablename__ = "workstations"
    code: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(255))


class Blob(Base):
    __tablename__ = "blobs"
    sha256: Mapped[str] = mapped_column(String(64), primary_key=True)
    size: Mapped[int] = mapped_column(BigInteger)
    mime: Mapped[str] = mapped_column(String(255))
    uploaded_by: Mapped[str | None] = mapped_column(UUID, ForeignKey("users.id"))
    created_at: Mapped[dt.datetime] = mapped_column(TS, server_default=func.now())


class StepLock(Base):
    __tablename__ = "step_locks"
    __table_args__ = (Index("ix_step_locks_run_step", "run_id", "step_id"),)
    id: Mapped[str] = mapped_column(UUID, primary_key=True)
    run_id: Mapped[str] = mapped_column(UUID, ForeignKey("runs.id"))
    step_id: Mapped[str] = mapped_column(UUID)
    holder_user: Mapped[str] = mapped_column(UUID, ForeignKey("users.id"))
    holder_device: Mapped[str] = mapped_column(UUID)
    acquired_at: Mapped[dt.datetime] = mapped_column(TS)
    expires_at: Mapped[dt.datetime] = mapped_column(TS)
    released_at: Mapped[dt.datetime | None] = mapped_column(TS)
    released_reason: Mapped[str | None] = mapped_column(String(32))  # released | takeover
    released_by: Mapped[str | None] = mapped_column(UUID, ForeignKey("users.id"))


class RunCheckout(Base):
    __tablename__ = "run_checkouts"
    id: Mapped[str] = mapped_column(UUID, primary_key=True)
    run_id: Mapped[str] = mapped_column(UUID, ForeignKey("runs.id"), index=True)
    holder_user: Mapped[str] = mapped_column(UUID, ForeignKey("users.id"))
    holder_device: Mapped[str] = mapped_column(UUID)
    acquired_at: Mapped[dt.datetime] = mapped_column(TS)
    expires_at: Mapped[dt.datetime] = mapped_column(TS)
    released_at: Mapped[dt.datetime | None] = mapped_column(TS)
    released_reason: Mapped[str | None] = mapped_column(String(32))
    released_by: Mapped[str | None] = mapped_column(UUID, ForeignKey("users.id"))
    source: Mapped[str] = mapped_column(String(32))  # request | offline_run_created


class ChangeLog(Base):
    __tablename__ = "change_log"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    entity: Mapped[str] = mapped_column(String(32))
    entity_id: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[dt.datetime] = mapped_column(TS, server_default=func.now())
