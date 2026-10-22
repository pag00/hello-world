import datetime as dt

UTC = dt.UTC


def now() -> dt.datetime:
    return dt.datetime.now(UTC)


def iso(ts: dt.datetime | None) -> str | None:
    """IsoTs wire format: UTC, milliseconds, 'Z'."""
    if ts is None:
        return None
    ts = ts.astimezone(UTC)
    return ts.strftime("%Y-%m-%dT%H:%M:%S.") + f"{ts.microsecond // 1000:03d}Z"


def parse_iso(s: str) -> dt.datetime:
    return dt.datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(UTC)


def date_iso(d: dt.date | None) -> str | None:
    return d.isoformat() if d else None
