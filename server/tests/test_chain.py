import pytest
from helpers import IN_NO_DAMAGE, IN_TORQUE, OPERATOR, STEP_PARTS, STEP_TORQUE, H, inp, new_run, ok, push_one
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError


def _run_with_events(client):
    run_id = new_run(client)
    for e in [
        inp(run_id, STEP_PARTS, IN_NO_DAMAGE, True),
        inp(run_id, STEP_TORQUE, IN_TORQUE, "12.0"),
        inp(run_id, STEP_TORQUE, IN_TORQUE, "12.1"),
    ]:
        ok(push_one(client, e))
    return run_id


def _tamper(db, sql, **params):
    # The ledger is protected by an append-only trigger; an attacker with DDL rights can disable it.
    db.execute(text("ALTER TABLE run_events DISABLE TRIGGER run_events_immutable"))
    db.execute(text(sql), params)
    db.execute(text("ALTER TABLE run_events ENABLE TRIGGER run_events_immutable"))
    db.commit()


def test_verify_ok(client):
    run_id = _run_with_events(client)
    v = client.get(f"/runs/{run_id}/verify", headers=H(OPERATOR)).json()
    assert v == {"ok": True, "event_count": 4, "errors": []}


def test_ledger_is_append_only_in_db(client, db):
    run_id = _run_with_events(client)
    with pytest.raises(DBAPIError, match="append-only"):
        db.execute(text("UPDATE run_events SET flags = '{}' WHERE run_id = :r"), {"r": run_id})
    db.rollback()
    with pytest.raises(DBAPIError, match="append-only"):
        db.execute(text("DELETE FROM run_events WHERE run_id = :r"), {"r": run_id})
    db.rollback()


def test_tampered_value_detected(client, db):
    run_id = _run_with_events(client)
    _tamper(
        db,
        'UPDATE run_events SET canonical = replace(canonical, \'"value":"12.0"\', \'"value":"12.2"\') '
        "WHERE run_id = :r AND seq = 3",
        r=run_id,
    )
    v = client.get(f"/runs/{run_id}/verify", headers=H(OPERATOR)).json()
    assert v["ok"] is False and v["first_bad_seq"] == 3
    assert any("content_hash does not match" in e for e in v["errors"])


def test_tampered_hash_and_chain_detected(client, db):
    """Recomputing the content hash after editing still breaks the chain link."""
    from app.canonical import sha256_ref

    run_id = _run_with_events(client)
    row = db.execute(text("SELECT canonical FROM run_events WHERE run_id = :r AND seq = 2"), {"r": run_id}).one()
    forged = row.canonical.replace('"value":true', '"value":true,"x":1')
    _tamper(
        db,
        "UPDATE run_events SET canonical = :c, content_hash = :h WHERE run_id = :r AND seq = 2",
        c=forged,
        h=sha256_ref(forged),
        r=run_id,
    )
    v = client.get(f"/runs/{run_id}/verify", headers=H(OPERATOR)).json()
    assert v["ok"] is False and v["first_bad_seq"] == 2
    assert any("chain_hash" in e for e in v["errors"])


def test_denormalised_column_tamper_detected(client, db):
    from app.seed import SUPERVISOR

    run_id = _run_with_events(client)
    _tamper(db, "UPDATE run_events SET actor_id = :a WHERE run_id = :r AND seq = 4", a=SUPERVISOR, r=run_id)
    v = client.get(f"/runs/{run_id}/verify", headers=H(OPERATOR)).json()
    assert v["ok"] is False and v["first_bad_seq"] == 4
    assert any("actor_id" in e for e in v["errors"])


def test_deleted_event_detected(client, db):
    run_id = _run_with_events(client)
    _tamper(db, "DELETE FROM run_events WHERE run_id = :r AND seq = 2", r=run_id)
    v = client.get(f"/runs/{run_id}/verify", headers=H(OPERATOR)).json()
    assert v["ok"] is False and v["first_bad_seq"] == 3 and v["event_count"] == 3
