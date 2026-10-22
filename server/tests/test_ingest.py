import datetime as dt
import json

from helpers import (
    AUTHOR,
    DEV1,
    DEV2,
    IN_FINAL_SIGN,
    IN_INSULATION,
    IN_NO_DAMAGE,
    IN_PART_SCAN,
    IN_PHOTO,
    IN_ROUTED,
    IN_TOOL,
    IN_TORQUE,
    INSPECTOR,
    OPERATOR,
    OPERATOR2,
    PHOTO_REF,
    STEP_FINAL,
    STEP_HARNESS,
    STEP_PARTS,
    STEP_TORQUE,
    SUPERVISOR,
    H,
    complete_parts_step,
    ev,
    inp,
    new_run,
    ok,
    push,
    push_one,
    push_raw,
    rejected,
    run_created,
)
from sqlalchemy import select

from app import models
from app.canonical import GENESIS_CHAIN_HASH, chain_hash, event_content_hash
from app.ids import uuid7


def lock(client, run_id, step_id, device=DEV1, user=OPERATOR):
    r = client.post(f"/runs/{run_id}/steps/{step_id}/lock", json={"device_id": device}, headers=H(user))
    assert r.status_code == 200, r.text
    return r.json()


def test_run_created_and_chain(client):
    e = run_created()
    res = ok(push_one(client, e))
    assert res["seq"] == 1 and res["flags"] == []
    events = client.get(f"/runs/{e['run_id']}/events", headers=H(OPERATOR)).json()
    assert events[0]["prev_chain_hash"] == GENESIS_CHAIN_HASH
    assert events[0]["chain_hash"] == chain_hash(GENESIS_CHAIN_HASH, e["content_hash"])
    run = client.get(f"/runs/{e['run_id']}", headers=H(OPERATOR)).json()
    assert run["serial"] == "SN-0001" and run["status"] == "active" and run["created_by"] == OPERATOR
    assert run["created_at"] == e["client_ts"]


def test_duplicate_and_conflicting_id(client):
    e = run_created()
    ok(push_one(client, e))
    dup = push_one(client, e)
    assert dup["status"] == "duplicate" and dup["seq"] == 1
    other = run_created(run_id=e["run_id"], event_id=e["id"])  # same id, different content (new client_ts)
    assert other["content_hash"] != e["content_hash"]
    rejected(push_one(client, other), "different content_hash")


def test_duplicate_returned_even_after_run_closed(client):
    run_id = new_run(client)
    abort = ev("run.aborted", run_id, payload={"reason": "scrapped"}, actor=SUPERVISOR)
    ok(push_one(client, abort))
    assert push_one(client, abort)["status"] == "duplicate"


def test_hash_mismatch(client):
    e = run_created()
    e["payload"]["serial"] = "SN-TAMPERED"
    rejected(push_one(client, e), "content_hash mismatch")


def test_float_rejected_from_raw_json(client):
    run_id = new_run(client)
    e = inp(run_id, STEP_TORQUE, IN_TORQUE, "12.0")
    good = inp(run_id, STEP_PARTS, IN_NO_DAMAGE, True)
    # the client "accidentally" sends a JSON number; hash computed over the float literal by a naive client
    raw = json.dumps({"device_id": DEV1, "events": [e, good]}).replace('"value": "12.0"', '"value": 12.0')
    r = push_raw(client, raw)
    assert r.status_code == 200
    res = r.json()["results"]
    rejected(res[0], "float not allowed at $.payload.value")
    ok(res[1])  # the batch is not failed as a whole


def test_nan_and_big_int_rejected(client):
    run_id = new_run(client)
    e1 = inp(run_id, STEP_TORQUE, IN_TORQUE, "x")
    e2 = inp(run_id, STEP_TORQUE, IN_TORQUE, "y")
    raw = json.dumps({"device_id": DEV1, "events": [e1, e2]})
    raw = raw.replace('"value": "x"', '"value": NaN').replace('"value": "y"', '"value": 9007199254740993')
    res = push_raw(client, raw).json()["results"]
    rejected(res[0], "float not allowed")
    rejected(res[1], "integer out of range")


