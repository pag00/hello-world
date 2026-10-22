import copy

import pytest
from helpers import ADMIN, APPROVER, AUTHOR, OPERATOR, PROCEDURE_ID, REVISION_ID, H

from app.canonical import hash_canonical
from app.revisions import rev_letter
from app.seed import DEMO_CONTENT

SEC, STEP, INP = (
    "0192b7a0-0000-7000-8000-00000000a001",
    "0192b7a0-0000-7000-8000-00000000a002",
    "0192b7a0-0000-7000-8000-00000000a003",
)


def content(title="Fit bracket", **step_extra):
    step = {
        "id": STEP,
        "title": title,
        "instructions": "Do it",
        "media": [],
        "locations": ["WS-01"],
        "depends_on": [],
        "inputs": [{"id": INP, "type": "text", "label": "Remarks", "required": False}],
        **step_extra,
    }
    return {"schema": 1, "sections": [{"id": SEC, "title": "Main", "steps": [step]}]}


def create(client, number="ASM-0100", user=AUTHOR, body_content=None):
    r = client.post(
        "/procedures", json={"number": number, "title": "Test", "content": body_content or content()}, headers=H(user)
    )
    assert r.status_code == 201, r.text
    return r.json()


def make_approver_author(client):
    r = client.post("/users", json={"name": "Both Roles", "roles": ["author", "approver"]}, headers=H(ADMIN))
    assert r.status_code == 201
    return r.json()["id"]


def test_rev_letters_skip_confusable():
    letters = [rev_letter(n) for n in range(1, 22)]
    assert letters[:8] == ["A", "B", "C", "D", "E", "F", "G", "H"]
    assert letters[8] == "J"
    for bad in "IOQSXZ":
        assert bad not in letters
    assert letters[19] == "Y" and letters[20] == "AA"


def test_full_state_machine(client):
    created = create(client)
    proc, rev = created["procedure"], created["revision"]
    assert rev["rev"] == "A" and rev["status"] == "draft" and rev["content_hash"] is None

    # draft is editable
    edited = content(title="Fit bracket (edited)")
    r = client.put(f"/revisions/{rev['id']}/content", json={"content": edited}, headers=H(AUTHOR))
    assert r.status_code == 200 and r.json()["content"] == edited

    # operators can't author
    assert (
        client.put(f"/revisions/{rev['id']}/content", json={"content": edited}, headers=H(OPERATOR)).status_code == 403
    )

    r = client.post(f"/revisions/{rev['id']}/submit", headers=H(AUTHOR))
    assert r.status_code == 200, r.text
    submitted = r.json()
    assert submitted["status"] == "in_review"
    assert submitted["content_hash"] == hash_canonical(edited) == hash_canonical(submitted["content"])

    # frozen once submitted
    r = client.put(f"/revisions/{rev['id']}/content", json={"content": content()}, headers=H(AUTHOR))
    assert r.status_code == 409

    # author cannot approve (and lacks approver role anyway); approver can
    assert client.post(f"/revisions/{rev['id']}/approve", json={}, headers=H(AUTHOR)).status_code == 403
    r = client.post(f"/revisions/{rev['id']}/approve", json={"comment": "ok"}, headers=H(APPROVER))
    assert r.status_code == 200, r.text
    released = r.json()
    assert released["status"] == "released" and released["released_at"]
    assert released["content_hash"] == submitted["content_hash"]

    approvals = client.get(f"/revisions/{rev['id']}/approvals", headers=H(OPERATOR)).json()
    assert [(a["approver_id"], a["decision"], a["comment"]) for a in approvals] == [(APPROVER, "approve", "ok")]

    # rev B: change_reason required, content copied
    r = client.post(f"/procedures/{proc['id']}/revisions", json={"change_reason": ""}, headers=H(AUTHOR))
    assert r.status_code == 422
    r = client.post(f"/procedures/{proc['id']}/revisions", json={}, headers=H(AUTHOR))
    assert r.status_code == 422
    r = client.post(f"/procedures/{proc['id']}/revisions", json={"change_reason": "ECO-12"}, headers=H(AUTHOR))
    assert r.status_code == 201, r.text
    rev_b = r.json()
    assert rev_b["rev"] == "B" and rev_b["content"] == edited and rev_b["change_reason"] == "ECO-12"

    # only one open revision at a time
    r = client.post(f"/procedures/{proc['id']}/revisions", json={"change_reason": "again"}, headers=H(AUTHOR))
    assert r.status_code == 409

    # clearing the change reason of a later revision is refused
    r = client.put(
        f"/revisions/{rev_b['id']}/content", json={"content": edited, "change_reason": " "}, headers=H(AUTHOR)
    )
    assert r.status_code == 422

    assert client.post(f"/revisions/{rev_b['id']}/submit", headers=H(AUTHOR)).status_code == 200
    assert client.post(f"/revisions/{rev_b['id']}/approve", json={}, headers=H(APPROVER)).status_code == 200

    detail = client.get(f"/procedures/{proc['id']}", headers=H(OPERATOR)).json()
    statuses = {r["rev"]: r["status"] for r in detail["revisions"]}
    assert statuses == {"A": "obsolete", "B": "released"}
    a = next(r for r in detail["revisions"] if r["rev"] == "A")
    assert a["obsoleted_at"]


