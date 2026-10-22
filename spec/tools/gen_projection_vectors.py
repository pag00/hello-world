"""Generate spec/test-vectors/projection/*.json (ARCHITECTURE §4 projection rules).

Expected results are written by hand per scenario; this script only builds events.
Each vector: {name, description, revision_content, events[], expected}.
expected = {status, can_complete, open_ncr_ids, steps: {step_id: {state, block_reasons}}, input_values?}
Events carry no content_hash (projection must not depend on it).
"""
import json
from pathlib import Path

_n = 0
NAMES: dict[str, str] = {}

def uid(name: str) -> str:
    if name not in NAMES:
        global _n
        _n += 1
        NAMES[name] = f"00000000-0000-7000-8000-{_n:012x}"
    return NAMES[name]

RUN = uid("run")
OP, INSP, SUP, OP2 = uid("user.operator"), uid("user.inspector"), uid("user.supervisor"), uid("user.operator2")
DEV, DEV2 = uid("device.1"), uid("device.2")
A, B, C = uid("step.A"), uid("step.B"), uid("step.C")
A_CHECK, A_TORQUE = uid("input.A.check"), uid("input.A.torque")
B_PHOTO, B_TOOL = uid("input.B.photo"), uid("input.B.tool")
C_SIGN = uid("input.C.signoff")
NCR1 = uid("ncr.1")
PHOTO = "sha256:" + "ab" * 32

REVISION = {
    "schema": 1,
    "sections": [
        {"id": uid("section.1"), "title": "Bulkhead", "steps": [
            {"id": A, "title": "Torque M6 bolts", "instructions": "", "media": [], "locations": ["WS-01"], "depends_on": [],
             "verification": None, "inputs": [
                {"id": A_CHECK, "type": "check", "label": "Bolts lubricated", "required": True},
                {"id": A_TORQUE, "type": "number", "label": "Torque", "required": True, "unit": "Nm",
                 "min": "11.5", "nominal": "12.0", "max": "12.5", "decimals": 1, "ocr": True},
            ]},
            {"id": B, "title": "Inspect & photograph", "instructions": "", "media": [], "locations": ["WS-01"], "depends_on": [A],
             "verification": {"required": True, "role": "inspector"}, "inputs": [
                {"id": B_PHOTO, "type": "photo", "label": "Overview", "required": True, "min_count": 1, "max_count": 3},
                {"id": B_TOOL, "type": "scan", "label": "Torque wrench", "required": True, "entity": "tool", "expect": None},
            ]},
        ]},
        {"id": uid("section.2"), "title": "Harness", "steps": [
            {"id": C, "title": "Harness routed", "instructions": "", "media": [], "locations": ["WS-02"], "depends_on": [],
             "verification": None, "inputs": [
                {"id": C_SIGN, "type": "signoff", "label": "Routed per drawing", "required": True, "role": None},
            ]},
        ]},
    ],
}

class Ev:
    def __init__(self):
        self.events = []
        self.seq = 0
        self.t = 0

    def add(self, name, type_, step=None, payload=None, actor=OP, seq=True, flags=None, supersedes=None, ts=None, device=DEV):
        self.t += 1
        e = {
            "id": uid(f"event.{name}"), "run_id": RUN, "type": type_, "step_id": step, "payload": payload or {},
            "actor_id": actor, "auth_method": "oidc", "device_id": device,
            "client_ts": ts or f"2026-10-22T10:{self.t // 60:02d}:{self.t % 60:02d}.000Z",
            "offline": not seq, "supersedes": uid(f"event.{supersedes}") if supersedes else None,
            "flags": flags or [],
        }
        if seq:
            self.seq += 1
            e["seq"] = self.seq
        else:
            e["seq"] = None
        self.events.append(e)
        return self

    def created(self):
        return self.add("created", "run.created", payload={"procedure_id": uid("proc"), "revision_id": uid("rev"), "serial": "SN-001", "work_order": None})

    def inp(self, name, step, input_id, value, **kw):
        return self.add(name, "input.recorded", step, {"input_id": input_id, "value": value, "source": "manual"}, **kw)

    def a_done(self, torque="12.0"):
        return (self.inp("a.check", A, A_CHECK, True).inp("a.torque", A, A_TORQUE, torque)
                .add("a.done", "step.completed", A))

    def b_done(self, verify=True):
        self.inp("b.photo", B, B_PHOTO, [PHOTO]).inp("b.tool", B, B_TOOL, "TW-017").add("b.done", "step.completed", B)
        if verify:
            self.add("b.verified", "step.verified", B, actor=INSP)
        return self

    def c_done(self):
        return self.inp("c.sign", C, C_SIGN, True).add("c.done", "step.completed", C)


