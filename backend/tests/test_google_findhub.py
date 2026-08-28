from __future__ import annotations

from datetime import UTC, datetime
from uuid import uuid4

import pytest

from app.google_findhub import GoogleFindHubBridgeClient, GoogleFindHubRequestError


class _Response:
    def __init__(self, payload: object) -> None:
        self.payload = payload

    def raise_for_status(self) -> None:
        return None

    def json(self) -> object:
        return self.payload


def _client() -> GoogleFindHubBridgeClient:
    return GoogleFindHubBridgeClient(
        base_url="https://google-bridge.test",
        service_token="service-token",
        timeout_seconds=5,
        lookback_hours=24,
    )


def test_bridge_filters_window_and_deduplicates_reports(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    report = {
        "latitude": 38.7223,
        "longitude": -9.1393,
        "confidence": 4,
        "status": 1,
        "timestamp": "2026-08-28T11:00:00Z",
    }
    monkeypatch.setattr(
        "app.google_findhub.requests.post",
        lambda *_args, **_kwargs: _Response(
            {
                "reports": [
                    report,
                    report,
                    {**report, "timestamp": "2026-08-27T10:59:59Z"},
                    {**report, "timestamp": "2026-08-28T12:06:00Z"},
                ]
            }
        ),
    )

    reports = _client().fetch_reports(
        device_id=uuid4(),
        serial_number="PKV-AABBCCDDEEFF",
        identity_key=b"i" * 32,
        advertisement_key_sha256=b"a" * 32,
        lookback_hours=24,
        now=datetime(2026, 8, 28, 12, 0, tzinfo=UTC),
    )

    assert len(reports) == 1
    assert reports[0].timestamp == datetime(2026, 8, 28, 11, 0, tzinfo=UTC)


@pytest.mark.parametrize(
    "field,value",
    [
        ("latitude", "38.7"),
        ("longitude", float("nan")),
        ("confidence", True),
        ("status", 256),
    ],
)
def test_bridge_rejects_noncanonical_or_out_of_range_values(
    monkeypatch: pytest.MonkeyPatch, field: str, value: object
) -> None:
    report = {
        "latitude": 38.7223,
        "longitude": -9.1393,
        "confidence": 4,
        "status": 1,
        "timestamp": "2026-08-28T11:00:00Z",
    }
    report[field] = value
    monkeypatch.setattr(
        "app.google_findhub.requests.post",
        lambda *_args, **_kwargs: _Response({"reports": [report]}),
    )

    with pytest.raises(GoogleFindHubRequestError):
        _client().fetch_reports(
            device_id=uuid4(),
            serial_number="PKV-AABBCCDDEEFF",
            identity_key=b"i" * 32,
            advertisement_key_sha256=b"a" * 32,
            lookback_hours=24,
            now=datetime(2026, 8, 28, 12, 0, tzinfo=UTC),
        )