def test_reject_returns_to_draft(client):
    rev = create(client)["revision"]
    client.post(f"/revisions/{rev['id']}/submit", headers=H(AUTHOR))
    r = client.post(f"/revisions/{rev['id']}/reject", json={}, headers=H(APPROVER))
    assert r.status_code == 422  # comment required
    r = client.post(f"/revisions/{rev['id']}/reject", json={"comment": "torque value missing"}, headers=H(APPROVER))
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "draft" and body["content_hash"] is None and body["submitted_at"] is None
    approvals = client.get(f"/revisions/{rev['id']}/approvals", headers=H(AUTHOR)).json()
    assert approvals[0]["decision"] == "reject" and approvals[0]["comment"] == "torque value missing"
    # editable again
    assert (
        client.put(f"/revisions/{rev['id']}/content", json={"content": content("v2")}, headers=H(AUTHOR)).status_code
        == 200
    )


def test_author_with_approver_role_cannot_approve_own(client):
    both = make_approver_author(client)
    rev = create(client, user=both)["revision"]
    assert client.post(f"/revisions/{rev['id']}/submit", headers=H(both)).status_code == 200
    r = client.post(f"/revisions/{rev['id']}/approve", json={}, headers=H(both))
    assert r.status_code == 403
    r = client.post(f"/revisions/{rev['id']}/reject", json={"comment": "x"}, headers=H(both))
    assert r.status_code == 403


def test_contributor_cannot_approve(client):
    both = make_approver_author(client)
    rev = create(client, user=AUTHOR)["revision"]
    # the approver-author edits Anna's draft, so they are no longer independent
    assert (
        client.put(f"/revisions/{rev['id']}/content", json={"content": content("x")}, headers=H(both)).status_code
        == 200
    )
    client.post(f"/revisions/{rev['id']}/submit", headers=H(AUTHOR))
    assert client.post(f"/revisions/{rev['id']}/approve", json={}, headers=H(both)).status_code == 403


def test_submit_rejects_unreleasable_content(client):
    bad = content(depends_on=[STEP])  # self dependency
    bad["sections"][0]["steps"][0]["locations"] = ["WS-99"]
    rev = create(client, body_content=bad)["revision"]
    r = client.post(f"/revisions/{rev['id']}/submit", headers=H(AUTHOR))
    assert r.status_code == 422
    problems = " | ".join(r.json()["detail"]["problems"])
    assert "depends on itself" in problems and "unknown workstation WS-99" in problems


def test_submit_detects_cycles_and_bad_limits(client):
    c = copy.deepcopy(DEMO_CONTENT)
    steps = c["sections"][0]["steps"]
    steps[0]["depends_on"] = [steps[1]["id"]]  # parts <-> torque cycle
    torque = steps[1]["inputs"][1]
    torque["min"], torque["max"] = "13", "12"
    rev = create(client, number="ASM-0200", body_content=c)["revision"]
    r = client.post(f"/revisions/{rev['id']}/submit", headers=H(AUTHOR))
    problems = " | ".join(r.json()["detail"]["problems"])
    assert "dependency cycle" in problems and "min is greater than max" in problems