def st(state, *reasons):
    return {"state": state, "block_reasons": sorted(reasons)}

vectors = []

def vec(name, description, ev, status, can_complete, steps, open_ncr_ids=(), input_values=None):
    v = {"name": name, "description": description, "revision_content": REVISION, "events": ev.events,
         "expected": {"status": status, "can_complete": can_complete, "open_ncr_ids": list(open_ncr_ids),
                      "steps": {A: steps[0], B: steps[1], C: steps[2]}}}
    if input_values:
        v["expected"]["input_values"] = input_values
    vectors.append(v)

vec("01_empty", "Only run.created", Ev().created(), "active", False,
    [st("pending"), st("blocked", "depends_on"), st("pending")])

vec("02_a_in_progress", "Recording an input starts the step", Ev().created().inp("a.check", A, A_CHECK, True), "active", False,
    [st("in_progress"), st("blocked", "depends_on"), st("pending")])

vec("03_a_completed", "A completed unblocks B", Ev().created().a_done(), "active", False,
    [st("completed"), st("pending"), st("pending")])

vec("04_out_of_tolerance", "Torque above max blocks A and the run", Ev().created().inp("a.torque", A, A_TORQUE, "12.6"), "blocked", False,
    [st("blocked", "out_of_tolerance"), st("blocked", "depends_on"), st("pending")],
    input_values={A_TORQUE: "12.6"})

vec("05_bounds_inclusive", "Values exactly on min/max are in tolerance; trailing zeros irrelevant",
    Ev().created().inp("a.torque", A, A_TORQUE, "12.50"), "active", False,
    [st("in_progress"), st("blocked", "depends_on"), st("pending")])

vec("06_oot_with_ncr", "NCR covering the input unblocks; open NCR prevents run completion",
    Ev().created().inp("a.check", A, A_CHECK, True).inp("a.torque", A, A_TORQUE, "13.0")
      .add("ncr", "ncr.raised", A, {"ncr_id": NCR1, "description": "Overtorqued", "input_id": A_TORQUE})
      .add("a.done", "step.completed", A).b_done().c_done(),
    "active", False, [st("completed"), st("verified"), st("completed")], open_ncr_ids=[NCR1])

vec("07_ncr_closed_full_run", "After NCR disposition + close, run can complete",
    Ev().created().inp("a.check", A, A_CHECK, True).inp("a.torque", A, A_TORQUE, "13.0")
      .add("ncr", "ncr.raised", A, {"ncr_id": NCR1, "description": "Overtorqued", "input_id": A_TORQUE})
      .add("a.done", "step.completed", A).b_done().c_done()
      .add("ncr.disp", "ncr.dispositioned", A, {"ncr_id": NCR1, "disposition": "use_as_is", "note": "within margin"}, actor=SUP)
      .add("ncr.close", "ncr.closed", A, {"ncr_id": NCR1}, actor=SUP),
    "active", True, [st("completed"), st("verified"), st("completed")])

vec("08_supersede_correction", "Correction supersedes an out-of-tolerance typo",
    Ev().created().inp("a.torque", A, A_TORQUE, "121").inp("a.torque2", A, A_TORQUE, "12.1", supersedes="a.torque"),
    "active", False, [st("in_progress"), st("blocked", "depends_on"), st("pending")],
    input_values={A_TORQUE: "12.1"})

vec("09_verification_required", "B completed but not verified -> cannot complete run",
    Ev().created().a_done().b_done(verify=False).c_done(), "active", False,
    [st("completed"), st("completed"), st("completed")])

