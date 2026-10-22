"""Dev/demo data: `uv run python -m app.seed` (idempotent).

Users for every role (stable ids, PIN 123456), workstations WS-01..WS-03, tools TW-001 (valid) and
TW-002 (calibration expired), and a released demo procedure exercising every input type.
"""

from __future__ import annotations

import datetime as dt
from functools import lru_cache

from sqlalchemy import select
from sqlalchemy.orm import Session

from . import models
from .auth import make_pin_verifier
from .canonical import hash_canonical
from .db import get_sessionmaker, log_change
from .timeutil import now

DEV_PIN = "123456"


def _id(n: int) -> str:
    return f"0192b7a0-0000-7000-8000-{n:012x}"


USERS = [
    (_id(0x101), "Oskar Operator", "operator@example.org", ["operator"]),
    (_id(0x102), "Ines Inspector", "inspector@example.org", ["inspector"]),
    (_id(0x103), "Anna Author", "author@example.org", ["author"]),
    (_id(0x104), "Arne Approver", "approver@example.org", ["approver"]),
    (_id(0x105), "Sven Supervisor", "supervisor@example.org", ["supervisor"]),
    (_id(0x106), "Ada Admin", "admin@example.org", ["admin"]),
    (_id(0x107), "Otto Operator", "operator2@example.org", ["operator"]),
]
OPERATOR, INSPECTOR, AUTHOR, APPROVER, SUPERVISOR, ADMIN, OPERATOR2 = (u[0] for u in USERS)

WORKSTATIONS = [
    ("WS-01", "Kitting & incoming check"),
    ("WS-02", "Bulkhead assembly"),
    ("WS-03", "Harness & final inspection"),
]

TOOL_VALID = _id(0x201)
TOOL_EXPIRED = _id(0x202)

PROCEDURE_ID = _id(0x301)
REVISION_ID = _id(0x302)
APPROVAL_ID = _id(0x303)

S1, S2 = _id(0x401), _id(0x402)
STEP_PARTS, STEP_TORQUE, STEP_HARNESS, STEP_FINAL = _id(0x501), _id(0x502), _id(0x503), _id(0x504)

DEMO_CONTENT = {
    "schema": 1,
    "sections": [
        {
            "id": S1,
            "title": "Prepare bulkhead",
            "steps": [
                {
                    "id": STEP_PARTS,
                    "title": "Incoming check of bracket",
                    "instructions": "Scan the **part label** on the bracket and check it for transport damage.",
                    "media": [],
                    "locations": ["WS-01"],
                    "depends_on": [],
                    "verification": None,
                    "inputs": [
                        {
                            "id": _id(0x601),
                            "type": "scan",
                            "label": "Bracket part label",
                            "required": True,
                            "entity": "part",
                            "expect": "/^PN-[0-9]{4}/",
                        },
                        {"id": _id(0x602), "type": "check", "label": "No transport damage", "required": True},
                    ],
                },
                {
                    "id": STEP_TORQUE,
                    "title": "Torque M6 bolts",
                    "instructions": "Torque all four M6 bolts crosswise.\n\n1. Scan the torque wrench\n"
                    "2. Read the final value from the wrench display\n3. Photograph the torque stripes",
                    "media": [],
                    "locations": ["WS-02"],
                    "depends_on": [STEP_PARTS],
                    "verification": {"required": True, "role": "inspector"},
                    "inputs": [
                        {
                            "id": _id(0x603),
                            "type": "scan",
                            "label": "Torque wrench",
                            "required": True,
                            "entity": "tool",
                            "expect": None,
                        },
                        {
                            "id": _id(0x604),
                            "type": "number",
                            "label": "Final torque",
                            "required": True,
                            "unit": "Nm",
                            "min": "11.5",
                            "nominal": "12.0",
                            "max": "12.5",
                            "decimals": 1,
                            "ocr": True,
                        },
                        {
                            "id": _id(0x605),
                            "type": "photo",
                            "label": "Torque stripes",
                            "required": True,
                            "min_count": 1,
                            "max_count": 3,
                        },
                    ],
                },
            ],
        },
        {
            "id": S2,
            "title": "Harness",
            "steps": [
                {
                    "id": STEP_HARNESS,
                    "title": "Route harness W12",
                    "instructions": "Route harness W12 along the bulkhead per drawing D-1002 sheet 3.",
                    "media": [],
                    "locations": ["WS-03"],
                    "depends_on": [],
                    "verification": None,
                    "inputs": [
                        {"id": _id(0x606), "type": "text", "label": "Remarks", "required": False, "multiline": True},
                        {
                            "id": _id(0x607),
                            "type": "signoff",
                            "label": "Routed per drawing",
                            "required": True,
                            "role": None,
                        },
                    ],
                },
                {
                    "id": STEP_FINAL,
                    "title": "Final inspection",
                    "instructions": "Measure insulation resistance between W12 shield and structure.",
                    "media": [],
                    "locations": ["WS-03"],
                    "depends_on": [STEP_TORQUE, STEP_HARNESS],
                    "verification": None,
                    "inputs": [
                        {
                            "id": _id(0x608),
                            "type": "number",
                            "label": "Insulation resistance",
                            "required": True,
                            "unit": "MΩ",
                            "min": "100",
                            "nominal": None,
                            "max": None,
                            "decimals": 0,
                            "ocr": False,
                        },
                        {
                            "id": _id(0x609),
                            "type": "signoff",
                            "label": "Inspection passed",
                            "required": True,
                            "role": "inspector",
                        },
                    ],
                },
            ],
        },
    ],
}