def test_demo_content_is_releasable(client):
    rev = create(client, number="ASM-0300", body_content=DEMO_CONTENT)["revision"]
    r = client.post(f"/revisions/{rev['id']}/submit", headers=H(AUTHOR))
    assert r.status_code == 200, r.text
    assert r.json()["content_hash"] == hash_canonical(DEMO_CONTENT)


@pytest.mark.parametrize(
    "mutate",
    [
        lambda c: c["sections"][0]["steps"][0]["inputs"][0].update(
            type="number", unit="Nm", decimals=1, ocr=False, min=11.5
        ),
        lambda c: c["sections"][0]["steps"][0]["inputs"][0].update(required="yes"),
        lambda c: c["sections"][0]["steps"][0].update(unknown_field=1),
        lambda c: c["sections"][0]["steps"][0]["inputs"][0].update(type="laser"),
        lambda c: c.update(schema=2),
        lambda c: c["sections"][0]["steps"][0].update(id="NOT-A-UUID"),
        lambda c: c["sections"][0]["steps"][0]["inputs"][0].update(label="nul\u0000char"),
    ],
)
def test_content_schema_is_strict(client, mutate):
    rev = create(client)["revision"]
    c = content()
    mutate(c)
    r = client.put(f"/revisions/{rev['id']}/content", json={"content": c}, headers=H(AUTHOR))
    assert r.status_code == 422, r.text


def test_content_round_trips_exactly(client):
    # optional keys absent vs. explicitly null must survive storage: the hash covers them
    c = content()
    c["sections"][0]["steps"][0]["inputs"].append(
        {
            "id": "0192b7a0-0000-7000-8000-00000000a004",
            "type": "number",
            "label": "Gap",
            "required": True,
            "unit": "mm",
            "max": "0.2",
            "decimals": 2,
            "ocr": False,
        }
    )
    c["sections"][0]["steps"][0]["verification"] = None
    rev = create(client, body_content=c)["revision"]
    assert rev["content"] == c
    got = client.get(f"/revisions/{rev['id']}", headers=H(AUTHOR)).json()["content"]
    assert got == c and "multiline" not in got["sections"][0]["steps"][0]["inputs"][0]
    sub = client.post(f"/revisions/{rev['id']}/submit", headers=H(AUTHOR)).json()
    assert sub["content_hash"] == hash_canonical(c)


def test_drafts_hidden_from_operators(client):
    rev = create(client)["revision"]
    proc_id = rev["procedure_id"]
    assert client.get(f"/revisions/{rev['id']}", headers=H(OPERATOR)).status_code == 404
    assert client.get(f"/procedures/{proc_id}", headers=H(OPERATOR)).json()["revisions"] == []
    assert len(client.get(f"/procedures/{proc_id}", headers=H(APPROVER)).json()["revisions"]) == 1


def test_duplicate_number_conflict(client):
    create(client, number="ASM-0400")
    r = client.post("/procedures", json={"number": "ASM-0400", "title": "dup"}, headers=H(AUTHOR))
    assert r.status_code == 409


def test_list_and_get(client):
    procs = client.get("/procedures", headers=H(OPERATOR)).json()
    assert [p["number"] for p in procs] == ["ASM-0001"]
    detail = client.get(f"/procedures/{PROCEDURE_ID}", headers=H(OPERATOR)).json()
    assert detail["revisions"][0]["id"] == REVISION_ID
    assert client.get("/procedures/not-a-uuid", headers=H(OPERATOR)).status_code == 422
    assert client.get("/procedures", headers={}).status_code == 401


def test_approve_detects_content_tampering(client, db):
    from sqlalchemy import text

    rev = create(client)["revision"]
    client.post(f"/revisions/{rev['id']}/submit", headers=H(AUTHOR))
    db.execute(
        text(
            "UPDATE procedure_revisions SET content = jsonb_set(content, '{sections,0,title}', '\"X\"') WHERE id = :id"
        ),
        {"id": rev["id"]},
    )
    db.commit()
    assert client.post(f"/revisions/{rev['id']}/approve", json={}, headers=H(APPROVER)).status_code == 409