vec("10_full_run", "Everything done and verified", Ev().created().a_done().b_done().c_done(), "active", True,
    [st("completed"), st("verified"), st("completed")])

vec("11_run_completed", "run.completed sets status; can_complete false afterwards",
    Ev().created().a_done().b_done().c_done().add("run.done", "run.completed", actor=SUP), "completed", False,
    [st("completed"), st("verified"), st("completed")])

vec("12_reopen_clears_verification", "Reopen after verify returns B to in_progress",
    Ev().created().a_done().b_done().add("b.reopen", "step.reopened", B, {"reason": "photo blurry"}, actor=SUP),
    "active", False, [st("completed"), st("in_progress"), st("pending")])

vec("13_reopen_then_recomplete", "Re-completion after reopen counts; old verification does not",
    Ev().created().a_done().b_done().add("b.reopen", "step.reopened", B, {"reason": "x"}, actor=SUP)
      .add("b.done2", "step.completed", B),
    "active", False, [st("completed"), st("completed"), st("pending")])

vec("14_conflict", "Two devices recorded the tool scan; server flagged conflict",
    Ev().created().a_done().inp("b.tool", B, B_TOOL, "TW-017").inp("b.tool.d2", B, B_TOOL, "TW-018", actor=OP2, device=DEV2, flags=["conflict", "unlocked"]),
    "blocked", False, [st("completed"), st("conflict"), st("pending")])

vec("15_conflict_resolved", "Supervisor keeps one result; rejected event is dead",
    Ev().created().a_done().inp("b.tool", B, B_TOOL, "TW-017").inp("b.tool.d2", B, B_TOOL, "TW-018", actor=OP2, device=DEV2, flags=["conflict", "unlocked"])
      .add("resolve", "conflict.resolved", B, {"kept_event_ids": [uid("event.b.tool")], "rejected_event_ids": [uid("event.b.tool.d2")], "reason": "device 2 scanned wrong wrench"}, actor=SUP),
    "active", False, [st("completed"), st("in_progress"), st("pending")],
    input_values={B_TOOL: "TW-017"})

vec("16_tool_expired", "Expired tool flagged on ingest blocks B",
    Ev().created().a_done().inp("b.tool", B, B_TOOL, "TW-017", flags=["tool_expired"]),
    "blocked", False, [st("completed"), st("blocked", "tool_expired"), st("pending")])

vec("17_tool_expired_ncr_step_level", "Step-level NCR (no input_id) covers the expired tool",
    Ev().created().a_done().inp("b.tool", B, B_TOOL, "TW-017", flags=["tool_expired"])
      .add("ncr", "ncr.raised", B, {"ncr_id": NCR1, "description": "Wrench cal expired"}),
    "active", False, [st("completed"), st("in_progress"), st("pending")], open_ncr_ids=[NCR1])

vec("18_local_events_after_seq", "Unaccepted local events order after accepted ones regardless of client_ts",
    Ev().created().a_done()
      .add("a.reopen.local", "step.reopened", A, {"reason": "recheck"}, actor=SUP, seq=False, ts="2026-10-22T09:00:00.000Z"),
    "active", False, [st("in_progress"), st("blocked", "depends_on"), st("pending")])

vec("19_aborted", "Abort wins over everything", Ev().created().inp("a.torque", A, A_TORQUE, "99").add("abort", "run.aborted", payload={"reason": "scrapped"}, actor=SUP),
    "aborted", False, [st("blocked", "out_of_tolerance"), st("blocked", "depends_on"), st("pending")])

vec("20_dependency_not_verified_ok", "depends_on only needs completed (not verified)",
    Ev().created().a_done().add("c.start", "step.started", C), "active", False,
    [st("completed"), st("pending"), st("in_progress")])

out = Path(__file__).resolve().parents[1] / "test-vectors" / "projection"
out.mkdir(parents=True, exist_ok=True)
for old in out.glob("*.json"):
    old.unlink()
for v in vectors:
    (out / f"{v['name']}.json").write_text(json.dumps(v, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
(out / "_names.json").write_text(json.dumps({v: k for k, v in NAMES.items()}, indent=2) + "\n", encoding="utf-8")
print("wrote", len(vectors), "projection vectors")