def test_schema_invalid(client):
    run_id = new_run(client)
    bad = [
        {**ev("step.started", run_id, STEP_PARTS), "extra": 1},
        ev("step.started", run_id, None),
        ev("step.started", run_id, STEP_PARTS, {"unexpected": True}),
        ev("bogus.type", run_id, STEP_PARTS),
        ev("run.completed", run_id, STEP_PARTS, actor=SUPERVISOR),
        ev("note.added", run_id, None, {"text": "x", "system": "lock_takeover"}),
        ev("step.started", run_id, STEP_PARTS, client_ts="2026-10-22 10:00:00"),
        "not an object",
    ]
    for b in bad[:1]:
        b["content_hash"] = event_content_hash(b)
    results = push(client, bad)
    assert all(r["status"] == "rejected" for r in results), results
    assert "system notes" in results[5]["error"]


def test_device_mismatch(client):
    e = run_created(device=DEV2)
    rejected(push(client, [e], OPERATOR, DEV1)[0], "device_id")


def test_unknown_run_and_step(client):
    rejected(push_one(client, ev("step.started", uuid7(), STEP_PARTS)), "unknown run")
    run_id = new_run(client)
    rejected(push_one(client, ev("step.started", run_id, uuid7())), "unknown step")


def test_role_rejections(client):
    rejected(push_one(client, run_created(actor=AUTHOR)), "lacks role")
    run_id = new_run(client)
    complete_parts_step(client, run_id)
    rejected(push_one(client, ev("step.reopened", run_id, STEP_PARTS, {"reason": "x"})), "requires supervisor")
    rejected(push_one(client, ev("run.aborted", run_id, payload={"reason": "x"})), "requires supervisor")
    ok(push_one(client, ev("step.reopened", run_id, STEP_PARTS, {"reason": "recheck"}, actor=SUPERVISOR)))


def test_actor_must_be_authenticated_user_for_oidc(client):
    e = run_created(actor=OPERATOR2)
    rejected(push(client, [e], OPERATOR, DEV1)[0], "actor must be the authenticated user")


def test_pin_countersign_records_pusher(client, db):
    run_id = new_run(client)
    complete_parts_step(client, run_id)
    e = ev("note.added", run_id, STEP_PARTS, {"text": "countersigned"}, actor=INSPECTOR, auth="pin")
    ok(push(client, [e], OPERATOR, DEV1)[0])
    row = db.get(models.RunEvent, e["id"])
    assert row.actor_id == INSPECTOR and row.pushed_by == OPERATOR and row.auth_method == "pin"


def test_pin_actor_without_pin_rejected(client):
    r = client.post(
        "/users", json={"name": "No Pin", "roles": ["operator"]}, headers=H("0192b7a0-0000-7000-8000-000000000106")
    )
    nopin = r.json()["id"]
    run_id = new_run(client)
    rejected(push(client, [ev("step.started", run_id, STEP_PARTS, actor=nopin, auth="pin")], OPERATOR)[0], "no PIN")


def test_closed_run_rejects_events(client):
    run_id = new_run(client)
    ok(push_one(client, ev("run.aborted", run_id, payload={"reason": "dropped"}, actor=SUPERVISOR)))
    rejected(push_one(client, ev("step.started", run_id, STEP_PARTS)), "run is aborted")
    assert client.get(f"/runs/{run_id}", headers=H(OPERATOR)).json()["status"] == "aborted"


def test_step_completed_validation(client):
    run_id = new_run(client)
    ok(push_one(client, inp(run_id, STEP_PARTS, IN_PART_SCAN, "PN-1234-1")))
    rejected(push_one(client, ev("step.completed", run_id, STEP_PARTS)), "required inputs missing: No transport damage")
    ok(push_one(client, inp(run_id, STEP_PARTS, IN_NO_DAMAGE, True)))
    ok(push_one(client, ev("step.completed", run_id, STEP_PARTS)))


def test_completion_out_of_dependency_order_allowed(client):
    # depends_on is not a reason to reject evidence (offline order may differ)
    run_id = new_run(client)
    for e in [
        inp(run_id, STEP_TORQUE, IN_TOOL, "TW-001", "scan"),
        inp(run_id, STEP_TORQUE, IN_TORQUE, "12.1", "ocr"),
        inp(run_id, STEP_TORQUE, IN_PHOTO, [PHOTO_REF]),
    ]:
        ok(push_one(client, e))
    ok(push_one(client, ev("step.completed", run_id, STEP_TORQUE)))


