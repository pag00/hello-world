import hashlib

from helpers import OPERATOR, H

from app.config import get_settings


def test_put_head_get(client, s3):
    data = b"\xff\xd8\xff fake jpeg"
    sha = hashlib.sha256(data).hexdigest()
    assert client.head(f"/blobs/{sha}", headers=H(OPERATOR)).status_code == 404
    r = client.put(f"/blobs/{sha}", content=data, headers={**H(OPERATOR), "Content-Type": "image/jpeg"})
    assert r.status_code == 201
    assert r.json()["size"] == len(data) and r.json()["mime"] == "image/jpeg" and r.json()["sha256"] == sha
    assert s3.client.get_object(Bucket=s3.bucket, Key=f"blobs/{sha}")["Body"].read() == data
    h = client.head(f"/blobs/{sha}", headers=H(OPERATOR))
    assert h.status_code == 200 and h.headers["content-length"] == str(len(data))
    g = client.get(f"/blobs/sha256:{sha}", headers=H(OPERATOR))
    assert g.status_code == 200 and g.content == data and g.headers["content-type"] == "image/jpeg"
    # idempotent re-upload
    assert client.put(f"/blobs/{sha}", content=data, headers=H(OPERATOR)).status_code == 200


def test_hash_mismatch_rejected(client, s3):
    data = b"abc"
    wrong = hashlib.sha256(b"abd").hexdigest()
    r = client.put(f"/blobs/{wrong}", content=data, headers=H(OPERATOR))
    assert r.status_code == 422 and "mismatch" in r.text
    assert s3.client.list_objects_v2(Bucket=s3.bucket).get("KeyCount", 0) == 0


def test_bad_hash_format_and_auth(client):
    assert client.put("/blobs/XYZ", content=b"x", headers=H(OPERATOR)).status_code == 400
    assert client.put("/blobs/" + "A" * 64, content=b"x", headers=H(OPERATOR)).status_code == 400
    sha = hashlib.sha256(b"x").hexdigest()
    assert client.put(f"/blobs/{sha}", content=b"x").status_code == 401
    assert client.get(f"/blobs/{sha}", headers=H(OPERATOR)).status_code == 404


def test_size_limit(client, monkeypatch):
    monkeypatch.setattr(get_settings(), "blob_max_bytes", 10)
    data = b"x" * 11
    r = client.put(f"/blobs/{hashlib.sha256(data).hexdigest()}", content=data, headers=H(OPERATOR))
    assert r.status_code == 413
    ok_data = b"x" * 10
    assert (
        client.put(f"/blobs/{hashlib.sha256(ok_data).hexdigest()}", content=ok_data, headers=H(OPERATOR)).status_code
        == 201
    )
