"""Canonical JSON + content hashing (ARCHITECTURE §5).

json.dumps(sort_keys, compact separators, ensure_ascii=False) yields the canonical form, but it happily
serialises floats, NaN, huge ints and lone surrogates, all of which would make Python and TS hashes
diverge. Everything is validated explicitly before dumping.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

MAX_SAFE_INT = 2**53 - 1
GENESIS_CHAIN_HASH = "sha256:" + "0" * 64
SERVER_FIELDS = ("content_hash", "seq", "prev_chain_hash", "chain_hash", "server_ts", "flags")


class CanonicalJsonError(ValueError):
    pass


class FloatToken:
    """A JSON number token that is not an integer, kept as text so the error can name it.

    Produced by `loads_strict`; any attempt to canonicalise it fails.
    """

    __slots__ = ("raw",)

    def __init__(self, raw: str):
        self.raw = raw

    def __repr__(self) -> str:
        return f"FloatToken({self.raw!r})"

    def __eq__(self, other: object) -> bool:
        return isinstance(other, FloatToken) and other.raw == self.raw

    def __hash__(self) -> int:
        return hash(self.raw)


def loads_strict(text: str | bytes) -> Any:
    """json.loads that never produces floats: non-integer numbers and NaN/Infinity become FloatToken."""
    return json.loads(text, parse_float=FloatToken, parse_constant=FloatToken)


def _check_str(s: str, path: str) -> None:
    for ch in s:
        if 0xD800 <= ord(ch) <= 0xDFFF:
            raise CanonicalJsonError(f"lone surrogate in string at {path}")


def validate(value: Any, path: str = "$") -> None:
    """Raise CanonicalJsonError if value is not representable in canonical JSON."""
    if value is None or isinstance(value, bool):
        return
    if isinstance(value, int):
        if abs(value) > MAX_SAFE_INT:
            raise CanonicalJsonError(f"integer out of range at {path}")
        return
    if isinstance(value, str):
        _check_str(value, path)
        return
    if isinstance(value, (float, FloatToken)):
        raw = value.raw if isinstance(value, FloatToken) else repr(value)
        raise CanonicalJsonError(f"float not allowed at {path}: {raw}")
    if isinstance(value, (list, tuple)):
        for i, v in enumerate(value):
            validate(v, f"{path}[{i}]")
        return
    if isinstance(value, dict):
        for k, v in value.items():
            if not isinstance(k, str):
                raise CanonicalJsonError(f"non-string key at {path}")
            _check_str(k, path)
            validate(v, f"{path}.{k}")
        return
    raise CanonicalJsonError(f"unsupported type {type(value).__name__} at {path}")


def canonical_json(value: Any) -> str:
    validate(value)
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def sha256_ref(text: str) -> str:
    return "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest()


def hash_canonical(value: Any) -> str:
    return sha256_ref(canonical_json(value))


def event_content(event: dict[str, Any]) -> dict[str, Any]:
    """The hashed part of an event: everything except content_hash and server-assigned fields."""
    return {k: v for k, v in event.items() if k not in SERVER_FIELDS}


def event_content_hash(event: dict[str, Any]) -> str:
    return hash_canonical(event_content(event))


def chain_hash(prev: str, content_hash: str) -> str:
    return sha256_ref(prev + content_hash)
