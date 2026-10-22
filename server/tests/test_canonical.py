import json
from pathlib import Path

import pytest

from app.canonical import (
    GENESIS_CHAIN_HASH,
    CanonicalJsonError,
    FloatToken,
    canonical_json,
    chain_hash,
    event_content_hash,
    hash_canonical,
    loads_strict,
    sha256_ref,
)

VECTORS = json.loads((Path(__file__).resolve().parents[2] / "spec/test-vectors/canonical.json").read_text("utf-8"))


@pytest.mark.parametrize("case", VECTORS["cases"], ids=lambda c: c["name"])
def test_canonical_vectors(case):
    assert canonical_json(case["value"]) == case["canonical"]
    assert hash_canonical(case["value"]) == case["hash"]


def test_chain_vector():
    chain = VECTORS["chain"]
    assert chain["genesis"] == GENESIS_CHAIN_HASH
    prev = GENESIS_CHAIN_HASH
    for event, ch, chh in zip(chain["events"], chain["content_hashes"], chain["chain_hashes"], strict=True):
        assert event_content_hash(event) == ch
        prev = chain_hash(prev, ch)
        assert prev == chh


@pytest.mark.parametrize("case", VECTORS["rejects"], ids=lambda c: c["name"])
def test_reject_vectors(case):
    with pytest.raises(CanonicalJsonError):
        canonical_json(case["value"])


@pytest.mark.parametrize(
    "text",
    [
        '{"v": 1.5}',
        '{"v": 1.0}',  # integral float literal: TS would emit "1", Python "1.0" -> must be rejected
        '{"v": 1e3}',
        '{"v": [0, {"w": -0.0}]}',
        '{"v": NaN}',
        '{"v": Infinity}',
        '{"v": -Infinity}',
        '{"v": 9007199254740992}',
        '{"v": -9007199254740992}',
        '{"v": "\\ud800"}',  # lone surrogate cannot be UTF-8 encoded consistently
    ],
)
def test_strict_parse_rejects(text):
    with pytest.raises(CanonicalJsonError):
        canonical_json(loads_strict(text))


def test_float_token_names_path():
    with pytest.raises(CanonicalJsonError, match=r"\$\.payload\.value: 12\.5"):
        canonical_json(loads_strict('{"payload": {"value": 12.5}}'))
    assert loads_strict("[1.5]") == [FloatToken("1.5")]


def test_python_floats_and_other_types_rejected():
    for bad in (1.5, float("nan"), {1: "x"}, {"a": {1, 2}}, b"bytes"):
        with pytest.raises(CanonicalJsonError):
            canonical_json(bad)


def test_max_safe_int_allowed():
    assert canonical_json([9007199254740991, -9007199254740991]) == "[9007199254740991,-9007199254740991]"


def test_event_hash_ignores_server_fields():
    e = VECTORS["chain"]["events"][0]
    with_server = {
        **e,
        "content_hash": "x",
        "seq": 3,
        "prev_chain_hash": "y",
        "chain_hash": "z",
        "server_ts": "t",
        "flags": ["conflict"],
    }
    assert event_content_hash(with_server) == event_content_hash(e)


def test_sha256_ref_format():
    assert sha256_ref("") == "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
