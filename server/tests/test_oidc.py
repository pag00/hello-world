import time

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from helpers import DEV1, run_created

from app import auth
from app.canonical import event_content_hash
from app.config import get_settings

ISSUER = "https://id.example.test/realms/steptrack"
AUDIENCE = "steptrack-api"


@pytest.fixture
def oidc(monkeypatch):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    s = get_settings()
    monkeypatch.setattr(s, "auth_mode", "oidc")
    monkeypatch.setattr(s, "oidc_issuer", ISSUER)
    monkeypatch.setattr(s, "oidc_audience", AUDIENCE)
    monkeypatch.setattr(s, "oidc_roles_claim", "realm_access.roles")
    monkeypatch.setattr(s, "oidc_jwks_url", "https://id.example.test/jwks")

    class FakeJwks:
        def get_signing_key_from_jwt(self, token):
            return type("K", (), {"key": key.public_key()})()

    monkeypatch.setattr(auth, "_jwks_client", lambda url: FakeJwks())

    def token(sub="user-1", roles=("operator",), aud=AUDIENCE, iss=ISSUER, exp_in=300, signer=key):
        claims = {
            "sub": sub,
            "iss": iss,
            "aud": aud,
            "exp": int(time.time()) + exp_in,
            "iat": int(time.time()),
            "name": "Olivia OIDC",
            "email": "olivia@example.org",
            "realm_access": {"roles": [*list(roles), "offline_access"]},
        }
        return {"Authorization": "Bearer " + jwt.encode(claims, signer, algorithm="RS256")}

    return token


def test_first_login_provisions_user_with_claim_roles(client, oidc):
    r = client.get("/me", headers=oidc())
    assert r.status_code == 200, r.text
    me = r.json()
    assert me["name"] == "Olivia OIDC" and me["roles"] == ["operator"]
    assert client.get("/me", headers=oidc()).json()["id"] == me["id"]  # same user on next login


def test_claim_roles_merge_with_db_roles(client, oidc):
    from helpers import ADMIN

    me = client.get("/me", headers=oidc()).json()
    get_settings().auth_mode = "dev"
    client.put(f"/users/{me['id']}/roles", json={"roles": ["inspector"]}, headers={"Authorization": f"Dev {ADMIN}"})
    get_settings().auth_mode = "oidc"
    assert client.get("/me", headers=oidc()).json()["roles"] == ["inspector", "operator"]


@pytest.mark.parametrize(
    "kw",
    [{"aud": "other"}, {"iss": "https://evil.example"}, {"exp_in": -10}],
)
def test_invalid_tokens_rejected(client, oidc, kw):
    assert client.get("/me", headers=oidc(**kw)).status_code == 401


def test_wrong_signature_rejected(client, oidc):
    other = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    assert client.get("/me", headers=oidc(signer=other)).status_code == 401


def test_dev_header_refused_in_oidc_mode(client, oidc):
    from helpers import OPERATOR

    assert client.get("/me", headers={"Authorization": f"Dev {OPERATOR}"}).status_code == 401


def test_oidc_push_actor_must_match_token(client, oidc):
    me = client.get("/me", headers=oidc()).json()
    e = run_created(actor=me["id"])
    r = client.post("/sync/push", json={"device_id": DEV1, "events": [e]}, headers=oidc())
    assert r.json()["results"][0]["status"] == "accepted"
    from helpers import OPERATOR

    e2 = run_created(actor=OPERATOR)
    e2["content_hash"] = event_content_hash(e2)
    r = client.post("/sync/push", json={"device_id": DEV1, "events": [e2]}, headers=oidc())
    assert "authenticated user" in r.json()["results"][0]["error"]
