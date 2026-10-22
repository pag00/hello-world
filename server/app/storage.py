"""Content-addressed blob storage in S3 (key blobs/<sha256 hex>)."""

from __future__ import annotations

from functools import lru_cache
from typing import Any

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

from .config import get_settings


def blob_key(sha256_hex: str) -> str:
    return f"blobs/{sha256_hex}"


class BlobStorage:
    def __init__(self, client: Any, bucket: str):
        self.client = client
        self.bucket = bucket

    def ensure_bucket(self) -> None:
        try:
            self.client.head_bucket(Bucket=self.bucket)
        except ClientError:
            self.client.create_bucket(Bucket=self.bucket)

    def put(self, sha256_hex: str, data: bytes, mime: str) -> None:
        self.client.put_object(Bucket=self.bucket, Key=blob_key(sha256_hex), Body=data, ContentType=mime)

    def exists(self, sha256_hex: str) -> bool:
        try:
            self.client.head_object(Bucket=self.bucket, Key=blob_key(sha256_hex))
            return True
        except ClientError as e:
            if e.response.get("Error", {}).get("Code") in ("404", "NoSuchKey", "NotFound"):
                return False
            raise

    def get(self, sha256_hex: str) -> bytes | None:
        try:
            obj = self.client.get_object(Bucket=self.bucket, Key=blob_key(sha256_hex))
        except ClientError as e:
            if e.response.get("Error", {}).get("Code") in ("404", "NoSuchKey", "NotFound"):
                return None
            raise
        return obj["Body"].read()


@lru_cache
def get_storage() -> BlobStorage:
    s = get_settings()
    client = boto3.client(
        "s3",
        endpoint_url=s.s3_endpoint or None,
        aws_access_key_id=s.s3_access_key,
        aws_secret_access_key=s.s3_secret_key,
        region_name=s.s3_region,
        # MinIO needs path-style addressing
        config=Config(s3={"addressing_style": "path"}, signature_version="s3v4"),
    )
    return BlobStorage(client, s.s3_bucket)
