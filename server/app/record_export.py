"""As-run record export (§10): JSON and a printable PDF.

The record is built from the ledger and the frozen revision, never from client-side state, so it is
reproducible: the same ledger always produces the same record (apart from generated_at).
"""

from __future__ import annotations

import io
import os
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from . import models
from .ledger import SHA_REF, stored_event_dicts
from .projection import analyze, iter_steps
from .serialize import approval_dict, event_dicts, ncr_dict, run_dict
from .storage import get_storage
from .timeutil import date_iso, iso, now
from .verify import verify_run


def build_record(db: Session, run: models.Run) -> dict[str, Any]:
    rev = db.get(models.ProcedureRevision, run.revision_id)
    proc = db.get(models.Procedure, run.procedure_id)
    assert rev is not None and proc is not None
    rows = list(
        db.scalars(select(models.RunEvent).where(models.RunEvent.run_id == run.id).order_by(models.RunEvent.seq))
    )
    events = event_dicts(db, rows)
    pushed_by = {r.id: r.pushed_by for r in rows}
    analysis = analyze(rev.content, stored_event_dicts(db, run.id), run.id)

    user_ids = {e["actor_id"] for e in events} | set(pushed_by.values()) | {run.created_by, rev.author_id}
    approvals = list(
        db.scalars(
            select(models.Approval).where(models.Approval.revision_id == rev.id).order_by(models.Approval.signed_at)
        )
    )
    ncr_rows = list(db.scalars(select(models.Ncr).where(models.Ncr.run_id == run.id).order_by(models.Ncr.raised_at)))
    user_ids |= {a.approver_id for a in approvals}
    for n in ncr_rows:
        user_ids |= {n.raised_by, n.dispositioned_by, n.closed_by} - {None}
    users = {u.id: u.name for u in db.scalars(select(models.User).where(models.User.id.in_(user_ids)))}

    def name(uid: str | None) -> str | None:
        return users.get(uid, uid) if uid else None

    tool_checks = {
        t.event_id: t for t in db.scalars(select(models.EventToolCheck).where(models.EventToolCheck.run_id == run.id))
    }
    present_blobs = set(
        db.scalars(
            select(models.Blob.sha256)
            .join(models.EventBlobRef, models.EventBlobRef.sha256 == models.Blob.sha256)
            .where(models.EventBlobRef.run_id == run.id)
        )
    )
    blob_mime = {b.sha256: b.mime for b in db.scalars(select(models.Blob).where(models.Blob.sha256.in_(present_blobs)))}
    by_id = {e["id"]: e for e in events}

    def input_entry(step: dict[str, Any], inp_def: dict[str, Any], st) -> dict[str, Any]:
        ist = st.inputs[inp_def["id"]]
        ev = by_id.get(ist.event["id"]) if ist.event else None
        entry: dict[str, Any] = {
            "input_id": inp_def["id"],
            "label": inp_def["label"],
            "type": inp_def["type"],
            "required": inp_def["required"],
            "value": ist.value,
            "out_of_tolerance": ist.out_of_tolerance,
            "event_id": ev["id"] if ev else None,
            "recorded_by": name(ev["actor_id"]) if ev else None,
            "recorded_at": ev["client_ts"] if ev else None,
            "auth_method": ev["auth_method"] if ev else None,
            "offline": ev["offline"] if ev else None,
            "source": ev["payload"].get("source") if ev else None,
            "flags": ev["flags"] if ev else [],
            "corrections": max(0, len(ist.live_events) - 1),
        }
        if inp_def["type"] == "number":
            entry.update(
                unit=inp_def.get("unit"), min=inp_def.get("min"), nominal=inp_def.get("nominal"), max=inp_def.get("max")
            )
            if ev and ev["payload"].get("ocr_raw") is not None:
                entry["ocr_raw"] = ev["payload"]["ocr_raw"]
        if inp_def["type"] == "photo" and isinstance(ist.value, list):
            entry["photos"] = [
                {"ref": r, "uploaded": (m.group(1) in present_blobs) if (m := SHA_REF.match(r)) else False}
                for r in ist.value
            ]
        if inp_def["type"] == "scan":
            entry["entity"] = inp_def.get("entity")
            tc = tool_checks.get(ev["id"]) if ev else None
            if tc:
                entry["tool"] = {
                    "code": tc.code,
                    "status_at_use": tc.status,
                    "calibration_due": date_iso(tc.calibration_due),
                    "checked_for": date_iso(tc.checked_for),
                }
        return entry

    steps_out = []
    for section in rev.content.get("sections", []):
        for step in section["steps"]:
            st = analysis.steps[step["id"]]
            steps_out.append(
                {
                    "section": section["title"],
                    "step_id": step["id"],
                    "title": step["title"],
                    "state": st.state,
                    "block_reasons": st.block_reasons,
                    "verification_required": bool((step.get("verification") or {}).get("required")),
                    "completed_by": name(st.completion["actor_id"]) if st.completion else None,
                    "completed_at": st.completion["client_ts"] if st.completion else None,
                    "verified_by": name(st.verification["actor_id"]) if st.verification else None,
                    "verified_at": st.verification["client_ts"] if st.verification else None,
                    "inputs": [input_entry(step, i, st) for i in step["inputs"]],
                    "open_ncr_ids": st.open_ncr_ids,
                }
            )

    tools_used = []
    parts_scanned = []
    input_defs = {i["id"]: (s, i) for s in iter_steps(rev.content) for i in s["inputs"]}
    for e in events:
        if e["type"] != "input.recorded":
            continue
        s_i = input_defs.get(e["payload"].get("input_id"))
        if not s_i or s_i[1]["type"] != "scan":
            continue
        step, inp = s_i
        base = {
            "event_id": e["id"],
            "seq": e["seq"],
            "step": step["title"],
            "label": inp["label"],
            "value": e["payload"]["value"],
            "recorded_by": name(e["actor_id"]),
            "recorded_at": e["client_ts"],
            "live": analysis.is_live(e["id"]),
        }
        tc = tool_checks.get(e["id"])
        if tc:
            tools_used.append(
                {
                    **base,
                    "code": tc.code,
                    "status_at_use": tc.status,
                    "calibration_due": date_iso(tc.calibration_due),
                    "checked_for": date_iso(tc.checked_for),
                }
            )
        else:
            parts_scanned.append({**base, "entity": inp.get("entity")})

    return {
        "generated_at": iso(now()),
        "procedure": {"id": proc.id, "number": proc.number, "title": proc.title},
        "revision": {
            "id": rev.id,
            "rev": rev.rev,
            "status": rev.status,
            "content_hash": rev.content_hash,
            "change_reason": rev.change_reason,
            "author": name(rev.author_id),
            "released_at": iso(rev.released_at),
            "approvals": [{**approval_dict(a), "approver_name": name(a.approver_id)} for a in approvals],
        },
        "run": {**run_dict(run), "created_by_name": name(run.created_by)},
        "projection": {
            "status": analysis.status,
            "can_complete": analysis.can_complete,
            "open_ncr_ids": analysis.open_ncr_ids,
        },
        "verification": verify_run(db, run),
        "steps": steps_out,
        "events": [
            {
                **e,
                "actor_name": name(e["actor_id"]),
                "pushed_by": pushed_by[e["id"]],
                "pushed_by_name": name(pushed_by[e["id"]]),
                "live": analysis.is_live(e["id"]),
            }
            for e in events
        ],
        "tools": tools_used,
        "parts": parts_scanned,
        "photos": [{"sha256": s, "mime": blob_mime.get(s)} for s in sorted(present_blobs)],
        "ncrs": [
            {
                **ncr_dict(n),
                "raised_by_name": name(n.raised_by),
                "dispositioned_by_name": name(n.dispositioned_by),
                "closed_by_name": name(n.closed_by),
            }
            for n in ncr_rows
        ],
    }