@lru_cache
def _dev_verifier(uid: str) -> str:
    # PBKDF2 at 210k iterations is deliberately slow; reuse per process (tests reseed every test)
    return make_pin_verifier(DEV_PIN)


def seed(db: Session, *, today: dt.date | None = None) -> None:
    today = today or dt.date.today()
    ts = now()
    for uid, name, email, roles in USERS:
        u = db.get(models.User, uid)
        if u is None:
            u = models.User(id=uid, name=name, email=email, roles=roles, oidc_sub=f"dev-{uid}")
            db.add(u)
        elif (u.name, u.email, sorted(u.roles), u.active, bool(u.pin_verifier)) == (name, email, roles, True, True):
            continue
        u.name, u.email, u.roles, u.active = name, email, roles, True
        if not u.pin_verifier:
            u.pin_verifier = _dev_verifier(uid)
        log_change(db, "user", uid)
    db.flush()

    for code, name in WORKSTATIONS:
        ws = db.get(models.Workstation, code)
        if ws is None:
            db.add(models.Workstation(code=code, name=name))
            log_change(db, "workstation", code)

    for tid, code, desc, due in [
        (TOOL_VALID, "TW-001", "Torque wrench 5–25 Nm", today + dt.timedelta(days=365)),
        (TOOL_EXPIRED, "TW-002", "Torque wrench 5–25 Nm (calibration overdue)", today - dt.timedelta(days=30)),
    ]:
        if db.get(models.Tool, tid) is None and db.scalar(select(models.Tool).where(models.Tool.code == code)) is None:
            db.add(models.Tool(id=tid, code=code, description=desc, calibration_due=due, active=True, updated_at=ts))
            db.flush()
            # history backdated so offline events from before seeding evaluate against the same record
            db.add(
                models.ToolHistory(
                    tool_id=tid, calibration_due=due, active=True, valid_from=dt.datetime(2000, 1, 1, tzinfo=dt.UTC)
                )
            )
            log_change(db, "tool", tid)

    if db.get(models.Procedure, PROCEDURE_ID) is None:
        db.add(
            models.Procedure(
                id=PROCEDURE_ID,
                number="ASM-0001",
                title="Bulkhead bracket installation (demo)",
                created_by=AUTHOR,
                created_at=ts,
            )
        )
        db.flush()
        content_hash = hash_canonical(DEMO_CONTENT)
        db.add(
            models.ProcedureRevision(
                id=REVISION_ID,
                procedure_id=PROCEDURE_ID,
                rev="A",
                seq=1,
                status="released",
                content=DEMO_CONTENT,
                content_hash=content_hash,
                change_reason=None,
                author_id=AUTHOR,
                contributor_ids=[AUTHOR],
                created_at=ts,
                updated_at=ts,
                submitted_at=ts,
                released_at=ts,
            )
        )
        db.flush()
        db.add(
            models.Approval(
                id=APPROVAL_ID,
                revision_id=REVISION_ID,
                approver_id=APPROVER,
                decision="approve",
                comment="Seeded demo release",
                content_hash=content_hash,
                signed_at=ts,
            )
        )
        log_change(db, "procedure", PROCEDURE_ID)
        log_change(db, "revision", REVISION_ID)
    db.commit()


def main() -> None:
    with get_sessionmaker()() as db:
        seed(db)
    print(
        "seeded: users", ", ".join(u[1] for u in USERS), f"(PIN {DEV_PIN}); ASM-0001 rev A; WS-01..03; TW-001, TW-002"
    )


if __name__ == "__main__":
    main()