def test_out_of_tolerance_flag_blocks_until_ncr(client, db):
    run_id = new_run(client)
    res = ok(push_one(client, inp(run_id, STEP_TORQUE, IN_TORQUE, "12.6")))
    assert "out_of_tolerance" in res["flags"]
    assert client.get(f"/runs/{run_id}", headers=H(OPERATOR)).json()["status"] == "blocked"
    for e in [inp(run_id, STEP_TORQUE, IN_TOOL, "TW-001", "scan"), inp(run_id, STEP_TORQUE, IN_PHOTO, [PHOTO_REF])]:
        ok(push_one(client, e))
    rejected(push_one(client, ev("step.completed", run_id, STEP_TORQUE)), "out_of_tolerance")

    ncr_id = uuid7()
    ok(
        push_one(
            client,
            ev(
                "ncr.raised",
                run_id,
                STEP_TORQUE,
                {"ncr_id": ncr_id, "description": "overtorqued", "input_id": IN_TORQUE},
            ),
        )
    )
    ok(push_one(client, ev("step.completed", run_id, STEP_TORQUE)))
    ncr = client.get(f"/ncrs/{ncr_id}", headers=H(OPERATOR)).json()
    assert ncr["status"] == "open" and ncr["number"].startswith("NCR-") and ncr["number"].endswith("-0001")
    assert ncr["input_id"] == IN_TORQUE and ncr["raised_by"] == OPERATOR

    rejected(
        push_one(client, ev("ncr.closed", run_id, STEP_TORQUE, {"ncr_id": ncr_id}, actor=SUPERVISOR)), "dispositioned"
    )
    ok(
        push_one(
            client,
            ev(
                "ncr.dispositioned",
                run_id,
                STEP_TORQUE,
                {"ncr_id": ncr_id, "disposition": "use_as_is", "note": "ok per eng."},
                actor=SUPERVISOR,
            ),
        )
    )
    ok(push_one(client, ev("ncr.closed", run_id, STEP_TORQUE, {"ncr_id": ncr_id}, actor=SUPERVISOR)))
    rejected(push_one(client, ev("ncr.closed", run_id, STEP_TORQUE, {"ncr_id": ncr_id}, actor=SUPERVISOR)), "closed")
    ncr = client.get(f"/ncrs/{ncr_id}", headers=H(OPERATOR)).json()
    assert ncr["status"] == "closed" and ncr["disposition"] == "use_as_is" and ncr["dispositioned_by"] == SUPERVISOR
    assert ncr["closed_by"] == SUPERVISOR
    rejected(
        push_one(client, ev("ncr.raised", run_id, STEP_TORQUE, {"ncr_id": ncr_id, "description": "again"})),
        "already exists",
    )


def test_ncr_numbers_sequential(client):
    run_id = new_run(client)
    numbers = []
    for _ in range(3):
        nid = uuid7()
        ok(push_one(client, ev("ncr.raised", run_id, None, {"ncr_id": nid, "description": "x"})))
        numbers.append(client.get(f"/ncrs/{nid}", headers=H(OPERATOR)).json()["number"])
    assert [n[-4:] for n in numbers] == ["0001", "0002", "0003"]
    assert len(client.get(f"/ncrs?run_id={run_id}&status=open", headers=H(OPERATOR)).json()) == 3


def test_verification_rules(client):
    run_id = new_run(client)
    complete_parts_step(client, run_id)
    for e in [
        inp(run_id, STEP_TORQUE, IN_TOOL, "TW-001", "scan"),
        inp(run_id, STEP_TORQUE, IN_TORQUE, "12.0"),
        inp(run_id, STEP_TORQUE, IN_PHOTO, [PHOTO_REF]),
    ]:
        ok(push_one(client, e))
    rejected(push_one(client, ev("step.verified", run_id, STEP_TORQUE, actor=INSPECTOR)), "not completed")
    # the completer is an inspector-capable supervisor: still may not verify own work
    ok(push_one(client, ev("step.completed", run_id, STEP_TORQUE, actor=SUPERVISOR)))
    rejected(push_one(client, ev("step.verified", run_id, STEP_TORQUE, actor=OPERATOR)), "requires inspector")
    s = push_one(client, ev("step.verified", run_id, STEP_TORQUE, actor=SUPERVISOR))
    rejected(s, "requires inspector")
    ok(push_one(client, ev("step.verified", run_id, STEP_TORQUE, actor=INSPECTOR)))


