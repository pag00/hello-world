"""Test setup: real Postgres (steptrack_test, migrated with Alembic), S3 mocked with moto, dev auth."""

from __future__ import annotations

import os

os.environ.setdefault("TEST_DATABASE_URL", "postgresql+psycopg://steptrack:steptrack@localhost:5432/steptrack_test")
os.environ["DATABASE_URL"] = os.environ["TEST_DATABASE_URL"]
os.environ["ENV"] = "test"
os.environ["AUTH_MODE"] = "dev"
os.environ["S3_ENDPOINT"] = ""
os.environ["S3_BUCKET"] = "steptrack-test"
os.environ["S3_ACCESS_KEY"] = "testing"
os.environ["S3_SECRET_KEY"] = "testing"
os.environ["S3_CREATE_BUCKET"] = "false"
os.environ["AWS_ACCESS_KEY_ID"] = "testing"
os.environ["AWS_SECRET_ACCESS_KEY"] = "testing"

from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from moto import mock_aws
from sqlalchemy import create_engine, text

from app.config import get_settings
from app.db import get_sessionmaker, reset_engine
from app.storage import get_storage

SERVER_DIR = Path(__file__).resolve().parents[1]


@pytest.fixture(scope="session", autouse=True)
def migrated_db():
    get_settings.cache_clear()
    url = get_settings().sqlalchemy_url
    engine = create_engine(url)
    with engine.begin() as conn:
        conn.execute(text("DROP SCHEMA public CASCADE"))
        conn.execute(text("CREATE SCHEMA public"))
    engine.dispose()
    cfg = Config(str(SERVER_DIR / "alembic.ini"))
    cfg.set_main_option("sqlalchemy.url", url)
    command.upgrade(cfg, "head")
    reset_engine()
    yield url
    reset_engine()


TABLES = (
    "change_log, ncr_counters, tool_history, tools, workstations, blobs, step_locks, run_checkouts, "
    "event_tool_checks, event_blob_refs, ncrs, run_events, runs, approvals, procedure_revisions, procedures, users"
)


@pytest.fixture
def clean_db(migrated_db):
    from app.seed import seed

    engine = create_engine(migrated_db)
    with engine.begin() as conn:
        conn.execute(text(f"TRUNCATE {TABLES} RESTART IDENTITY CASCADE"))
    engine.dispose()
    with get_sessionmaker()() as db:
        seed(db)
    yield


@pytest.fixture
def s3():
    with mock_aws():
        get_storage.cache_clear()
        storage = get_storage()
        storage.client.create_bucket(Bucket=storage.bucket)
        yield storage
        get_storage.cache_clear()


@pytest.fixture
def client(clean_db, s3):
    from app.main import create_app

    with TestClient(create_app()) as c:
        yield c


@pytest.fixture
def db(clean_db):
    with get_sessionmaker()() as s:
        yield s