# ---------------------------------------------------------------------------
# PDF

_FONT_CANDIDATES = [
    ("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"),
    ("/usr/share/fonts/dejavu/DejaVuSans.ttf", "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf"),
]
_fonts: tuple[str, str] | None = None


def _register_fonts() -> tuple[str, str]:
    """A Unicode TTF so units (µm, Ω, °) and umlauts print; reportlab's bundled Vera as fallback."""
    global _fonts
    if _fonts:
        return _fonts
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont

    for regular, bold in _FONT_CANDIDATES:
        if os.path.exists(regular) and os.path.exists(bold):
            pdfmetrics.registerFont(TTFont("StSans", regular))
            pdfmetrics.registerFont(TTFont("StSans-Bold", bold))
            _fonts = ("StSans", "StSans-Bold")
            return _fonts
    import reportlab

    base = os.path.join(os.path.dirname(reportlab.__file__), "fonts")
    pdfmetrics.registerFont(TTFont("StSans", os.path.join(base, "Vera.ttf")))
    pdfmetrics.registerFont(TTFont("StSans-Bold", os.path.join(base, "VeraBd.ttf")))
    _fonts = ("StSans", "StSans-Bold")
    return _fonts


def _thumbnail(sha_hex: str, max_px: int = 360) -> io.BytesIO | None:
    try:
        data = get_storage().get(sha_hex)
    except Exception:
        return None
    if not data:
        return None
    try:
        from PIL import Image as PILImage

        img = PILImage.open(io.BytesIO(data))
        img.thumbnail((max_px, max_px))
        if img.mode not in ("RGB", "L"):
            img = img.convert("RGB")
        out = io.BytesIO()
        img.save(out, format="JPEG", quality=80)
        out.seek(0)
        return out
    except Exception:
        return None


