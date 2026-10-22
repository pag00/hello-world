from helpers import (
    AUTHOR,
    IN_NO_DAMAGE,
    OPERATOR,
    REVISION_ID,
    STEP_PARTS,
    H,
    inp,
    new_run,
    ok,
    push_one,
)


def pull_all(client, user=OPERATOR, cursor="", limit=500):
    pages = []
    while True:
        r = client.get(f"/sync/pull?cursor={cursor}&limit={limit}", headers=H(user))
        assert r.status_code == 200, r.text
        page = r.json()
        pages.append(page)
        assert int(page["cursor"]) >= int(cursor or 0)
        cursor = page["cursor"]
        if not page["has_more"]:
            return pages, cursor


def merged(pages, key, ident="id"):
    out = {}
    for p in pages:
        for x in p[key]:
            out[x[ident]] = x
    return out


def test_initial_pull_has_everything(client):
    pages, _ = pull_all(client)
    assert len(pages) == 1
    p = pages[0]
    assert set(p) == {
        "cursor",
        "has_more",
        "procedures",
        "revisions",
        "runs",
        "events",
        "tools",
        "workstations",
        "ncrs",
        "users",
    }
    assert [r["id"] for r in p["revisions"]] == [REVISION_ID]
    assert {w["code"] for w in p["workstations"]} == {"WS-01", "WS-02", "WS-03"}
    assert {t["code"] for t in p["tools"]} == {"TW-001", "TW-002"}
    assert len(p["users"]) == 7
    assert all(u["pin_verifier"].startswith("pbkdf2-sha256$210000$") for u in p["users"])
    assert all(u["email"] is None for u in p["users"])


def test_cursor_pagination(client):
    run_id = new_run(client)
    for _ in range(4):
        ok(push_one(client, inp(run_id, STEP_PARTS, IN_NO_DAMAGE, True)))
    small, cursor = pull_all(client, limit=3)
    assert len(small) > 3 and all(p["has_more"] for p in small[:-1]) and not small[-1]["has_more"]
    big, cursor_big = pull_all(client)
    assert cursor == cursor_big
    for key in ("procedures", "revisions", "runs", "events", "tools", "workstations", "users"):
        ident = "code" if key == "workstations" else "id"
        assert merged(small, key, ident).keys() == merged(big, key, ident).keys(), key
    assert len(merged(big, "events")) == 5
    # nothing new -> empty page, cursor unchanged
    p = client.get(f"/sync/pull?cursor={cursor}", headers=H(OPERATOR)).json()
    assert p["cursor"] == cursor and not p["has_more"] and p["events"] == [] and p["runs"] == []
    # incremental: only the change since
    e = inp(run_id, STEP_PARTS, IN_NO_DAMAGE, True)
    ok(push_one(client, e))
    p = client.get(f"/sync/pull?cursor={cursor}", headers=H(OPERATOR)).json()
    assert [x["id"] for x in p["events"]] == [e["id"]] and [r["id"] for r in p["runs"]] == [run_id]
    assert p["events"][0]["seq"] == 6 and p["events"][0]["chain_hash"].startswith("sha256:")


def test_drafts_only_for_authors_and_approvers(client):
    created = client.post("/procedures", json={"number": "ASM-0500", "title": "draft"}, headers=H(AUTHOR)).json()
    draft_id = created["revision"]["id"]
    op_revs = merged(pull_all(client, OPERATOR)[0], "revisions")
    au_revs = merged(pull_all(client, AUTHOR)[0], "revisions")
    assert draft_id not in op_revs and draft_id in au_revs
    # the procedure itself is visible (number reserved), its draft isn't
    assert created["procedure"]["id"] in merged(pull_all(client, OPERATOR)[0], "procedures")


def test_invalid_cursor(client):
    assert client.get("/sync/pull?cursor=abc", headers=H(OPERATOR)).status_code == 400
