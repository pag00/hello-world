"""Authentication (ARCHITECTURE §8): dev header auth or OIDC JWT validated against the issuer's JWKS."""

from __future__ import annotations

import base64
import hashlib
import hmac
import re
import secrets
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Any

import httpx
import jwt
from fastapi import Depends, Header, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from . import models
from .config import get_settings
from .db import get_db, log_change
from .ids import uuid7
from .schemas import ROLES, UUID_RE

PIN_ITERATIONS = 210_000


@dataclass
class CurrentUser:
    user: models.User
    roles: set[str] = field(default_factory=set)

    @property
    def id(self) -> str:
        return self.user.id

    def has(self, *roles: str) -> bool:
        return any(r in self.roles for r in roles)


def _unauthorized(detail: str = "not authenticated") -> HTTPException:
    return HTTPException(status.HTTP_401_UNAUTHORIZED, detail, headers={"WWW-Authenticate": "Bearer"})


@lru_cache
def _jwks_client(url: str) -> jwt.PyJWKClient:
    return jwt.PyJWKClient(url, cache_keys=True, lifespan=3600)


@lru_cache
def _discover_jwks_url(issuer: str) -> str:
    resp = httpx.get(issuer.rstrip("/") + "/.well-known/openid-configuration", timeout=10)
    resp.raise_for_status()
    return resp.json()["jwks_uri"]


def _claim(claims: dict[str, Any], path: str) -> Any:
    # dotted paths for nested claims, e.g. Keycloak "realm_access.roles"
    cur: Any = claims
    for part in path.split("."):
        if not isinstance(cur, dict):
            return None
        cur = cur.get(part)
    return cur


def decode_oidc_token(token: str) -> dict[str, Any]:
    s = get_settings()
    jwks_url = s.oidc_jwks_url or _discover_jwks_url(s.oidc_issuer or "")
    try:
        key = _jwks_client(jwks_url).get_signing_key_from_jwt(token)
        return jwt.decode(
            token,
            key.key,
            algorithms=["RS256", "RS384", "RS512", "ES256", "ES384", "PS256"],
            audience=s.oidc_audience,
            issuer=s.oidc_issuer,
            options={"require": ["exp", "iss", "sub"]},
        )
    except jwt.PyJWTError as e:
        raise _unauthorized(f"invalid token: {e}") from e


def roles_from_claims(claims: dict[str, Any]) -> set[str]:
    raw = _claim(claims, get_settings().oidc_roles_claim)
    if isinstance(raw, str):
        raw = raw.replace(",", " ").split()
    if not isinstance(raw, list):
        return set()
    return {r for r in raw if isinstance(r, str) and r in ROLES}


def get_current_user(
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> CurrentUser:
    s = get_settings()
    if not authorization:
        raise _unauthorized()
    scheme, _, cred = authorization.partition(" ")
    cred = cred.strip()
    if s.auth_mode == "dev" and scheme == "Dev":
        user = db.get(models.User, cred) if _looks_like_uuid(cred) else None
        if user is None or not user.active:
            raise _unauthorized("unknown dev user")
        return CurrentUser(user, set(user.roles))
    if s.auth_mode == "oidc" and scheme.lower() == "bearer" and cred:
        claims = decode_oidc_token(cred)
        user = db.scalar(select(models.User).where(models.User.oidc_sub == claims["sub"]))
        if user is None:
            # first login: provision from the token; admins can add DB roles later
            user = models.User(
                id=uuid7(),
                oidc_sub=claims["sub"],
                name=claims.get("name") or claims.get("preferred_username") or claims.get("email") or claims["sub"],
                email=claims.get("email"),
                roles=[],
            )
            db.add(user)
            log_change(db, "user", user.id)
            db.commit()
        if not user.active:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "user deactivated")
        return CurrentUser(user, set(user.roles) | roles_from_claims(claims))
    raise _unauthorized("unsupported authorization scheme")


def _looks_like_uuid(s: str) -> bool:
    return re.fullmatch(UUID_RE, s) is not None


def require_roles(*roles: str):
    def dep(cu: CurrentUser = Depends(get_current_user)) -> CurrentUser:
        if not cu.has(*roles):
            raise HTTPException(status.HTTP_403_FORBIDDEN, f"requires role: {' or '.join(roles)}")
        return cu

    return dep


# ---------------------------------------------------------------------------
# Offline PIN verifier (§8): "pbkdf2-sha256$210000$<salt_b64>$<hash_b64>"


def make_pin_verifier(pin: str, *, salt: bytes | None = None, iterations: int = PIN_ITERATIONS) -> str:
    salt = salt if salt is not None else secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", pin.encode("utf-8"), salt, iterations, dklen=32)
    return f"pbkdf2-sha256${iterations}${base64.b64encode(salt).decode()}${base64.b64encode(dk).decode()}"


def check_pin(pin: str, verifier: str) -> bool:
    try:
        algo, iters, salt_b64, hash_b64 = verifier.split("$")
        if algo != "pbkdf2-sha256":
            return False
        dk = hashlib.pbkdf2_hmac("sha256", pin.encode("utf-8"), base64.b64decode(salt_b64), int(iters), dklen=32)
        return hmac.compare_digest(dk, base64.b64decode(hash_b64))
    except (ValueError, TypeError):
        return False
