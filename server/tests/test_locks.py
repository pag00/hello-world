import datetime as dt

from helpers import (
    DEV1,
    DEV2,
    IN_NO_DAMAGE,
    IN_PART_SCAN,
    IN_TOOL,
    OPERATOR,
    OPERATOR2,
    STEP_PARTS,
    STEP_TORQUE,
    SUPERVISOR,
    H,
    complete_parts_step,
    ev,
    inp,
    new_run,
    ok,
    push_one,
    run_created,
)
from sqlalchemy import select, text

from app import models


def lock(client, run_id, step_id, device=DEV1, user=OPERATOR, force=False):
    return client.post(
        f"/runs/{run_id}/steps/{step_id}/lock", json={"device_id": device, "force": force}, headers=H(user)
    )


def iso(t: dt.datetime) -> str:
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond // 1000:03d}Z"


def test_lock_lifecycle(client):
    run_id = new_run(client)
    r = lock(client, run_id, STEP_PARTS)
    assert r.status_code == 200
    lk = r.json()
    assert lk["holder_user"] == OPERATOR and lk["holder_device"] == DEV1 and lk["step_id"] == STEP_PARTS
    # re-lock from same device extends the same lease
    assert lock(client, run_id, STEP_PARTS).json()["lock_id"] == lk["lock_id"]
    # other device refused
    r = lock(client, run_id, STEP_PARTS, DEV2, OPERATOR2)
    assert r.status_code == 409 and r.json()["detail"]["lock"]["holder_device"] == DEV1
    # other step is free
    assert lock(client, run_id, STEP_TORQUE, DEV2, OPERATOR2).status_code == 200

    hb = client.post(f"/locks/{lk['lock_id']}/heartbeat", headers=H(OPERATOR))
    assert hb.status_code == 200 and hb.json()["expires_at"] >= lk["expires_at"]
    assert client.post(f"/locks/{lk['lock_id']}/heartbeat", headers=H(OPERATOR2)).status_code == 403

    locks = client.get(f"/runs/{run_id}/locks", headers=H(OPERATOR)).json()
    assert {x["step_id"] for x in locks["locks"]} == {STEP_PARTS, STEP_TORQUE} and locks["checkout"] is None

    assert client.delete(f"/locks/{lk['lock_id']}", headers=H(OPERATOR)).status_code == 204
    assert client.post(f"/locks/{lk['lock_id']}/heartbeat", headers=H(OPERATOR)).status_code == 409
    assert lock(client, run_id, STEP_PARTS, DEV2, OPERATOR2).status_code == 200


def test_expired_lease_cannot_be_heartbeated(client, db):
    run_id = new_run(client)
    lk = lock(client, run_id, STEP_PARTS).json()
    db.execute(
        text("UPDATE step_locks SET expires_at = now() - interval '1 second' WHERE id = :i"), {"i": lk["lock_id"]}
    )
    db.commit()
    assert client.post(f"/locks/{lk['lock_id']}/heartbeat", headers=H(OPERATOR)).status_code == 409
    # expired lease no longer blocks others
    assert lock(client, run_id, STEP_PARTS, DEV2, OPERATOR2).status_code == 200


def test_force_takeover(client):
    run_id = new_run(client)
    assert lock(client, run_id, STEP_PARTS).status_code == 200
    assert lock(client, run_id, STEP_PARTS, DEV2, OPERATOR2, force=True).status_code == 403
    r = lock(client, run_id, STEP_PARTS, DEV2, SUPERVISOR, force=True)
    assert r.status_code == 200 and r.json()["holder_device"] == DEV2
    events = client.get(f"/runs/{run_id}/events", headers=H(OPERATOR)).json()
    note = events[-1]
    assert note["type"] == "note.added" and note["payload"]["system"] == "lock_takeover"
    assert note["actor_id"] == SUPERVISOR and "Oskar Operator" in note["payload"]["text"]
    assert client.get(f"/runs/{run_id}/verify", headers=H(OPERATOR)).json()["ok"]
    # step state untouched by the system note
    proj = client.get(f"/runs/{run_id}/projection", headers=H(OPERATOR)).json()
    assert proj["steps"][STEP_PARTS]["state"] == "pending"


