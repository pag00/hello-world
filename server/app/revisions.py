"""Revision lettering and content checks (ARCHITECTURE §3.1/§3.2)."""

from __future__ import annotations

import re
from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from . import models

# ASME Y14.35: I, O, Q, S, X and Z are not used as revision letters (confusable with digits).
REV_LETTERS = "ABCDEFGHJKLMNPRTUVWY"


def rev_letter(n: int) -> str:
    """1 -> A, 20 -> Y, 21 -> AA, ... (bijective base-20 over REV_LETTERS)."""
    if n < 1:
        raise ValueError("revision ordinal starts at 1")
    out = ""
    while n > 0:
        n -= 1
        out = REV_LETTERS[n % len(REV_LETTERS)] + out
        n //= len(REV_LETTERS)
    return out


def empty_content() -> dict[str, Any]:
    return {"schema": 1, "sections": []}


def find_nul(value: Any, path: str = "$") -> str | None:
    """Postgres JSONB cannot store U+0000; reject it in authored content instead of failing on insert."""
    if isinstance(value, str):
        return path if "\x00" in value else None
    if isinstance(value, list):
        for i, v in enumerate(value):
            p = find_nul(v, f"{path}[{i}]")
            if p:
                return p
    if isinstance(value, dict):
        for k, v in value.items():
            p = find_nul(k, path) or find_nul(v, f"{path}.{k}")
            if p:
                return p
    return None


def release_problems(db: Session, content: dict[str, Any]) -> list[str]:
    """Semantic checks run on submit (drafts only need to be schema-valid while being edited)."""
    problems: list[str] = []
    seen: set[str] = set()

    def unique(kind: str, ident: str) -> None:
        if ident in seen:
            problems.append(f"duplicate id {ident} ({kind})")
        seen.add(ident)

    steps: dict[str, dict[str, Any]] = {}
    if not content.get("sections"):
        problems.append("procedure has no sections")
    for sec in content.get("sections", []):
        unique("section", sec["id"])
        if not sec["title"].strip():
            problems.append(f"section {sec['id']}: title is empty")
        if not sec["steps"]:
            problems.append(f"section '{sec['title']}': has no steps")
        for step in sec["steps"]:
            unique("step", step["id"])
            steps[step["id"]] = step
            label = f"step '{step['title'] or step['id']}'"
            if not step["title"].strip():
                problems.append(f"step {step['id']}: title is empty")
            for inp in step["inputs"]:
                unique("input", inp["id"])
                problems += [f"{label}, input '{inp['label']}': {p}" for p in _input_problems(inp)]

    for step in steps.values():
        for dep in step["depends_on"]:
            if dep == step["id"]:
                problems.append(f"step '{step['title']}' depends on itself")
            elif dep not in steps:
                problems.append(f"step '{step['title']}' depends on unknown step {dep}")
    cycle = _find_cycle(steps)
    if cycle:
        problems.append("dependency cycle: " + " -> ".join(steps[s]["title"] for s in cycle))

    codes = {c for s in steps.values() for c in s["locations"]}
    if codes:
        known = set(db.scalars(select(models.Workstation.code).where(models.Workstation.code.in_(codes))))
        problems += [f"unknown workstation {c}" for c in sorted(codes - known)]
    media = {m.removeprefix("sha256:") for s in steps.values() for m in s["media"]}
    if media:
        present = set(db.scalars(select(models.Blob.sha256).where(models.Blob.sha256.in_(media))))
        problems += [f"reference image sha256:{m} not uploaded" for m in sorted(media - present)]
    return problems


def _input_problems(inp: dict[str, Any]) -> list[str]:
    out = []
    if not inp["label"].strip():
        out.append("label is empty")
    t = inp["type"]
    if t == "number":
        lo, nom, hi = (Decimal(inp[k]) if inp.get(k) is not None else None for k in ("min", "nominal", "max"))
        if lo is not None and hi is not None and lo > hi:
            out.append("min is greater than max")
        if nom is not None and ((lo is not None and nom < lo) or (hi is not None and nom > hi)):
            out.append("nominal is outside [min, max]")
    elif t == "photo":
        if inp["required"] and inp["min_count"] < 1:
            out.append("required photo input needs min_count >= 1")
        if inp.get("max_count") is not None and inp["max_count"] < inp["min_count"]:
            out.append("max_count is less than min_count")
    elif t == "scan":
        expect = inp.get("expect")
        if expect and len(expect) >= 2 and expect.startswith("/") and expect.rfind("/") > 0:
            try:
                re.compile(expect[1 : expect.rfind("/")])
            except re.error as e:
                out.append(f"invalid expect pattern: {e}")
    return out


def _find_cycle(steps: dict[str, dict[str, Any]]) -> list[str] | None:
    color: dict[str, int] = {}
    stack: list[str] = []

    def visit(sid: str) -> list[str] | None:
        color[sid] = 1
        stack.append(sid)
        for dep in steps[sid]["depends_on"]:
            if dep not in steps or dep == sid:
                continue
            if color.get(dep) == 1:
                return [*stack[stack.index(dep) :], dep]
            if color.get(dep) is None:
                found = visit(dep)
                if found:
                    return found
        stack.pop()
        color[sid] = 2
        return None

    for sid in steps:
        if color.get(sid) is None:
            found = visit(sid)
            if found:
                return found
    return None