def test_self_verification_rejected(client, db):
    # one user holding operator + inspector completes, then tries to verify
    db.get(models.User, INSPECTOR).roles = ["inspector", "operator"]
    db.commit()
    run_id = new_run(client)
    complete_parts_step(client, run_id)
    for e in [
        inp(run_id, STEP_TORQUE, IN_TOOL, "TW-001", "scan", actor=INSPECTOR),
        inp(run_id, STEP_TORQUE, IN_TORQUE, "12.0", actor=INSPECTOR),
        inp(run_id, STEP_TORQUE, IN_PHOTO, [PHOTO_REF], actor=INSPECTOR),
        ev("step.completed", run_id, STEP_TORQUE, actor=INSPECTOR),
    ]:
        ok(push_one(client, e))
    rejected(push_one(client, ev("step.verified", run_id, STEP_TORQUE, actor=INSPECTOR)), "must not be the person")


def test_scan_expect_and_signoff_role(client):
    run_id = new_run(client)
    rejected(push_one(client, inp(run_id, STEP_PARTS, IN_PART_SCAN, "XX-9", "scan")), "does not match")
    ok(push_one(client, inp(run_id, STEP_PARTS, IN_PART_SCAN, "PN-1234-77", "scan")))
    rejected(push_one(client, inp(run_id, STEP_FINAL, IN_FINAL_SIGN, True)), "signoff requires role inspector")
    ok(push_one(client, inp(run_id, STEP_FINAL, IN_FINAL_SIGN, True, actor=INSPECTOR)))


def test_input_value_types(client):
    run_id = new_run(client)
    rejected(push_one(client, inp(run_id, STEP_TORQUE, IN_TORQUE, "12,5")), "decimal string")
    rejected(push_one(client, inp(run_id, STEP_TORQUE, IN_TORQUE, "1e3")), "decimal string")
    rejected(push_one(client, inp(run_id, STEP_PARTS, IN_NO_DAMAGE, "yes")), "must be true")
    rejected(push_one(client, inp(run_id, STEP_TORQUE, IN_PHOTO, [PHOTO_REF] * 4)), "at most 3")
    rejected(push_one(client, inp(run_id, STEP_TORQUE, IN_PHOTO, "sha256:" + "a" * 64)), "list")
    rejected(push_one(client, inp(run_id, STEP_TORQUE, IN_ROUTED, True)), "unknown input")


def test_tool_flags(client, db):
    run_id = new_run(client)
    lock(client, run_id, STEP_TORQUE)
    assert ok(push_one(client, inp(run_id, STEP_TORQUE, IN_TOOL, "TW-001", "scan")))["flags"] == []
    assert ok(push_one(client, inp(run_id, STEP_TORQUE, IN_TOOL, "TW-002", "scan")))["flags"] == ["tool_expired"]
    assert ok(push_one(client, inp(run_id, STEP_TORQUE, IN_TOOL, "TW-404", "scan")))["flags"] == ["tool_unknown"]
    assert ok(push_one(client, inp(run_id, STEP_TORQUE, IN_TOOL, "st:tool:TW-001", "scan")))["flags"] == []
    proj = client.get(f"/runs/{run_id}/projection", headers=H(OPERATOR)).json()
    assert proj["steps"][STEP_TORQUE]["block_reasons"] == ["depends_on"]
    checks = {c.code: c.status for c in db.scalars(select(models.EventToolCheck))}
    assert checks == {"TW-001": "ok", "TW-002": "expired", "TW-404": "unknown"}


def test_tool_inactive_flagged_expired(client):
    from app.seed import ADMIN, TOOL_VALID

    r = client.put(
        f"/tools/{TOOL_VALID}",
        json={"code": "TW-001", "description": "retired", "calibration_due": None, "active": False},
        headers=H(ADMIN),
    )
    assert r.status_code == 200
    run_id = new_run(client)
    assert "tool_expired" in ok(push_one(client, inp(run_id, STEP_TORQUE, IN_TOOL, "TW-001", "scan")))["flags"]


