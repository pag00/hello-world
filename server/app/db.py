from __future__ import annotations

from collections.abc import Iterator
from functools import lru_cache

from sqlalchemy import Engine, create_engine, event, insert, text
from sqlalchemy.orm import Session, sessionmaker

from .config import get_settings

# Arbitrary constant key for the transaction-level advisory lock that serialises change_log inserts.
CHANGE_LOG_LOCK_KEY = 0x5354_5452  # "STTR"


@lru_cache
def get_engine() -> Engine:
    return create_engine(get_settings().sqlalchemy_url, pool_pre_ping=True, future=True)


@lru_cache
def get_sessionmaker() -> sessionmaker[Session]:
    return sessionmaker(bind=get_engine(), expire_on_commit=False, autoflush=True)


def reset_engine() -> None:
    """Drop cached engine/sessionmaker (tests switch DATABASE_URL)."""
    if get_engine.cache_info().currsize:
        get_engine().dispose()
    get_engine.cache_clear()
    get_sessionmaker.cache_clear()


def get_db() -> Iterator[Session]:
    db = get_sessionmaker()()
    try:
        yield db
    finally:
        db.close()


def log_change(db: Session, entity: str, entity_id: str) -> None:
    """Queue a change_log row; written in before_commit (see _write_change_log)."""
    db.info.setdefault("changes", []).append((entity, str(entity_id)))


@event.listens_for(Session, "before_commit")
def _write_change_log(session: Session) -> None:
    changes = session.info.pop("changes", None)
    if not changes:
        return
    from .models import ChangeLog

    session.flush()
    # change_log.id is the pull cursor. Ids come from a sequence, so without serialisation a
    # transaction holding id 10 could commit after one holding id 11, and a client that already
    # pulled past 11 would never see 10. Holding this lock from the insert until commit makes ids
    # visible in order. It is taken last in every transaction (after row locks), so no lock cycles.
    session.execute(text("SELECT pg_advisory_xact_lock(:k)"), {"k": CHANGE_LOG_LOCK_KEY})
    seen = set()
    rows = []
    for entity, entity_id in changes:
        if (entity, entity_id) in seen:
            continue
        seen.add((entity, entity_id))
        rows.append({"entity": entity, "entity_id": entity_id})
    session.execute(insert(ChangeLog), rows)


@event.listens_for(Session, "after_rollback")
def _drop_changes(session: Session) -> None:
    session.info.pop("changes", None)
