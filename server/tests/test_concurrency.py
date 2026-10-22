"""Parallel pushes to one run must yield a gap-free sequence and an intact chain (run row lock)."""

from concurrent.futures import ThreadPoolExecutor

from helpers import DEV1, DEV2, IN_NO_DAMAGE, OPERATOR, OPERATOR2, STEP_PARTS, H, inp, new_run

from app import models
from app.auth import CurrentUser
from app.db import get_sessionmaker
from app.ingest import ingest_batch


def _push(user_id, device, events):
    with get_sessionmaker()() as db:
        user = db.get(models.User, user_id)
        return ingest_batch(db, events, CurrentUser(user, set(user.roles)), device)


def test_parallel_pushes_serialise_per_run(client):
    run_id = new_run(client)
    batches = []
    for i in range(8):
        dev, actor = (DEV1, OPERATOR) if i % 2 == 0 else (DEV2, OPERATOR2)
        batches.append(
            (actor, dev, [inp(run_id, STEP_PARTS, IN_NO_DAMAGE, True, device=dev, actor=actor) for _ in range(5)])
        )
    # the same events pushed twice concurrently must be accepted once, duplicate once
    batches.append(batches[0])
    with ThreadPoolExecutor(max_workers=9) as pool:
        results = list(pool.map(lambda b: _push(*b), batches))
    flat = [r for batch in results for r in batch]
    accepted = [r for r in flat if r["status"] == "accepted"]
    assert len(accepted) == 40
    assert sum(r["status"] == "duplicate" for r in flat) == 5
    assert sorted(r["seq"] for r in accepted) == list(range(2, 42))
    v = client.get(f"/runs/{run_id}/verify", headers=H(OPERATOR)).json()
    assert v["ok"] and v["event_count"] == 41


def test_parallel_run_created_same_id(client):
    from helpers import run_created

    e = run_created()
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda _: _push(OPERATOR, DEV1, [e]), range(4)))
    statuses = sorted(r[0]["status"] for r in results)
    assert statuses.count("accepted") == 1 and statuses.count("duplicate") == 3, statuses