def test_offline_use_checked_against_calibration_effective_then(client):
    """Expired tool used offline, recalibrated before the tablet syncs: still flagged."""
    from app.seed import ADMIN, TOOL_EXPIRED

    run_id = new_run(client)
    used_at = (dt.datetime.now(dt.UTC) - dt.timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    offline_scan = inp(run_id, STEP_TORQUE, IN_TOOL, "TW-002", "scan", client_ts=used_at, offline=True)
    later = (dt.date.today() + dt.timedelta(days=365)).isoformat()
    r = client.put(
        f"/tools/{TOOL_EXPIRED}",
        json={"code": "TW-002", "description": "recal", "calibration_due": later},
        headers=H(ADMIN),
    )
    assert r.status_code == 200
    assert "tool_expired" in ok(push_one(client, offline_scan))["flags"]
    # used now: fine
    assert "tool_expired" not in ok(push_one(client, inp(run_id, STEP_TORQUE, IN_TOOL, "TW-002", "scan")))["flags"]


def test_supersede_correction(client):
    run_id = new_run(client)
    wrong = inp(run_id, STEP_TORQUE, IN_TORQUE, "121")
    assert "out_of_tolerance" in ok(push_one(client, wrong))["flags"]
    rejected(push_one(client, inp(run_id, STEP_TORQUE, IN_TOOL, "TW-001", supersedes=wrong["id"])), "same input")
    rejected(push_one(client, inp(run_id, STEP_PARTS, IN_NO_DAMAGE, True, supersedes=wrong["id"])), "same step")
    rejected(push_one(client, inp(run_id, STEP_TORQUE, IN_TORQUE, "12.1", supersedes=uuid7())), "unknown event")
    ok(push_one(client, inp(run_id, STEP_TORQUE, IN_TORQUE, "12.1", supersedes=wrong["id"])))
    proj = client.get(f"/runs/{run_id}/projection", headers=H(OPERATOR)).json()
    assert proj["steps"][STEP_TORQUE]["inputs"][IN_TORQUE]["value"] == "12.1"
    assert client.get(f"/runs/{run_id}", headers=H(OPERATOR)).json()["status"] == "active"


def test_run_created_requires_released_revision(client):
    rev = client.post("/procedures", json={"number": "ASM-0900", "title": "draft only"}, headers=H(AUTHOR)).json()
    e = run_created()
    e["payload"]["procedure_id"] = rev["procedure"]["id"]
    e["payload"]["revision_id"] = rev["revision"]["id"]
    e["content_hash"] = event_content_hash(e)
    rejected(push_one(client, e), "released revision")
    e2 = run_created()
    e2["payload"]["procedure_id"] = rev["procedure"]["id"]  # mismatching procedure for the seeded revision
    e2["content_hash"] = event_content_hash(e2)
    rejected(push_one(client, e2), "unknown procedure revision")
    existing = new_run(client)
    rejected(push_one(client, run_created(run_id=existing)), "run already exists")


def _full_run(client, run_id, photo=PHOTO_REF):
    complete_parts_step(client, run_id)
    for e in [
        inp(run_id, STEP_TORQUE, IN_TOOL, "TW-001", "scan"),
        inp(run_id, STEP_TORQUE, IN_TORQUE, "12.0", "ocr"),
        inp(run_id, STEP_TORQUE, IN_PHOTO, [photo]),
        ev("step.completed", run_id, STEP_TORQUE),
        ev("step.verified", run_id, STEP_TORQUE, actor=INSPECTOR),
        inp(run_id, STEP_HARNESS, IN_ROUTED, True),
        ev("step.completed", run_id, STEP_HARNESS),
        inp(run_id, STEP_FINAL, IN_INSULATION, "250"),
        inp(run_id, STEP_FINAL, IN_FINAL_SIGN, True, actor=INSPECTOR),
        ev("step.completed", run_id, STEP_FINAL, actor=INSPECTOR),
    ]:
        ok(push_one(client, e))


def test_run_completed_requires_blobs_and_role(client):
    import hashlib

    data = b"\x89PNG fake photo bytes"
    sha = hashlib.sha256(data).hexdigest()
    run_id = new_run(client)
    rejected(push_one(client, ev("run.completed", run_id, actor=SUPERVISOR)), "cannot be completed")
    _full_run(client, run_id, photo=f"sha256:{sha}")
    rejected(push_one(client, ev("run.completed", run_id)), "requires inspector or supervisor")
    rejected(push_one(client, ev("run.completed", run_id, actor=SUPERVISOR)), "photos not uploaded")
    r = client.put(f"/blobs/{sha}", content=data, headers={**H(OPERATOR), "Content-Type": "image/png"})
    assert r.status_code == 201
    ok(push_one(client, ev("run.completed", run_id, actor=SUPERVISOR)))
    run = client.get(f"/runs/{run_id}", headers=H(OPERATOR)).json()
    assert run["status"] == "completed" and run["closed_at"]


def test_blob_missing_is_derived_and_clears(client):
    import hashlib

    data = b"photo-bytes"
    sha = hashlib.sha256(data).hexdigest()
    run_id = new_run(client)
    res = ok(push_one(client, inp(run_id, STEP_TORQUE, IN_PHOTO, [f"sha256:{sha}"])))
    assert "blob_missing" in res["flags"]
    first = client.get("/sync/pull", headers=H(OPERATOR)).json()
    evt = next(e for e in first["events"] if e["id"] == res["id"])
    assert "blob_missing" in evt["flags"]
    assert client.put(f"/blobs/{sha}", content=data, headers=H(OPERATOR)).status_code == 201
    second = client.get(f"/sync/pull?cursor={first['cursor']}", headers=H(OPERATOR)).json()
    evt = next(e for e in second["events"] if e["id"] == res["id"])
    assert "blob_missing" not in evt["flags"]


def test_conflict_resolution_validation(client):
    run_id = new_run(client)
    complete_parts_step(client, run_id)
    lock(client, run_id, STEP_TORQUE, DEV1)
    a = inp(run_id, STEP_TORQUE, IN_TOOL, "TW-001", "scan")
    ok(push_one(client, a))
    b = inp(run_id, STEP_TORQUE, IN_TOOL, "TW-002", "scan", actor=OPERATOR2, device=DEV2)
    res = ok(push_one(client, b))
    assert "conflict" in res["flags"] and "unlocked" in res["flags"]
    proj = client.get(f"/runs/{run_id}/projection", headers=H(OPERATOR)).json()
    assert proj["steps"][STEP_TORQUE]["state"] == "conflict" and proj["status"] == "blocked"
    rejected(
        push_one(
            client,
            ev(
                "conflict.resolved",
                run_id,
                STEP_TORQUE,
                {"kept_event_ids": [a["id"]], "rejected_event_ids": [a["id"]], "reason": "x"},
                actor=SUPERVISOR,
            ),
        ),
        "both kept and rejected",
    )
    rejected(
        push_one(
            client,
            ev(
                "conflict.resolved",
                run_id,
                STEP_TORQUE,
                {"kept_event_ids": [a["id"]], "rejected_event_ids": [uuid7()], "reason": "x"},
                actor=SUPERVISOR,
            ),
        ),
        "unknown event",
    )
    ok(
        push_one(
            client,
            ev(
                "conflict.resolved",
                run_id,
                STEP_TORQUE,
                {"kept_event_ids": [a["id"]], "rejected_event_ids": [b["id"]], "reason": "wrong wrench"},
                actor=SUPERVISOR,
            ),
        )
    )
    proj = client.get(f"/runs/{run_id}/projection", headers=H(OPERATOR)).json()
    assert proj["steps"][STEP_TORQUE]["state"] == "in_progress"
    assert proj["steps"][STEP_TORQUE]["inputs"][IN_TOOL]["value"] == "TW-001"
    assert client.get(f"/runs/{run_id}", headers=H(OPERATOR)).json()["status"] == "active"


def test_batch_with_new_run_in_any_order(client):
    e = run_created()
    later = inp(e["run_id"], STEP_PARTS, IN_NO_DAMAGE, True)
    res = push(client, [later, e])
    assert [r["status"] for r in res] == ["accepted", "accepted"]
    assert res[1]["seq"] == 1 and res[0]["seq"] == 2


def test_push_limits_and_body_validation(client):
    r = client.post("/sync/push", json={"events": []}, headers=H(OPERATOR))
    assert r.status_code == 422
    r = client.post("/sync/push", json={"device_id": DEV1, "events": [{}] * 501}, headers=H(OPERATOR))
    assert r.status_code == 413
    r = push_raw(client, "{not json")
    assert r.status_code == 400
    assert client.post("/sync/push", json={"device_id": DEV1, "events": []}).status_code == 401
