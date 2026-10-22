"""Current user, offline PIN, dev users, user administration (§8)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .. import models
from ..auth import CurrentUser, get_current_user, make_pin_verifier, require_roles
from ..config import get_settings
from ..db import get_db, log_change
from ..deps import J, UuidPath, conflict, not_found
from ..ids import uuid7
from ..schemas import PinRequest, RolesRequest, User, UserCreate
from ..serialize import user_dict

router = APIRouter(tags=["users"])


@router.get("/me", response_model=User)
def me(cu: CurrentUser = Depends(get_current_user)):
    return J(user_dict(cu.user, cu.roles))


@router.put("/me/pin", status_code=status.HTTP_204_NO_CONTENT)
def set_pin(body: PinRequest, db: Session = Depends(get_db), cu: CurrentUser = Depends(get_current_user)):
    user = db.get(models.User, cu.id)
    assert user is not None
    user.pin_verifier = make_pin_verifier(body.pin)
    log_change(db, "user", user.id)
    db.commit()


@router.get("/auth/dev-users", response_model=list[User])
def dev_users(db: Session = Depends(get_db)):
    """Unauthenticated user picker for AUTH_MODE=dev (404 otherwise). No PIN verifiers here."""
    if get_settings().auth_mode != "dev":
        raise not_found()
    users = db.scalars(select(models.User).where(models.User.active.is_(True)).order_by(models.User.name))
    return J([{**user_dict(u), "pin_verifier": None, "email": u.email} for u in users])


@router.get("/users", response_model=list[User])
def list_users(db: Session = Depends(get_db), cu: CurrentUser = Depends(require_roles("admin"))):
    return J([user_dict(u) for u in db.scalars(select(models.User).order_by(models.User.name))])


@router.post("/users", response_model=User, status_code=status.HTTP_201_CREATED)
def create_user(body: UserCreate, db: Session = Depends(get_db), cu: CurrentUser = Depends(require_roles("admin"))):
    """Pre-provision a user (e.g. to assign roles before their first OIDC login)."""
    user = models.User(
        id=body.id or uuid7(),
        name=body.name,
        email=body.email,
        oidc_sub=body.oidc_sub,
        roles=sorted(set(body.roles)),
    )
    db.add(user)
    log_change(db, "user", user.id)
    try:
        db.commit()
    except IntegrityError as e:
        db.rollback()
        raise conflict("user id or oidc_sub already exists") from e
    return J(user_dict(user), 201)


@router.put("/users/{user_id}/roles", response_model=User)
def set_roles(
    user_id: UuidPath,
    body: RolesRequest,
    db: Session = Depends(get_db),
    cu: CurrentUser = Depends(require_roles("admin")),
):
    user = db.get(models.User, user_id)
    if user is None:
        raise not_found("user not found")
    user.roles = sorted(set(body.roles))
    log_change(db, "user", user.id)
    db.commit()
    return J(user_dict(user))
