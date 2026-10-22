import base64
import hashlib

import pytest
from helpers import ADMIN, OPERATOR, H
from pydantic import ValidationError

from app.auth import check_pin, make_pin_verifier
from app.config import Settings


def test_me(client):
    me = client.get("/me", headers=H(OPERATOR)).json()
    assert me["id"] == OPERATOR and me["roles"] == ["operator"] and me["name"] == "Oskar Operator"
    assert client.get("/me").status_code == 401
    assert client.get("/me", headers={"Authorization": "Dev 0192b7a0-0000-7000-8000-00000000ffff"}).status_code == 401
    assert client.get("/me", headers={"Authorization": "Bearer abc"}).status_code == 401


def test_set_pin_verifier_format(client):
    assert client.put("/me/pin", json={"pin": "12345"}, headers=H(OPERATOR)).status_code == 422
    assert client.put("/me/pin", json={"pin": "12345a"}, headers=H(OPERATOR)).status_code == 422
    assert client.put("/me/pin", json={"pin": "1234567890123"}, headers=H(OPERATOR)).status_code == 422
    assert client.put("/me/pin", json={"pin": "654321"}, headers=H(OPERATOR)).status_code == 204
    verifier = client.get("/me", headers=H(OPERATOR)).json()["pin_verifier"]
    algo, iters, salt_b64, hash_b64 = verifier.split("$")
    assert algo == "pbkdf2-sha256" and iters == "210000"
    salt = base64.b64decode(salt_b64, validate=True)
    dk = base64.b64decode(hash_b64, validate=True)
    assert len(salt) == 16 and len(dk) == 32
    assert hashlib.pbkdf2_hmac("sha256", b"654321", salt, 210000, dklen=32) == dk
    assert check_pin("654321", verifier) and not check_pin("123456", verifier)


def test_pin_verifier_salt_random_and_padded():
    a, b = make_pin_verifier("123456"), make_pin_verifier("123456")
    assert a != b
    assert a.split("$")[2].endswith("==")  # 16 bytes -> 24 chars with padding


def test_dev_users(client):
    users = client.get("/auth/dev-users").json()
    roles = {r for u in users for r in u["roles"]}
    assert roles == {"operator", "inspector", "author", "approver", "supervisor", "admin"}
    assert all(u["pin_verifier"] is None for u in users)


def test_dev_users_404_in_oidc_mode(client, monkeypatch):
    from app.config import get_settings

    monkeypatch.setattr(get_settings(), "auth_mode", "oidc")
    assert client.get("/auth/dev-users").status_code == 404


def test_admin_user_management(client):
    assert client.get("/users", headers=H(OPERATOR)).status_code == 403
    assert len(client.get("/users", headers=H(ADMIN)).json()) == 7
    r = client.put(f"/users/{OPERATOR}/roles", json={"roles": ["operator", "inspector"]}, headers=H(ADMIN))
    assert r.status_code == 200 and r.json()["roles"] == ["inspector", "operator"]
    assert client.put(f"/users/{OPERATOR}/roles", json={"roles": ["wizard"]}, headers=H(ADMIN)).status_code == 422
    r = client.post("/users", json={"name": "New", "oidc_sub": "abc", "roles": ["author"]}, headers=H(ADMIN))
    assert r.status_code == 201
    assert client.post("/users", json={"name": "Dup", "oidc_sub": "abc"}, headers=H(ADMIN)).status_code == 409


def test_dev_auth_refused_in_production():
    with pytest.raises(ValidationError, match="AUTH_MODE=dev is not allowed"):
        Settings(env="production", auth_mode="dev")
    with pytest.raises(ValidationError, match="OIDC_ISSUER"):
        Settings(env="production", auth_mode="oidc")
    s = Settings(env="production", auth_mode="oidc", oidc_issuer="https://id.example", oidc_audience="steptrack")
    assert s.auth_mode == "oidc"


def test_tools_and_workstations_admin(client):
    t = {"code": "TW-100", "description": "Crimp tool", "calibration_due": "2030-01-01", "active": True}
    assert client.post("/tools", json=t, headers=H(OPERATOR)).status_code == 403
    r = client.post("/tools", json=t, headers=H(ADMIN))
    assert r.status_code == 201
    tool = r.json()
    assert client.post("/tools", json=t, headers=H(ADMIN)).status_code == 409
    r = client.put(f"/tools/{tool['id']}", json={**t, "calibration_due": None}, headers=H(ADMIN))
    assert r.status_code == 200 and r.json()["calibration_due"] is None
    assert any(x["code"] == "TW-100" for x in client.get("/tools", headers=H(OPERATOR)).json())
    r = client.put("/workstations/WS-09", json={"code": "WS-09", "name": "Paint"}, headers=H(ADMIN))
    assert r.status_code == 200
    assert client.put("/workstations/WS-09", json={"code": "WS-08", "name": "x"}, headers=H(ADMIN)).status_code == 409
    assert (
        client.put("/workstations/WS-10", json={"code": "WS-10", "name": "x"}, headers=H(OPERATOR)).status_code == 403
    )
    assert "WS-09" in {w["code"] for w in client.get("/workstations", headers=H(OPERATOR)).json()}


def test_health(client):
    r = client.get("/health")
    assert r.status_code == 200 and r.json()["status"] == "ok" and r.json()["database"] is True
