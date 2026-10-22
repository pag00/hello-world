import json
from pathlib import Path

from app.main import create_app

TS_NAMES = {
    "Procedure",
    "ProcedureRevision",
    "RevisionContent",
    "Section",
    "Step",
    "CheckInput",
    "TextInput",
    "NumberInput",
    "PhotoInput",
    "ScanInput",
    "SignoffInput",
    "Run",
    "RunEvent",
    "Ncr",
    "Tool",
    "Workstation",
    "User",
    "StepLock",
    "RunCheckout",
    "PushResult",
    "PullResponse",
    "Approval",
    "PushRequest",
}


def test_schema_names_match_ts_types():
    schemas = create_app().openapi()["components"]["schemas"]
    assert set(schemas) >= TS_NAMES
    assert not [n for n in schemas if n.endswith(("-Input", "-Output"))]


def test_field_names_match_types_ts():
    s = create_app().openapi()["components"]["schemas"]
    assert set(s["RunEvent"]["properties"]) == {
        "id",
        "run_id",
        "type",
        "step_id",
        "payload",
        "actor_id",
        "auth_method",
        "device_id",
        "client_ts",
        "offline",
        "supersedes",
        "content_hash",
        "seq",
        "prev_chain_hash",
        "chain_hash",
        "server_ts",
        "flags",
    }
    assert set(s["NumberInput"]["properties"]) == {
        "id",
        "label",
        "required",
        "type",
        "unit",
        "min",
        "nominal",
        "max",
        "decimals",
        "ocr",
    }
    assert set(s["Ncr"]["properties"]) == {
        "id",
        "run_id",
        "step_id",
        "input_id",
        "number",
        "description",
        "status",
        "disposition",
        "disposition_note",
        "raised_by",
        "raised_at",
        "dispositioned_by",
        "dispositioned_at",
        "closed_by",
        "closed_at",
    }
    assert "discriminator" in s["Step"]["properties"]["inputs"]["items"]


def test_committed_openapi_is_current():
    committed = Path(__file__).resolve().parents[1] / "openapi.json"
    current = json.dumps(create_app().openapi(), indent=2, sort_keys=True, ensure_ascii=False) + "\n"
    assert committed.read_text("utf-8") == current, "run: uv run python -m app.export_openapi"
