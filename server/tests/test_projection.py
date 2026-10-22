import copy
import json
from pathlib import Path

import pytest

from app.projection import analyze, is_out_of_tolerance, project

VECTOR_DIR = Path(__file__).resolve().parents[2] / "spec/test-vectors/projection"
VECTORS = sorted(p for p in VECTOR_DIR.glob("*.json") if not p.name.startswith("_"))


def test_vectors_found():
    assert len(VECTORS) >= 20


@pytest.mark.parametrize("path", VECTORS, ids=lambda p: p.stem)
def test_projection_vector(path):
    v = json.loads(path.read_text("utf-8"))
    p = project(v["revision_content"], v["events"])
    exp = v["expected"]
    assert p["status"] == exp["status"]
    assert p["can_complete"] == exp["can_complete"]
    assert p["open_ncr_ids"] == exp["open_ncr_ids"]
    assert set(p["steps"]) == set(exp["steps"])
    for sid, es in exp["steps"].items():
        assert p["steps"][sid]["state"] == es["state"], sid
        assert p["steps"][sid]["block_reasons"] == es["block_reasons"], sid
    for iid, value in (exp.get("input_values") or {}).items():
        values = {i: x["value"] for s in p["steps"].values() for i, x in s["inputs"].items()}
        assert values[iid] == value


@pytest.mark.parametrize("path", VECTORS, ids=lambda p: p.stem)
def test_projection_independent_of_input_order(path):
    v = json.loads(path.read_text("utf-8"))
    shuffled = list(reversed(copy.deepcopy(v["events"])))
    assert project(v["revision_content"], shuffled) == project(v["revision_content"], v["events"])


def _vec(name):
    return json.loads((VECTOR_DIR / f"{name}.json").read_text("utf-8"))


def test_projection_shape_matches_types_ts():
    v = _vec("10_full_run")
    p = project(v["revision_content"], v["events"])
    assert set(p) == {"run_id", "status", "steps", "open_ncr_ids", "can_complete"}
    step = next(iter(p["steps"].values()))
    assert set(step) == {
        "step_id",
        "state",
        "block_reasons",
        "inputs",
        "completed_by",
        "completed_at",
        "verified_by",
        "verified_at",
        "open_ncr_ids",
    }
    inp = next(iter(step["inputs"].values()))
    assert set(inp) == {"input_id", "value", "event_id", "out_of_tolerance", "competing_event_ids"}


def test_conflict_lists_competing_events():
    v = _vec("14_conflict")
    p = project(v["revision_content"], v["events"])
    b = next(s for s in p["steps"].values() if s["state"] == "conflict")
    competing = [i["competing_event_ids"] for i in b["inputs"].values() if i["competing_event_ids"]]
    assert len(competing) == 1 and len(competing[0]) == 2


def test_dependency_in_conflict_blocks_dependent():
    v = _vec("14_conflict")
    content = copy.deepcopy(v["revision_content"])
    a = content["sections"][0]["steps"][0]["id"]
    events = copy.deepcopy(v["events"])
    for e in events:
        if e["step_id"] == a and e["type"] == "step.completed":
            e["flags"] = ["conflict"]
    a_state = analyze(content, events).steps[a]
    assert a_state.state == "conflict"
    b = content["sections"][0]["steps"][1]["id"]
    assert "depends_on" in analyze(content, events).steps[b].block_reasons


def test_tolerance_decimal_semantics():
    d = {"type": "number", "min": "11.5", "max": "12.5"}
    assert not is_out_of_tolerance(d, "12.50")
    assert not is_out_of_tolerance(d, "11.500")
    assert is_out_of_tolerance(d, "12.5000001")
    assert is_out_of_tolerance(d, "garbage")
    assert not is_out_of_tolerance({"type": "number"}, "-99999")
    assert not is_out_of_tolerance({"type": "number", "min": "0"}, "0")
    assert is_out_of_tolerance({"type": "number", "min": "0"}, "-0.1")
