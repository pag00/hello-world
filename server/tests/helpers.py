from __future__ import annotations

import datetime as dt
import itertools
import json
from typing import Any

from app.canonical import event_content_hash
from app.ids import uuid7
from app.seed import (
    ADMIN,
    APPROVER,
    AUTHOR,
    INSPECTOR,
    OPERATOR,
    OPERATOR2,
    PROCEDURE_ID,
    REVISION_ID,
    STEP_FINAL,
    STEP_HARNESS,
    STEP_PARTS,
    STEP_TORQUE,
    SUPERVISOR,
    _id,
)
from app.timeutil import iso

__all__ = [
    "ADMIN",
    "APPROVER",
    "AUTHOR",
    "INSPECTOR",
    "OPERATOR",
    "OPERATOR2",
    "PROCEDURE_ID",
    "REVISION_ID",
    "STEP_FINAL",
    "STEP_HARNESS",
    "STEP_PARTS",
    "STEP_TORQUE",
    "SUPERVISOR",
]

DEV1 = "0192b7a0-0000-7000-8000-00000000d001"
DEV2 = "0192b7a0-0000-7000-8000-00000000d002"

# demo procedure inputs (see app.seed.DEMO_CONTENT)
IN_PART_SCAN, IN_NO_DAMAGE = _id(0x601), _id(0x602)
IN_TOOL, IN_TORQUE, IN_PHOTO = _id(0x603), _id(0x604), _id(0x605)
IN_REMARKS, IN_ROUTED = _id(0x606), _id(0x607)
IN_INSULATION, IN_FINAL_SIGN = _id(0x608), _id(0x609)

_clock = itertools.count()


def ts(offset_s: float = 0) -> str:
    """Client timestamp near now (inside lock leases taken during the test), strictly increasing."""
    return iso(dt.datetime.now(dt.UTC) + dt.timedelta(seconds=offset_s, milliseconds=next(_clock) % 1000))


def H(user: str) -> dict[str, str]:
    return {"Authorization": f"Dev {user}"}


def ev(
    type_: str,
    run_id: str,
    step_id: str | None = None,
    payload: dict[str, Any] | None = None,
    *,
    actor: str = OPERATOR,
    auth: str = "oidc",
    device: str = DEV1,
    client_ts: str | None = None,
    offline: bool = False,
    supersedes: str | None = None,
    event_id: str | None = None,
) -> dict[str, Any]:
    e = {
        "id": event_id or uuid7(),
        "run_id": run_id,
        "type": type_,
        "step_id": step_id,
        "payload": payload if payload is not None else {},
        "actor_id": actor,
        "auth_method": auth,
        "device_id": device,
        "client_ts": client_ts or ts(),
        "offline": offline,
        "supersedes": supersedes,
    }
    e["content_hash"] = event_content_hash(e)
    return e


def run_created(run_id: str | None = None, **kw) -> dict[str, Any]:
    run_id = run_id or uuid7()
    return ev(
        "run.created",
        run_id,
        payload={"procedure_id": PROCEDURE_ID, "revision_id": REVISION_ID, "serial": "SN-0001", "work_order": "WO-77"},
        **kw,
    )


def inp(run_id: str, step_id: str, input_id: str, value: Any, source: str = "manual", **kw) -> dict[str, Any]:
    return ev("input.recorded", run_id, step_id, {"input_id": input_id, "value": value, "source": source}, **kw)


def push(client, events: list[dict[str, Any]], user: str = OPERATOR, device: str = DEV1) -> list[dict[str, Any]]:
    r = client.post("/sync/push", json={"device_id": device, "events": events}, headers=H(user))
    assert r.status_code == 200, r.text
    return r.json()["results"]


def push_raw(client, body: str, user: str = OPERATOR):
    return client.post("/sync/push", content=body, headers={**H(user), "Content-Type": "application/json"})


def push_one(client, event: dict[str, Any], user: str | None = None, device: str | None = None) -> dict[str, Any]:
    return push(client, [event], user or event["actor_id"], device or event["device_id"])[0]


def ok(result: dict[str, Any]) -> dict[str, Any]:
    assert result["status"] == "accepted", result
    return result


def rejected(result: dict[str, Any], contains: str = "") -> dict[str, Any]:
    assert result["status"] == "rejected", result
    assert contains in (result.get("error") or ""), result
    return result


def new_run(client, device: str = DEV1, actor: str = OPERATOR, **kw) -> str:
    e = run_created(device=device, actor=actor, **kw)
    ok(push_one(client, e))
    return e["run_id"]


PHOTO_HEX = "ab" * 32
PHOTO_REF = "sha256:" + PHOTO_HEX


def complete_parts_step(client, run_id: str, device: str = DEV1, actor: str = OPERATOR):
    for e in [
        inp(run_id, STEP_PARTS, IN_PART_SCAN, "PN-1234-0001", "scan", device=device, actor=actor),
        inp(run_id, STEP_PARTS, IN_NO_DAMAGE, True, device=device, actor=actor),
        ev("step.completed", run_id, STEP_PARTS, device=device, actor=actor),
    ]:
        ok(push_one(client, e))


def dumps(obj: Any) -> str:
    return json.dumps(obj)
