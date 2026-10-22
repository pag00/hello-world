"""Generate spec/test-vectors/canonical.json from the Python reference (ARCHITECTURE §5)."""
import hashlib
import json
from pathlib import Path

def canonical(obj) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)

def h(s: str) -> str:
    return "sha256:" + hashlib.sha256(s.encode("utf-8")).hexdigest()

event = {
    "id": "0192b7a0-0000-7000-8000-000000000001",
    "run_id": "0192b7a0-0000-7000-8000-0000000000aa",
    "type": "input.recorded",
    "step_id": "0192b7a0-0000-7000-8000-0000000000bb",
    "payload": {"input_id": "0192b7a0-0000-7000-8000-0000000000cc", "value": "12.50", "source": "ocr", "ocr_raw": "12.5O"},
    "actor_id": "0192b7a0-0000-7000-8000-0000000000dd",
    "auth_method": "pin",
    "device_id": "0192b7a0-0000-7000-8000-0000000000ee",
    "client_ts": "2026-10-22T10:31:05.123Z",
    "offline": True,
    "supersedes": None,
}

cases = [
    {"name": "scalars", "value": [None, True, False, 0, -1, 9007199254740991, ""]},
    {"name": "key_order", "value": {"b": 1, "a": 2, "A": 3, "_": 4, "aa": 5}},
    {"name": "escapes", "value": "quote\" backslash\\ nl\n tab\t cr\r bs\b ff\f nul\u0000 us\u001f del\u007f"},
    {"name": "unicode", "value": {"ü": "Drehmoment µ Ω 測定 🚀", "z": "é"}},
    {"name": "astral_key_order", "value": {"￿": 1, "🚀": 2, "a": 3}},
    {"name": "nested", "value": {"x": [{"b": [1, {"d": None, "c": "2"}], "a": {}}, []]}},
    {"name": "event", "value": event},
]
out = {"cases": [], "chain": None}
for c in cases:
    s = canonical(c["value"])
    out["cases"].append({**c, "canonical": s, "hash": h(s)})

# chain over the event + a second event
e2 = {**event, "id": "0192b7a0-0000-7000-8000-000000000002", "type": "step.completed", "payload": {}, "offline": False, "auth_method": "oidc"}
genesis = "sha256:" + "0" * 64
c1 = h(canonical(event)); ch1 = h(genesis + c1)
c2 = h(canonical(e2)); ch2 = h(ch1 + c2)
out["chain"] = {"events": [event, e2], "content_hashes": [c1, c2], "chain_hashes": [ch1, ch2], "genesis": genesis}
out["rejects"] = [{"name": "float", "value": {"v": 1.5}}, {"name": "big_int", "value": 9007199254740992}]

Path(__file__).resolve().parents[1].joinpath("test-vectors/canonical.json").write_text(
    json.dumps(out, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
)
print("wrote", len(out["cases"]), "cases")
