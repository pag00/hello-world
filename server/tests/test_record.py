import contextlib
import hashlib
import io
import zlib

from helpers import (
    IN_FINAL_SIGN,
    IN_INSULATION,
    IN_PHOTO,
    IN_ROUTED,
    IN_TOOL,
    IN_TORQUE,
    INSPECTOR,
    OPERATOR,
    STEP_FINAL,
    STEP_HARNESS,
    STEP_TORQUE,
    SUPERVISOR,
    H,
    complete_parts_step,
    ev,
    inp,
    new_run,
    ok,
    push_one,
)
from PIL import Image

from app.ids import uuid7


def png_bytes(color=(200, 30, 30)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (640, 480), color).save(buf, format="PNG")
    return buf.getvalue()


def build_completed_run(client):
    photo = png_bytes()
    sha = hashlib.sha256(photo).hexdigest()
    assert (
        client.put(f"/blobs/{sha}", content=photo, headers={**H(OPERATOR), "Content-Type": "image/png"}).status_code
        == 201
    )
    run_id = new_run(client)
    complete_parts_step(client, run_id)
    ncr_id = uuid7()
    wrong = inp(run_id, STEP_TORQUE, IN_TORQUE, "12.9", "ocr")
    for e in [
        inp(run_id, STEP_TORQUE, IN_TOOL, "TW-002", "scan"),  # expired wrench -> flagged
        wrong,
        ev("ncr.raised", run_id, STEP_TORQUE, {"ncr_id": ncr_id, "description": "Overtorque and expired wrench"}),
        inp(run_id, STEP_TORQUE, IN_PHOTO, [f"sha256:{sha}"]),
        ev("step.completed", run_id, STEP_TORQUE),
        ev("step.verified", run_id, STEP_TORQUE, actor=INSPECTOR, auth="pin"),
        inp(run_id, STEP_HARNESS, IN_ROUTED, True),
        ev("step.completed", run_id, STEP_HARNESS),
        inp(run_id, STEP_FINAL, IN_INSULATION, "250"),
        inp(run_id, STEP_FINAL, IN_FINAL_SIGN, True, actor=INSPECTOR, auth="pin"),
        ev("step.completed", run_id, STEP_FINAL),
        ev(
            "ncr.dispositioned",
            run_id,
            STEP_TORQUE,
            {"ncr_id": ncr_id, "disposition": "rework", "note": "re-torque with TW-001"},
            actor=SUPERVISOR,
        ),
        ev("ncr.closed", run_id, STEP_TORQUE, {"ncr_id": ncr_id}, actor=SUPERVISOR),
        ev("run.completed", run_id, actor=SUPERVISOR),
    ]:
        ok(push_one(client, e, user=OPERATOR if e["auth_method"] == "pin" else None))
    return run_id, ncr_id, sha


def test_record_json(client):
    run_id, ncr_id, sha = build_completed_run(client)
    r = client.get(f"/runs/{run_id}/record.json", headers=H(OPERATOR))
    assert r.status_code == 200
    rec = r.json()
    assert rec["procedure"]["number"] == "ASM-0001" and rec["revision"]["rev"] == "A"
    assert rec["revision"]["content_hash"].startswith("sha256:")
    assert rec["revision"]["approvals"][0]["approver_name"] == "Arne Approver"
    assert rec["run"]["serial"] == "SN-0001" and rec["run"]["status"] == "completed"
    assert rec["verification"]["ok"] is True and rec["verification"]["event_count"] == len(rec["events"])
    torque = next(s for s in rec["steps"] if s["step_id"] == STEP_TORQUE)
    t_in = next(i for i in torque["inputs"] if i["input_id"] == IN_TORQUE)
    assert t_in["value"] == "12.9" and t_in["out_of_tolerance"] and t_in["min"] == "11.5" and t_in["max"] == "12.5"
    assert t_in["source"] == "ocr" and "out_of_tolerance" in t_in["flags"]
    assert torque["verified_by"] == "Ines Inspector"
    photo = next(i for i in torque["inputs"] if i["input_id"] == IN_PHOTO)
    assert photo["photos"] == [{"ref": f"sha256:{sha}", "uploaded": True}]
    assert rec["tools"][0]["code"] == "TW-002" and rec["tools"][0]["status_at_use"] == "expired"
    assert rec["parts"][0]["value"] == "PN-1234-0001"
    ncr = rec["ncrs"][0]
    assert ncr["id"] == ncr_id and ncr["disposition"] == "rework" and ncr["dispositioned_by_name"] == "Sven Supervisor"
    pin_events = [e for e in rec["events"] if e["auth_method"] == "pin"]
    assert pin_events and all(
        e["actor_name"] == "Ines Inspector" and e["pushed_by_name"] == "Oskar Operator" for e in pin_events
    )


def _pdf_text(pdf: bytes) -> str:
    # decompress Flate streams to search page content (reportlab compresses page streams)
    out = []
    idx = 0
    while True:
        start = pdf.find(b"stream\n", idx)
        if start < 0:
            break
        end = pdf.find(b"endstream", start)
        chunk = pdf[start + 7 : end].strip(b"\r\n")
        with contextlib.suppress(zlib.error):
            out.append(zlib.decompress(chunk).decode("latin-1"))
        idx = end + 9
    return "\n".join(out)


def test_record_pdf_renders(client):
    run_id, _, _ = build_completed_run(client)
    r = client.get(f"/runs/{run_id}/record.pdf", headers=H(OPERATOR))
    assert r.status_code == 200 and r.headers["content-type"] == "application/pdf"
    pdf = r.content
    assert pdf.startswith(b"%PDF") and pdf.rstrip().endswith(b"%%EOF")
    assert b"/Subtype /Image" in pdf  # photo thumbnail embedded
    assert pdf.count(b"/Type /Page\n") + pdf.count(b"/Type /Page ") >= 2 or b"/Count " in pdf
    assert "ASM-0001" in r.headers["content-disposition"]
    assert len(_pdf_text(pdf)) > 1000


def test_record_pdf_for_in_progress_run_with_missing_photo(client):
    run_id = new_run(client)
    ok(push_one(client, inp(run_id, STEP_TORQUE, IN_PHOTO, ["sha256:" + "cd" * 32])))
    r = client.get(f"/runs/{run_id}/record.pdf", headers=H(OPERATOR))
    assert r.status_code == 200 and r.content.startswith(b"%PDF")
    rec = client.get(f"/runs/{run_id}/record.json", headers=H(OPERATOR)).json()
    photo = next(i for s in rec["steps"] for i in s["inputs"] if i["input_id"] == IN_PHOTO)
    assert photo["photos"][0]["uploaded"] is False and "blob_missing" in photo["flags"]


def test_record_pdf_shows_failed_verification(client, db):
    from sqlalchemy import text

    run_id, _, _ = build_completed_run(client)
    db.execute(text("ALTER TABLE run_events DISABLE TRIGGER run_events_immutable"))
    db.execute(
        text("UPDATE run_events SET canonical = replace(canonical, '12.9', '12.0') WHERE run_id = :r"), {"r": run_id}
    )
    db.execute(text("ALTER TABLE run_events ENABLE TRIGGER run_events_immutable"))
    db.commit()
    rec = client.get(f"/runs/{run_id}/record.json", headers=H(OPERATOR)).json()
    assert rec["verification"]["ok"] is False
    assert client.get(f"/runs/{run_id}/record.pdf", headers=H(OPERATOR)).status_code == 200