def render_pdf(record: dict[str, Any], db: Session | None = None) -> bytes:
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.platypus import (
        Image,
        KeepTogether,
        LongTable,
        Paragraph,
        SimpleDocTemplate,
        Spacer,
        Table,
        TableStyle,
    )
    from reportlab.platypus.flowables import HRFlowable

    font, bold = _register_fonts()
    ss = getSampleStyleSheet()
    body = ParagraphStyle("b", parent=ss["Normal"], fontName=font, fontSize=8.5, leading=10.5)
    small = ParagraphStyle("s", parent=body, fontSize=7, leading=8.5)
    h1 = ParagraphStyle("h1", parent=body, fontName=bold, fontSize=15, leading=19, spaceAfter=4)
    h2 = ParagraphStyle("h2", parent=body, fontName=bold, fontSize=11, leading=14, spaceBefore=8, spaceAfter=4)
    h3 = ParagraphStyle("h3", parent=body, fontName=bold, fontSize=9.5, leading=12, spaceBefore=6, spaceAfter=2)

    def P(text: Any, style=body) -> Paragraph:
        s = "" if text is None else str(text)
        s = s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\n", "<br/>")
        return Paragraph(s, style)

    def B(text: Any) -> Paragraph:
        return P(text, ParagraphStyle("bb", parent=body, fontName=bold))

    grid = TableStyle(
        [
            ("FONTNAME", (0, 0), (-1, -1), font),
            ("FONTSIZE", (0, 0), (-1, -1), 8),
            ("GRID", (0, 0), (-1, -1), 0.4, colors.grey),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#e8e8e8")),
            ("LEFTPADDING", (0, 0), (-1, -1), 3),
            ("RIGHTPADDING", (0, 0), (-1, -1), 3),
        ]
    )
    kv = TableStyle(
        [
            ("FONTNAME", (0, 0), (-1, -1), font),
            ("GRID", (0, 0), (-1, -1), 0.4, colors.grey),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("BACKGROUND", (0, 0), (0, -1), colors.HexColor("#f0f0f0")),
        ]
    )

    proc, rev, run, ver = record["procedure"], record["revision"], record["run"], record["verification"]
    width = A4[0] - 30 * mm
    story: list[Any] = [
        P(f"As-run record — {proc['number']} rev {rev['rev']}", h1),
        P(proc["title"], ParagraphStyle("t", parent=body, fontSize=11, leading=14)),
        Spacer(1, 4 * mm),
    ]
    chain_text = (
        f"VERIFIED — {ver['event_count']} events, content hashes and hash chain intact"
        if ver["ok"]
        else f"FAILED at seq {ver.get('first_bad_seq')} — " + "; ".join(ver["errors"][:5])
    )
    approvals = (
        "; ".join(f"{a['decision']} by {a['approver_name']} at {_t(a['signed_at'])}" for a in rev["approvals"]) or "—"
    )
    head = [
        [B("Serial"), P(run["serial"]), B("Work order"), P(run["work_order"] or "—")],
        [B("Run status"), P(run["status"]), B("Run id"), P(run["id"], small)],
        [B("Started"), P(f"{_t(run['created_at'])} by {run['created_by_name']}"), B("Closed"), P(_t(run["closed_at"]))],
        [
            B("Revision"),
            P(f"{rev['rev']} ({rev['status']}), released {_t(rev['released_at'])}"),
            B("Author"),
            P(rev["author"]),
        ],
        [B("Content hash"), P(rev["content_hash"] or "—", small), B("Approval"), P(approvals, small)],
        [B("Ledger"), P(chain_text), B("Generated"), P(_t(record["generated_at"]))],
    ]
    t = Table(head, colWidths=[24 * mm, width / 2 - 24 * mm, 25 * mm, width / 2 - 25 * mm])
    t.setStyle(kv)
    if not ver["ok"]:
        t.setStyle(TableStyle([("BACKGROUND", (1, 5), (1, 5), colors.HexColor("#ffd6d6"))]))
    story += [t, Spacer(1, 3 * mm)]

    # Steps with recorded values
    story.append(P("Steps and recorded values", h2))
    for step in record["steps"]:
        state = step["state"] + (" — " + ", ".join(step["block_reasons"]) if step["block_reasons"] else "")
        meta = f"{step['section']} · state: {state}"
        if step["completed_by"]:
            meta += f" · completed by {step['completed_by']} at {_t(step['completed_at'])}"
        if step["verified_by"]:
            meta += f" · verified by {step['verified_by']} at {_t(step['verified_at'])}"
        elif step["verification_required"]:
            meta += " · verification required: NOT VERIFIED"
        block: list[Any] = [P(step["title"], h3), P(meta, small)]
        rows = [[B("Input"), B("Value"), B("Limits"), B("Recorded"), B("Flags")]]
        photos: list[Any] = []
        for inp in step["inputs"]:
            value = inp["value"]
            limits = ""
            if inp["type"] == "number":
                limits = f"{inp.get('min') or '−∞'} … {inp.get('max') or '+∞'} {inp.get('unit') or ''}"
                if inp.get("nominal"):
                    limits += f" (nom. {inp['nominal']})"
                if value is not None:
                    value = f"{value} {inp.get('unit') or ''}" + (
                        "  OUT OF TOLERANCE" if inp["out_of_tolerance"] else ""
                    )
                    if inp.get("ocr_raw") is not None:
                        value += f" (OCR raw: {inp['ocr_raw']})"
            elif inp["type"] == "photo" and isinstance(value, list):
                value = f"{len(value)} photo(s)" + (
                    "" if all(p["uploaded"] for p in inp.get("photos", [])) else " — not all uploaded"
                )
                for p in inp.get("photos", []):
                    m = SHA_REF.match(p["ref"])
                    thumb = _thumbnail(m.group(1)) if (m and p["uploaded"]) else None
                    if thumb:
                        img = Image(thumb)
                        scale = min(45 * mm / img.drawWidth, 45 * mm / img.drawHeight)
                        img.drawWidth *= scale
                        img.drawHeight *= scale
                        photos.append(img)
                    else:
                        photos.append(P(f"[{p['ref'][:19]}… {'unavailable' if p['uploaded'] else 'missing'}]", small))
            elif inp["type"] in ("check", "signoff"):
                value = "✓ yes" if value is True else value
            elif inp["type"] == "scan" and inp.get("tool"):
                tool = inp["tool"]
                limits = f"calibration due {tool['calibration_due'] or 'n/a'}; status at use: {tool['status_at_use']}"
            if value is None:
                value = "— (not recorded)" if inp["required"] else "—"
            rec = ""
            if inp["recorded_by"]:
                how = inp["auth_method"] + (", offline" if inp["offline"] else "")
                rec = f"{inp['recorded_by']} ({how})\n{_t(inp['recorded_at'])}"
                if inp["source"] and inp["source"] != "manual":
                    rec += f"\nsource: {inp['source']}"
                if inp["corrections"]:
                    rec += f"\n{inp['corrections']} earlier value(s) in log"
            rows.append([P(inp["label"]), P(value), P(limits, small), P(rec, small), P("\n".join(inp["flags"]), small)])
        if len(rows) > 1:
            tt = Table(rows, colWidths=[34 * mm, 38 * mm, 34 * mm, 44 * mm, width - 150 * mm], repeatRows=1)
            tt.setStyle(grid)
            for i, inp in enumerate(step["inputs"], start=1):
                if inp["out_of_tolerance"] or set(inp["flags"]) & {"tool_expired", "tool_unknown", "conflict"}:
                    tt.setStyle(TableStyle([("BACKGROUND", (0, i), (-1, i), colors.HexColor("#ffe3c4"))]))
            block.append(tt)
        if photos:
            per_row = 3
            grid_rows = [photos[i : i + per_row] for i in range(0, len(photos), per_row)]
            for r in grid_rows:
                r += [""] * (per_row - len(r))
            pt = Table(grid_rows, colWidths=[50 * mm] * per_row)
            pt.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP")]))
            block += [Spacer(1, 2 * mm), pt]
        if photos:
            story += block  # photo grids may be taller than a page; let them split
        else:
            story.append(KeepTogether(block))
        story.append(Spacer(1, 2 * mm))

    # Tools & parts
    story.append(P("Tools used (calibration status at time of use)", h2))
    if record["tools"]:
        rows = [[B("Tool"), B("Step / input"), B("Used at (device clock)"), B("Cal. due"), B("Status at use"), B("By")]]
        for tl in record["tools"]:
            rows.append(
                [
                    P(tl["code"] + ("" if tl["live"] else " (superseded)")),
                    P(f"{tl['step']} / {tl['label']}", small),
                    P(_t(tl["recorded_at"]), small),
                    P(tl["calibration_due"] or "n/a"),
                    P(tl["status_at_use"].upper() if tl["status_at_use"] != "ok" else "ok"),
                    P(tl["recorded_by"], small),
                ]
            )
        tt = LongTable(rows, colWidths=[24 * mm, 46 * mm, 34 * mm, 22 * mm, 24 * mm, width - 150 * mm], repeatRows=1)
        tt.setStyle(grid)
        story.append(tt)
    else:
        story.append(P("No tools scanned."))
    story.append(P("Parts / identifiers scanned", h2))
    if record["parts"]:
        rows = [[B("Value"), B("Step / input"), B("Scanned at"), B("By")]]
        for pt_ in record["parts"]:
            rows.append(
                [
                    P(pt_["value"] + ("" if pt_["live"] else " (superseded)")),
                    P(f"{pt_['step']} / {pt_['label']}", small),
                    P(_t(pt_["recorded_at"]), small),
                    P(pt_["recorded_by"], small),
                ]
            )
        tt = LongTable(rows, colWidths=[50 * mm, 60 * mm, 36 * mm, width - 146 * mm], repeatRows=1)
        tt.setStyle(grid)
        story.append(tt)
    else:
        story.append(P("No parts scanned."))

    # NCRs
    story.append(P("Nonconformance reports", h2))
    if record["ncrs"]:
        rows = [[B("NCR"), B("Description"), B("Raised"), B("Disposition"), B("Closed")]]
        for n in record["ncrs"]:
            disp = "—"
            if n["disposition"]:
                disp = (
                    f"{n['disposition']} by {n['dispositioned_by_name']} at {_t(n['dispositioned_at'])}"
                    f"\n{n['disposition_note'] or ''}"
                )
            rows.append(
                [
                    P(f"{n['number']}\n{n['status']}"),
                    P(n["description"], small),
                    P(f"{n['raised_by_name']}\n{_t(n['raised_at'])}", small),
                    P(disp, small),
                    P(f"{n['closed_by_name']}\n{_t(n['closed_at'])}" if n["closed_at"] else "—", small),
                ]
            )
        tt = LongTable(rows, colWidths=[28 * mm, 52 * mm, 30 * mm, 42 * mm, width - 152 * mm], repeatRows=1)
        tt.setStyle(grid)
        story.append(tt)
    else:
        story.append(P("No NCRs raised."))

    # Full event log
    story += [HRFlowable(width="100%", thickness=0.5, color=colors.grey), P("Event ledger", h2)]
    rows = [
        [B("#"), B("Type / step"), B("Actor (auth)"), B("Device time / server time (UTC)"), B("Details"), B("Flags")]
    ]
    step_titles = {s["step_id"]: s["title"] for s in record["steps"]}
    for e in record["events"]:
        actor = f"{e['actor_name']} ({e['auth_method']}{', offline' if e['offline'] else ''})"
        if e["pushed_by"] != e["actor_id"]:
            actor += f"\npushed by {e['pushed_by_name']}"
        detail = _event_detail(e)
        if e.get("supersedes"):
            detail += f"\ncorrects event {e['supersedes'][:8]}…"
        if not e["live"]:
            detail += "\n(superseded / rejected — not effective)"
        kind = e["type"] + (f"\n{step_titles.get(e['step_id'], e['step_id'])}" if e["step_id"] else "")
        rows.append(
            [
                P(e["seq"]),
                P(kind, small),
                P(actor, small),
                P(f"{_t(e['client_ts'])}\n{_t(e['server_ts'])}", small),
                P(detail, small),
                P("\n".join(e["flags"]), small),
            ]
        )
    tt = LongTable(rows, colWidths=[9 * mm, 34 * mm, 32 * mm, 38 * mm, width - 135 * mm, 22 * mm], repeatRows=1)
    tt.setStyle(grid)
    story.append(tt)
    story.append(Spacer(1, 3 * mm))
    story.append(
        P(
            "Each event's content hash is SHA-256 over its canonical JSON; the chain hash links every event to its "
            "predecessor. Head of chain: " + (record["events"][-1]["chain_hash"] if record["events"] else "—"),
            small,
        )
    )

    buf = io.BytesIO()
    title = f"{proc['number']} rev {rev['rev']} — {run['serial']}"

    def on_page(canvas, doc):
        canvas.saveState()
        canvas.setFont(font, 7)
        canvas.drawString(15 * mm, 8 * mm, f"StepTrack as-run record · {title}")
        canvas.drawRightString(A4[0] - 15 * mm, 8 * mm, f"Page {doc.page}")
        canvas.restoreState()

    doc = SimpleDocTemplate(
        buf,
        pagesize=A4,
        leftMargin=15 * mm,
        rightMargin=15 * mm,
        topMargin=14 * mm,
        bottomMargin=14 * mm,
        title=f"As-run record {title}",
        author="StepTrack",
    )
    doc.build(story, onFirstPage=on_page, onLaterPages=on_page)
    return buf.getvalue()