def test_lock_flags_held_unlocked_conflict(client):
    run_id = new_run(client)
    assert lock(client, run_id, STEP_PARTS).status_code == 200
    assert ok(push_one(client, inp(run_id, STEP_PARTS, IN_NO_DAMAGE, True)))["flags"] == []
    # another device writes to the locked step: accepted, flagged
    res = ok(push_one(client, inp(run_id, STEP_PARTS, IN_PART_SCAN, "PN-1234-9", "scan", device=DEV2, actor=OPERATOR2)))
    assert res["flags"] == ["conflict", "unlocked"]
    # a step nobody locked
    res = ok(push_one(client, inp(run_id, STEP_TORQUE, IN_TOOL, "TW-001", "scan", device=DEV2, actor=OPERATOR2)))
    assert res["flags"] == ["unlocked"]
    # diverging unlocked result from a third party
    res = ok(push_one(client, inp(run_id, STEP_TORQUE, IN_TOOL, "TW-002", "scan")))
    assert set(res["flags"]) == {"conflict", "unlocked", "tool_expired"}


def test_late_lock_and_conflict_after_expiry(client, db):
    run_id = new_run(client)
    lk = lock(client, run_id, STEP_PARTS).json()
    now = dt.datetime.now(dt.UTC)
    db.execute(
        text("UPDATE step_locks SET acquired_at = :a, expires_at = :e WHERE id = :i"),
        {"a": now - dt.timedelta(minutes=10), "e": now - dt.timedelta(minutes=5), "i": lk["lock_id"]},
    )
    db.commit()
    # event during the lease -> clean; after expiry with nobody else -> late_lock
    during = inp(run_id, STEP_PARTS, IN_NO_DAMAGE, True, client_ts=iso(now - dt.timedelta(minutes=7)))
    assert ok(push_one(client, during))["flags"] == []
    late = inp(run_id, STEP_PARTS, IN_PART_SCAN, "PN-1234-1", "scan", client_ts=iso(now - dt.timedelta(minutes=1)))
    assert ok(push_one(client, late))["flags"] == ["late_lock"]
    # someone else locks; the first device's later evidence is a conflict, but never rejected
    assert lock(client, run_id, STEP_PARTS, DEV2, OPERATOR2).status_code == 200
    after = ev("step.completed", run_id, STEP_PARTS, client_ts=iso(dt.datetime.now(dt.UTC) + dt.timedelta(seconds=1)))
    assert ok(push_one(client, after))["flags"] == ["conflict"]


def test_checkout(client):
    run_id = new_run(client)
    assert lock(client, run_id, STEP_PARTS, DEV2, OPERATOR2).status_code == 200
    r = client.post(f"/runs/{run_id}/checkout", json={"device_id": DEV1}, headers=H(OPERATOR))
    assert r.status_code == 409
    lk_id = client.get(f"/runs/{run_id}/locks", headers=H(OPERATOR)).json()["locks"][0]["lock_id"]
    client.delete(f"/locks/{lk_id}", headers=H(OPERATOR2))

    r = client.post(f"/runs/{run_id}/checkout", json={"device_id": DEV1, "hours": 24}, headers=H(OPERATOR))
    assert r.status_code == 200
    co = r.json()
    expires = dt.datetime.fromisoformat(co["expires_at"].replace("Z", "+00:00"))
    assert dt.timedelta(hours=23) < expires - dt.datetime.now(dt.UTC) <= dt.timedelta(hours=24)
    assert (
        client.post(f"/runs/{run_id}/checkout", json={"device_id": DEV1, "hours": 100}, headers=H(OPERATOR)).status_code
        == 422
    )

    # while checked out: no other device may lock or check out
    assert lock(client, run_id, STEP_PARTS, DEV2, OPERATOR2).status_code == 409
    assert client.post(f"/runs/{run_id}/checkout", json={"device_id": DEV2}, headers=H(OPERATOR2)).status_code == 409
    # the holder device may still lock steps (it already owns the run)
    assert lock(client, run_id, STEP_PARTS).status_code == 200

    # offline work under the checkout: clean
    assert ok(push_one(client, inp(run_id, STEP_PARTS, IN_NO_DAMAGE, True, offline=True)))["flags"] == []
    # another device writing meanwhile: conflict
    res = ok(push_one(client, inp(run_id, STEP_TORQUE, IN_TOOL, "TW-001", "scan", device=DEV2, actor=OPERATOR2)))
    assert res["flags"] == ["conflict", "unlocked"]

    assert client.get(f"/runs/{run_id}/locks", headers=H(OPERATOR)).json()["checkout"]["holder_device"] == DEV1
    assert client.delete(f"/runs/{run_id}/checkout", headers=H(OPERATOR2)).status_code == 403
    assert client.delete(f"/runs/{run_id}/checkout", headers=H(OPERATOR)).status_code == 204
    assert client.get(f"/runs/{run_id}/locks", headers=H(OPERATOR)).json()["checkout"] is None


