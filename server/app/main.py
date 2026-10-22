"""App factory."""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.openapi.utils import get_openapi
from pydantic.json_schema import models_json_schema
from sqlalchemy import text

from . import __version__
from .config import get_settings
from .db import get_sessionmaker
from .routers import blobs, procedures, registry, runs, sync, users
from .schemas import EXTRA_OPENAPI_MODELS, Health


@asynccontextmanager
async def lifespan(app: FastAPI):
    s = get_settings()
    if s.s3_create_bucket:
        from .storage import get_storage

        get_storage().ensure_bucket()
    yield


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title="StepTrack API",
        version=__version__,
        description="Procedure authoring/execution sync server. Contract: docs/ARCHITECTURE.md.",
        separate_input_output_schemas=False,
        lifespan=lifespan,
        root_path=settings.root_path,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["Content-Disposition", "ETag"],
    )

    @app.get("/health", response_model=Health, tags=["meta"])
    def health() -> dict[str, Any]:
        ok = True
        try:
            with get_sessionmaker()() as db:
                db.execute(text("SELECT 1"))
        except Exception:
            ok = False
        return {"status": "ok", "database": ok, "version": __version__}

    for r in (users.router, procedures.router, runs.router, sync.router, blobs.router, registry.router):
        app.include_router(r)

    def custom_openapi() -> dict[str, Any]:
        if app.openapi_schema:
            return app.openapi_schema
        schema = get_openapi(
            title=app.title,
            version=app.version,
            description=app.description,
            routes=app.routes,
            separate_input_output_schemas=False,
        )
        # models used by endpoints that parse raw JSON (push) aren't discovered automatically
        _, defs = models_json_schema(
            [(m, "validation") for m in EXTRA_OPENAPI_MODELS], ref_template="#/components/schemas/{model}"
        )
        comps = schema.setdefault("components", {}).setdefault("schemas", {})
        for name, s in defs.get("$defs", {}).items():
            comps.setdefault(name, s)
        app.openapi_schema = schema
        return schema

    app.openapi = custom_openapi  # type: ignore[method-assign]
    return app


app = create_app()