def _t(ts: str | None) -> str:
    return ts.replace("T", " ") if ts else "—"


def _event_detail(e: dict[str, Any]) -> str:
    p = e["payload"]
    t = e["type"]
    if t == "run.created":
        return f"serial {p['serial']}" + (f", WO {p['work_order']}" if p.get("work_order") else "")
    if t == "input.recorded":
        v = p["value"]
        if isinstance(v, list):
            v = f"{len(v)} photo(s)"
        elif v is True:
            v = "✓"
        s = f"value: {v} ({p.get('source')})"
        if p.get("ocr_raw") is not None:
            s += f", OCR raw: {p['ocr_raw']}"
        return s
    if t in ("step.reopened", "run.aborted"):
        return f"reason: {p.get('reason')}"
    if t == "note.added":
        return p.get("text", "")
    if t == "ncr.raised":
        return f"NCR raised: {p.get('description')}"
    if t == "ncr.dispositioned":
        return f"disposition: {p.get('disposition')} — {p.get('note')}"
    if t == "ncr.closed":
        return "NCR closed"
    if t == "conflict.resolved":
        kept, rejected = len(p.get("kept_event_ids", [])), len(p.get("rejected_event_ids", []))
        return f"kept {kept}, rejected {rejected}: {p.get('reason')}"
    return ""