def test_offline_run_created_grants_checkout(client, db):
    created_at = dt.datetime.now(dt.UTC) - dt.timedelta(hours=2)
    e = run_created(device=DEV1, offline=True, client_ts=iso(created_at))
    ok(push_one(client, e))
    run_id = e["run_id"]
    co = db.scalar(select(models.RunCheckout).where(models.RunCheckout.run_id == run_id))
    assert co.holder_device == DEV1 and co.holder_user == OPERATOR and co.source == "offline_run_created"
    assert co.acquired_at == created_at.replace(microsecond=created_at.microsecond // 1000 * 1000)
    assert co.expires_at - co.acquired_at == dt.timedelta(hours=12)

    # events recorded offline after creation are covered
    step_events = [
        inp(
            run_id,
            STEP_PARTS,
            IN_PART_SCAN,
            "PN-1234-5",
            "scan",
            offline=True,
            client_ts=iso(created_at + dt.timedelta(minutes=5)),
        ),
        inp(run_id, STEP_PARTS, IN_NO_DAMAGE, True, offline=True, client_ts=iso(created_at + dt.timedelta(minutes=6))),
        ev("step.completed", run_id, STEP_PARTS, offline=True, client_ts=iso(created_at + dt.timedelta(minutes=7))),
    ]
    for se in step_events:
        assert ok(push_one(client, se))["flags"] == []
    # nobody else can lock while the implicit checkout lasts
    assert lock(client, run_id, STEP_TORQUE, DEV2, OPERATOR2).status_code == 409


def test_online_run_created_has_no_checkout(client, db):
    run_id = new_run(client)
    assert db.scalar(select(models.RunCheckout).where(models.RunCheckout.run_id == run_id)) is None


def test_lock_on_closed_run_or_unknown_step(client):
    import uuid

    run_id = new_run(client)
    assert lock(client, run_id, str(uuid.uuid4())).status_code == 404
    complete_parts_step(client, run_id)
    ok(push_one(client, ev("run.aborted", run_id, payload={"reason": "x"}, actor=SUPERVISOR)))
    assert lock(client, run_id, STEP_TORQUE).status_code == 409
    assert client.post(f"/runs/{run_id}/checkout", json={"device_id": DEV1}, headers=H(OPERATOR)).status_code == 409


def test_notes_and_ncrs_from_other_devices_are_not_lock_bound(client):
    import uuid

    run_id = new_run(client)
    assert lock(client, run_id, STEP_PARTS).status_code == 200
    note = ev("note.added", run_id, STEP_PARTS, {"text": "watch the burr"}, actor=SUPERVISOR, device=DEV2)
    assert ok(push_one(client, note))["flags"] == []
    ncr = ev(
        "ncr.raised",
        run_id,
        STEP_PARTS,
        {"ncr_id": str(uuid.uuid4()), "description": "dent"},
        device=DEV2,
        actor=OPERATOR2,
    )
    assert ok(push_one(client, ncr))["flags"] == []
    proj = client.get(f"/runs/{run_id}/projection", headers=H(OPERATOR)).json()
    assert proj["steps"][STEP_PARTS]["state"] == "in_progress"
