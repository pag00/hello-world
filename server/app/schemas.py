"""Pydantic models. Field names and schema names mirror packages/core/src/domain/types.ts 1:1.

Content and event models are strict with extra="forbid": the server stores the client's JSON verbatim
(it is hashed), so validation must not coerce anything — it only accepts or rejects.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

UUID_RE = r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
SHA_REF_RE = r"^sha256:[0-9a-f]{64}$"
DECIMAL_RE = r"^-?[0-9]+(\.[0-9]+)?$"
TS_RE = r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$"

Uuid = Annotated[str, StringConstraints(pattern=UUID_RE)]
Sha256Ref = Annotated[str, StringConstraints(pattern=SHA_REF_RE)]
DecimalString = Annotated[str, StringConstraints(pattern=DECIMAL_RE)]
IsoTs = Annotated[str, StringConstraints(pattern=TS_RE)]
NonEmpty = Annotated[str, StringConstraints(min_length=1)]

Role = Literal["operator", "inspector", "author", "approver", "supervisor", "admin"]
ROLES: tuple[str, ...] = ("operator", "inspector", "author", "approver", "supervisor", "admin")
RevisionStatus = Literal["draft", "in_review", "released", "obsolete"]
RunStatus = Literal["active", "blocked", "completed", "aborted"]
EventType = Literal[
    "run.created",
    "step.started",
    "input.recorded",
    "step.completed",
    "step.verified",
    "step.reopened",
    "note.added",
    "ncr.raised",
    "ncr.dispositioned",
    "ncr.closed",
    "conflict.resolved",
    "run.completed",
    "run.aborted",
]
EventFlag = Literal[
    "conflict", "unlocked", "late_lock", "tool_expired", "tool_unknown", "blob_missing", "out_of_tolerance"
]
AuthMethod = Literal["oidc", "pin"]
NcrStatus = Literal["open", "dispositioned", "closed"]
NcrDisposition = Literal["use_as_is", "rework", "repair", "scrap", "return_to_supplier"]


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class Out(BaseModel):
    model_config = ConfigDict(extra="forbid")


# ---------------------------------------------------------------------------
# Revision content


class _InputBase(Strict):
    id: Uuid
    label: str
    required: bool


class CheckInput(_InputBase):
    type: Literal["check"]


class TextInput(_InputBase):
    type: Literal["text"]
    multiline: bool | None = None


class NumberInput(_InputBase):
    type: Literal["number"]
    unit: str
    min: DecimalString | None = None
    nominal: DecimalString | None = None
    max: DecimalString | None = None
    decimals: Annotated[int, Field(ge=0, le=12)]
    ocr: bool


class PhotoInput(_InputBase):
    type: Literal["photo"]
    min_count: Annotated[int, Field(ge=0, le=100)]
    max_count: Annotated[int, Field(ge=1, le=100)] | None = None


class ScanInput(_InputBase):
    type: Literal["scan"]
    entity: Literal["part", "tool", "any"]
    expect: str | None = Field(
        default=None, description='exact value, or a regex wrapped in slashes: "/^PN-123-\\d+$/"'
    )


class SignoffInput(_InputBase):
    type: Literal["signoff"]
    role: Role | None = None


Input = Annotated[
    CheckInput | TextInput | NumberInput | PhotoInput | ScanInput | SignoffInput,
    Field(discriminator="type"),
]


class Verification(Strict):
    required: bool
    role: Role


class Step(Strict):
    id: Uuid
    title: str
    instructions: str
    media: list[Sha256Ref]
    locations: list[str]
    depends_on: list[Uuid]
    verification: Verification | None = None
    inputs: list[Input]


class Section(Strict):
    id: Uuid
    title: str
    steps: list[Step]


class RevisionContent(Strict):
    schema_: Literal[1] = Field(alias="schema")
    sections: list[Section]

    model_config = ConfigDict(extra="forbid", strict=True, populate_by_name=True)


# ---------------------------------------------------------------------------
# Users & procedures


class User(Out):
    id: Uuid
    name: str
    email: str | None = None
    roles: list[Role]
    pin_verifier: str | None = Field(
        default=None, description='"pbkdf2-sha256$<iter>$<salt_b64>$<hash_b64>" when the user has set an offline PIN'
    )


class Procedure(Out):
    id: Uuid
    number: str
    title: str
    created_at: IsoTs


class ProcedureRevision(Out):
    id: Uuid
    procedure_id: Uuid
    rev: str
    status: RevisionStatus
    content: RevisionContent
    content_hash: Sha256Ref | None
    change_reason: str | None
    author_id: Uuid
    created_at: IsoTs
    submitted_at: IsoTs | None
    released_at: IsoTs | None
    obsoleted_at: IsoTs | None


class Approval(Out):
    id: Uuid
    revision_id: Uuid
    approver_id: Uuid
    decision: Literal["approve", "reject"]
    comment: str | None
    signed_at: IsoTs


class ProcedureDetail(Out):
    procedure: Procedure
    revisions: list[ProcedureRevision]


class CreateProcedureRequest(Strict):
    number: Annotated[str, StringConstraints(min_length=1, max_length=64, strip_whitespace=True)]
    title: Annotated[str, StringConstraints(min_length=1, max_length=500)]
    content: RevisionContent | None = None


class CreateProcedureResponse(Out):
    procedure: Procedure
    revision: ProcedureRevision


class CreateRevisionRequest(Strict):
    change_reason: NonEmpty


class UpdateDraftRequest(Strict):
    content: RevisionContent
    change_reason: str | None = None


class DecisionRequest(Strict):
    comment: str | None = None


# ---------------------------------------------------------------------------
# Runs & events


class RunCreatedPayload(Strict):
    procedure_id: Uuid
    revision_id: Uuid
    serial: NonEmpty
    work_order: str | None


class EmptyPayload(Strict):
    pass


class InputRecordedPayload(Strict):
    input_id: Uuid
    value: Literal[True] | str | list[Sha256Ref]
    source: Literal["manual", "ocr", "scan"]
    ocr_raw: str | None = None


class StepReopenedPayload(Strict):
    reason: NonEmpty


class NoteAddedPayload(Strict):
    text: NonEmpty
    system: Literal["lock_takeover"] | None = None


class NcrRaisedPayload(Strict):
    ncr_id: Uuid
    number: str | None = None
    description: NonEmpty
    input_id: Uuid | None = None


class NcrDispositionedPayload(Strict):
    ncr_id: Uuid
    disposition: NcrDisposition
    note: str


class NcrClosedPayload(Strict):
    ncr_id: Uuid


class ConflictResolvedPayload(Strict):
    kept_event_ids: list[Uuid]
    rejected_event_ids: list[Uuid]
    reason: NonEmpty


class RunAbortedPayload(Strict):
    reason: NonEmpty


PAYLOAD_MODELS: dict[str, type[Strict]] = {
    "run.created": RunCreatedPayload,
    "step.started": EmptyPayload,
    "input.recorded": InputRecordedPayload,
    "step.completed": EmptyPayload,
    "step.verified": EmptyPayload,
    "step.reopened": StepReopenedPayload,
    "note.added": NoteAddedPayload,
    "ncr.raised": NcrRaisedPayload,
    "ncr.dispositioned": NcrDispositionedPayload,
    "ncr.closed": NcrClosedPayload,
    "conflict.resolved": ConflictResolvedPayload,
    "run.completed": EmptyPayload,
    "run.aborted": RunAbortedPayload,
}

EventPayload = (
    RunCreatedPayload
    | InputRecordedPayload
    | StepReopenedPayload
    | NoteAddedPayload
    | NcrRaisedPayload
    | NcrDispositionedPayload
    | NcrClosedPayload
    | ConflictResolvedPayload
    | RunAbortedPayload
    | EmptyPayload
)


class RunEventContent(Strict):
    """Client-set fields, covered by content_hash."""

    id: Uuid
    run_id: Uuid
    type: EventType
    step_id: Uuid | None
    payload: dict[str, Any]
    actor_id: Uuid
    auth_method: AuthMethod
    device_id: Uuid
    client_ts: IsoTs
    offline: bool
    supersedes: Uuid | None


class RunEventIn(RunEventContent):
    """Event as pushed. Server-assigned fields may be echoed back by clients and are ignored."""

    content_hash: Sha256Ref
    seq: Any = None
    prev_chain_hash: Any = None
    chain_hash: Any = None
    server_ts: Any = None
    flags: Any = None


class RunEvent(Out):
    id: Uuid
    run_id: Uuid
    type: EventType
    step_id: Uuid | None
    payload: EventPayload
    actor_id: Uuid
    auth_method: AuthMethod
    device_id: Uuid
    client_ts: IsoTs
    offline: bool
    supersedes: Uuid | None
    content_hash: Sha256Ref
    seq: int | None = None
    prev_chain_hash: Sha256Ref | None = None
    chain_hash: Sha256Ref | None = None
    server_ts: IsoTs | None = None
    flags: list[EventFlag] = Field(default_factory=list)


class Run(Out):
    id: Uuid
    procedure_id: Uuid
    revision_id: Uuid
    serial: str
    work_order: str | None
    status: RunStatus
    created_by: Uuid
    created_at: IsoTs
    closed_at: IsoTs | None


class PushRequest(BaseModel):
    device_id: Uuid
    events: list[RunEventIn] = Field(max_length=500)


class PushResult(Out):
    id: str
    status: Literal["accepted", "duplicate", "rejected"]
    seq: int | None = None
    flags: list[EventFlag] | None = None
    error: str | None = None


class PushResponse(Out):
    results: list[PushResult]


class Ncr(Out):
    id: Uuid
    run_id: Uuid
    step_id: Uuid | None
    input_id: Uuid | None
    number: str | None
    description: str
    status: NcrStatus
    disposition: NcrDisposition | None
    disposition_note: str | None
    raised_by: Uuid
    raised_at: IsoTs
    dispositioned_by: Uuid | None
    dispositioned_at: IsoTs | None
    closed_by: Uuid | None
    closed_at: IsoTs | None


class Tool(Out):
    id: Uuid
    code: str
    description: str
    calibration_due: str | None = Field(description="YYYY-MM-DD; null = no calibration required")
    active: bool


class ToolUpsert(Strict):
    id: Uuid | None = None
    code: Annotated[str, StringConstraints(min_length=1, max_length=64, strip_whitespace=True)]
    description: str = ""
    calibration_due: Annotated[str, StringConstraints(pattern=r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$")] | None = None
    active: bool = True


class Workstation(Out):
    code: str
    name: str


class WorkstationUpsert(Strict):
    code: Annotated[str, StringConstraints(min_length=1, max_length=64, strip_whitespace=True)]
    name: Annotated[str, StringConstraints(min_length=1, max_length=255)]


class PullResponse(Out):
    cursor: str
    has_more: bool
    procedures: list[Procedure]
    revisions: list[ProcedureRevision]
    runs: list[Run]
    events: list[RunEvent]
    tools: list[Tool]
    workstations: list[Workstation]
    ncrs: list[Ncr]
    users: list[User]


class StepLock(Out):
    lock_id: Uuid
    run_id: Uuid
    step_id: Uuid
    holder_user: Uuid
    holder_device: Uuid
    expires_at: IsoTs


class RunCheckout(Out):
    run_id: Uuid
    holder_user: Uuid
    holder_device: Uuid
    expires_at: IsoTs


class RunLocks(Out):
    locks: list[StepLock]
    checkout: RunCheckout | None


class LockRequest(Strict):
    device_id: Uuid
    force: bool = False


class CheckoutRequest(Strict):
    device_id: Uuid
    hours: Annotated[int, Field(ge=1, le=72)] | None = None


class PinRequest(Strict):
    pin: Annotated[str, StringConstraints(pattern=r"^[0-9]{6,12}$")]


class RolesRequest(Strict):
    roles: list[Role]


class UserCreate(Strict):
    id: Uuid | None = None
    name: NonEmpty
    email: str | None = None
    oidc_sub: str | None = None
    roles: list[Role] = Field(default_factory=list)


class BlobMeta(Out):
    sha256: str
    size: int
    mime: str
    created_at: IsoTs


class VerifyResult(Out):
    ok: bool
    event_count: int
    first_bad_seq: int | None = None
    errors: list[str]


class Health(Out):
    status: Literal["ok"]
    database: bool
    version: str


# Schemas referenced from hand-written OpenAPI request bodies (endpoints that parse raw JSON).
EXTRA_OPENAPI_MODELS: list[type[BaseModel]] = [PushRequest, RunEventIn, RevisionContent]
