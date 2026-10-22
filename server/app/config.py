import json
from functools import lru_cache
from typing import Annotated, Literal

from pydantic import field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    env: Literal["development", "test", "staging", "production"] = "development"
    database_url: str = "postgresql+psycopg://steptrack:steptrack@localhost:5432/steptrack"

    s3_endpoint: str | None = None  # None = AWS default endpoint resolution
    s3_bucket: str = "steptrack"
    s3_access_key: str | None = None
    s3_secret_key: str | None = None
    s3_region: str = "us-east-1"
    s3_create_bucket: bool = False  # create the bucket on startup (dev / MinIO)

    blob_max_bytes: int = 25 * 1024 * 1024

    auth_mode: Literal["dev", "oidc"] = "dev"
    oidc_issuer: str | None = None
    oidc_audience: str | None = None
    oidc_roles_claim: str = "roles"
    # optional override; otherwise discovered from <issuer>/.well-known/openid-configuration
    oidc_jwks_url: str | None = None

    # comma-separated or JSON list
    cors_origins: Annotated[list[str], NoDecode] = ["http://localhost:5173", "http://localhost:8080"]

    # set when served behind a path-stripping proxy (e.g. nginx /api -> server), for correct docs URLs
    root_path: str = ""

    lock_ttl_seconds: int = 120
    checkout_default_hours: int = 12
    checkout_max_hours: int = 72

    @field_validator("cors_origins", mode="before")
    @classmethod
    def _split_origins(cls, v: object) -> object:
        if isinstance(v, str):
            v = v.strip()
            return json.loads(v) if v.startswith("[") else [o.strip() for o in v.split(",") if o.strip()]
        return v

    @model_validator(mode="after")
    def _guard(self) -> "Settings":
        if self.env == "production" and self.auth_mode == "dev":
            raise ValueError("AUTH_MODE=dev is not allowed when ENV=production")
        if self.auth_mode == "oidc" and not (self.oidc_issuer and self.oidc_audience):
            raise ValueError("AUTH_MODE=oidc requires OIDC_ISSUER and OIDC_AUDIENCE")
        return self

    @property
    def sqlalchemy_url(self) -> str:
        # accept plain postgresql:// URLs (as in docker-compose / libpq style) and use psycopg3
        url = self.database_url
        if url.startswith("postgresql://"):
            return "postgresql+psycopg://" + url[len("postgresql://") :]
        if url.startswith("postgres://"):
            return "postgresql+psycopg://" + url[len("postgres://") :]
        return url


@lru_cache
def get_settings() -> Settings:
    return Settings()
