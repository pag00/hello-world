"""Write server/openapi.json (sorted keys, stable) — input for the TS client type generation."""

import json
from pathlib import Path

from .main import create_app


def main() -> None:
    spec = create_app().openapi()
    out = Path(__file__).resolve().parents[1] / "openapi.json"
    out.write_text(json.dumps(spec, indent=2, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
