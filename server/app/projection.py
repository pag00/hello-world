"""Run state as a pure projection of its event ledger (ARCHITECTURE §4 "Projection rules").

Must stay behaviour-identical to packages/core/src/domain/projection.ts; both are pinned by
spec/test-vectors/projection/*.json.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from typing import Any

SUPERVISOR_TYPES = frozenset({"step.reopened", "ncr.dispositioned", "ncr.closed", "conflict.resolved", "run.aborted"})


def order_key(e: dict[str, Any]) -> tuple:
    seq = e.get("seq")
    if seq is not None:
        return (0, seq, "", "")
    return (1, 0, e.get("client_ts") or "", e.get("id") or "")


def iter_steps(content: dict[str, Any]):
    for section in content.get("sections") or []:
        yield from section.get("steps") or []


def find_step(content: dict[str, Any], step_id: str | None) -> dict[str, Any] | None:
    if step_id is None:
        return None
    for step in iter_steps(content):
        if step.get("id") == step_id:
            return step
    return None


def find_input(step: dict[str, Any] | None, input_id: str | None) -> dict[str, Any] | None:
    if step is None or input_id is None:
        return None
    for inp in step.get("inputs") or []:
        if inp.get("id") == input_id:
            return inp
    return None


def _dec(s: Any) -> Decimal | None:
    if not isinstance(s, str):
        return None
    try:
        d = Decimal(s)
    except InvalidOperation:
        return None
    return d if d.is_finite() else None


def is_out_of_tolerance(input_def: dict[str, Any], value: Any) -> bool:
    """Decimal comparison, inclusive bounds, missing bound = unbounded. Unparseable values count as out."""
    if input_def.get("type") != "number" or value is None:
        return False
    v = _dec(value)
    if v is None:
        return True
    lo, hi = input_def.get("min"), input_def.get("max")
    if lo is not None:
        dlo = _dec(lo)
        if dlo is None or v < dlo:
            return True
    if hi is not None:
        dhi = _dec(hi)
        if dhi is None or v > dhi:
            return True
    return False


@dataclass
class NcrState:
    ncr_id: str
    step_id: str | None
    input_id: str | None
    status: str = "open"
    raised_event_id: str | None = None

    def covers(self, step_id: str, input_id: str | None) -> bool:
        return self.step_id == step_id and (self.input_id is None or self.input_id == input_id)


@dataclass
class InputState:
    input_id: str
    definition: dict[str, Any]
    event: dict[str, Any] | None = None
    live_events: list[dict[str, Any]] = field(default_factory=list)

    @property
    def value(self) -> Any:
        return self.event["payload"].get("value") if self.event else None

    @property
    def out_of_tolerance(self) -> bool:
        return self.event is not None and is_out_of_tolerance(self.definition, self.value)

    def has_flag(self, flag: str) -> bool:
        return self.event is not None and flag in (self.event.get("flags") or [])


@dataclass
class StepState:
    step_id: str
    definition: dict[str, Any]
    inputs: dict[str, InputState]
    has_live_events: bool = False
    conflict: bool = False
    completion: dict[str, Any] | None = None
    verification: dict[str, Any] | None = None
    state: str = "pending"
    block_reasons: list[str] = field(default_factory=list)
    open_ncr_ids: list[str] = field(default_factory=list)

    @property
    def completed(self) -> bool:
        return self.completion is not None

    @property
    def verified(self) -> bool:
        return self.verification is not None


@dataclass
class RunAnalysis:
    run_id: str | None
    ordered: list[dict[str, Any]]
    dead: set[str]
    steps: dict[str, StepState]
    ncrs: dict[str, NcrState]
    status: str
    can_complete: bool

    @property
    def open_ncr_ids(self) -> list[str]:
        return [n.ncr_id for n in self.ncrs.values() if n.status != "closed"]

    def is_live(self, event_id: str) -> bool:
        return event_id not in self.dead

    def to_dict(self) -> dict[str, Any]:
        steps = {}
        for sid, s in self.steps.items():
            steps[sid] = {
                "step_id": sid,
                "state": s.state,
                "block_reasons": list(s.block_reasons),
                "inputs": {
                    iid: {
                        "input_id": iid,
                        "value": inp.value,
                        "event_id": inp.event["id"] if inp.event else None,
                        "out_of_tolerance": inp.out_of_tolerance,
                        "competing_event_ids": (
                            [e["id"] for e in inp.live_events] if s.conflict and len(inp.live_events) > 1 else []
                        ),
                    }
                    for iid, inp in s.inputs.items()
                },
                "completed_by": s.completion["actor_id"] if s.completion else None,
                "completed_at": s.completion["client_ts"] if s.completion else None,
                "verified_by": s.verification["actor_id"] if s.verification else None,
                "verified_at": s.verification["client_ts"] if s.verification else None,
                "open_ncr_ids": list(s.open_ncr_ids),
            }
        return {
            "run_id": self.run_id,
            "status": self.status,
            "steps": steps,
            "open_ncr_ids": self.open_ncr_ids,
            "can_complete": self.can_complete,
        }


def analyze(content: dict[str, Any], events: list[dict[str, Any]], run_id: str | None = None) -> RunAnalysis:
    ordered = sorted(events, key=order_key)
    if run_id is None and ordered:
        run_id = ordered[0].get("run_id")

    # Rule 2: dead events. Superseded events are dead regardless of the superseder's own liveness;
    # conflict.resolved only kills when it is itself live.
    superseded = {e["supersedes"] for e in ordered if e.get("supersedes")}
    dead = set(superseded)
    for e in ordered:
        if e["type"] == "conflict.resolved" and e["id"] not in superseded:
            dead.update(e["payload"].get("rejected_event_ids") or [])
    live = [e for e in ordered if e["id"] not in dead]

    # Rule 9: NCR status
    ncrs: dict[str, NcrState] = {}
    for e in live:
        p = e.get("payload") or {}
        if e["type"] == "ncr.raised":
            ncrs[p["ncr_id"]] = NcrState(p["ncr_id"], e.get("step_id"), p.get("input_id"), "open", e["id"])
        elif e["type"] == "ncr.dispositioned" and p.get("ncr_id") in ncrs:
            if ncrs[p["ncr_id"]].status != "closed":
                ncrs[p["ncr_id"]].status = "dispositioned"
        elif e["type"] == "ncr.closed" and p.get("ncr_id") in ncrs:
            ncrs[p["ncr_id"]].status = "closed"

    steps: dict[str, StepState] = {}
    for step in iter_steps(content):
        sid = step["id"]
        inputs = {i["id"]: InputState(i["id"], i) for i in step.get("inputs") or []}
        st = StepState(sid, step, inputs)
        step_events = [(idx, e) for idx, e in enumerate(live) if e.get("step_id") == sid]
        st.has_live_events = bool(step_events)

        # Rule 3: last live input.recorded per input
        for _, e in step_events:
            if e["type"] == "input.recorded":
                inp = inputs.get((e.get("payload") or {}).get("input_id"))
                if inp is not None:
                    inp.event = e
                    inp.live_events.append(e)

        # Rule 4: conflict unless a later conflict.resolved for this step exists
        resolved_idx = [idx for idx, e in step_events if e["type"] == "conflict.resolved"]
        last_resolved = max(resolved_idx) if resolved_idx else -1
        st.conflict = any("conflict" in (e.get("flags") or []) and idx > last_resolved for idx, e in step_events)

        # Rule 5: the completion that counts is the first live step.completed after the last reopen;
        # a verification counts only after that completion.
        reopen_idx = [idx for idx, e in step_events if e["type"] == "step.reopened"]
        last_reopen = max(reopen_idx) if reopen_idx else -1
        comp = next(((idx, e) for idx, e in step_events if e["type"] == "step.completed" and idx > last_reopen), None)
        if comp is not None:
            st.completion = comp[1]
            st.verification = next(
                (e for idx, e in step_events if e["type"] == "step.verified" and idx > comp[0]), None
            )

        st.open_ncr_ids = [n.ncr_id for n in ncrs.values() if n.step_id == sid and n.status != "closed"]
        steps[sid] = st

    def covered(sid: str, iid: str | None) -> bool:
        return any(n.covers(sid, iid) for n in ncrs.values())

    # Rules 7/8. Dependency check uses completion state of the dependency (completed or verified,
    # not in conflict), which never depends on other steps' block reasons, so one pass suffices.
    def dep_done(dep_id: str) -> bool:
        d = steps.get(dep_id)
        return d is not None and d.completed and not d.conflict

    for sid, st in steps.items():
        reasons: set[str] = set()
        if not st.completed:
            if any(not dep_done(d) for d in st.definition.get("depends_on") or []):
                reasons.add("depends_on")
            for iid, inp in st.inputs.items():
                if inp.event is None or covered(sid, iid):
                    continue
                if inp.out_of_tolerance:
                    reasons.add("out_of_tolerance")
                if inp.has_flag("tool_expired"):
                    reasons.add("tool_expired")
                if inp.has_flag("tool_unknown"):
                    reasons.add("tool_unknown")
        st.block_reasons = sorted(reasons)
        if st.conflict:
            st.state = "conflict"
        elif st.verified:
            st.state = "verified"
        elif st.completed:
            st.state = "completed"
        elif reasons:
            st.state = "blocked"
        elif st.has_live_events:
            st.state = "in_progress"
        else:
            st.state = "pending"

    # Rule 10
    types_live = {e["type"] for e in live}
    if "run.aborted" in types_live:
        status = "aborted"
    elif "run.completed" in types_live:
        status = "completed"
    elif any(
        s.state == "conflict" or (s.state == "blocked" and set(s.block_reasons) - {"depends_on"})
        for s in steps.values()
    ):
        status = "blocked"
    else:
        status = "active"

    # Rule 11
    can_complete = (
        status == "active"
        and all(s.state in ("completed", "verified") for s in steps.values())
        and all(s.verified for s in steps.values() if (s.definition.get("verification") or {}).get("required"))
        and not any(n.status != "closed" for n in ncrs.values())
    )

    return RunAnalysis(run_id, ordered, dead, steps, ncrs, status, can_complete)


def project(content: dict[str, Any], events: list[dict[str, Any]], run_id: str | None = None) -> dict[str, Any]:
    """revision content + events -> RunProjection dict (types.ts shape)."""
    return analyze(content, events, run_id).to_dict()
