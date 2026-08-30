from __future__ import annotations

from datetime import UTC, datetime
import hashlib
from pathlib import Path

from fastapi.testclient import TestClient

from pinqeva_google_bridge.codec import encode_base64url
from pinqeva_google_bridge.config import BridgeSettings
from pinqeva_google_bridge.main import create_app
from pinqeva_google_bridge.upstream import UpstreamReport


TOKEN = "test-service-token-with-at-least-32-chars"
IDENTITY = bytes(range(32))
ADVERTISEMENT = bytes(range(20))


class FakeAdapter:
    def __init__(self) -> None:
        self.registrations = 0
        self.report_requests = 0

    def derive_advertisement_key(self, identity_key: bytes, timestamp: int = 0) -> bytes:
        assert identity_key == IDENTITY
        assert timestamp == 0
        return ADVERTISEMENT

    def ensure_registration(self, *, identity_key: bytes, serial_number: str) -> str:
        assert identity_key == IDENTITY
        assert serial_number == "PKV-AABBCCDDEEFF"
        self.registrations += 1
        return "refreshed"

    def fetch_reports(self, *, identity_key: bytes, lookback_hours: int, requested_at):
        assert identity_key == IDENTITY
        assert lookback_hours == 24
        assert requested_at.tzinfo is not None
        self.report_requests += 1
        return [
            UpstreamReport(
                latitude=38.7223,
                longitude=-9.1393,
                confidence=4,
                status=1,
                timestamp=datetime(2026, 8, 30, 12, tzinfo=UTC),
                source_fingerprint_base64url=encode_base64url(bytes([7]) * 32),
            )
        ]

    def refresh_all(self, *, force: bool = False) -> bool:
        return force


def request_body(*, fingerprint: bytes | None = None) -> dict:
    return {
        "version": 1,
        "device_id": "550e8400-e29b-41d4-a716-446655440000",
        "serial_number": "PKV-AABBCCDDEEFF",
        "identity_key_base64url": encode_base64url(IDENTITY),
        "advertisement_key_sha256_base64url": encode_base64url(
            fingerprint or hashlib.sha256(ADVERTISEMENT).digest()
        ),
        "requested_at": "2026-08-30T13:00:00Z",
    }


def client(adapter: FakeAdapter) -> TestClient:
    settings = BridgeSettings(
        service_token=TOKEN,
        upstream_directory=Path("unused"),
    )
    return TestClient(
        create_app(settings, adapter, start_background_refresh=False)
    )


def test_registration_requires_bearer_and_validates_exact_identity() -> None:
    adapter = FakeAdapter()
    with client(adapter) as api:
        assert api.post("/v1/registrations", json=request_body()).status_code == 401
        response = api.post(
            "/v1/registrations",
            headers={"Authorization": f"Bearer {TOKEN}"},
            json=request_body(),
        )
    assert response.status_code == 200
    assert response.json() == {"status": "refreshed"}
    assert adapter.registrations == 1


def test_registration_rejects_a_fingerprint_mismatch() -> None:
    adapter = FakeAdapter()
    with client(adapter) as api:
        response = api.post(
            "/v1/registrations",
            headers={"Authorization": f"Bearer {TOKEN}"},
            json=request_body(fingerprint=bytes([9]) * 32),
        )
    assert response.status_code == 422
    assert adapter.registrations == 0


def test_reports_return_only_the_strict_coordinate_contract() -> None:
    adapter = FakeAdapter()
    payload = request_body()
    payload["lookback_hours"] = 24
    with client(adapter) as api:
        response = api.post(
            "/v1/reports",
            headers={"Authorization": f"Bearer {TOKEN}"},
            json=payload,
        )
    assert response.status_code == 200
    assert response.json() == {
        "reports": [
            {
                "latitude": 38.7223,
                "longitude": -9.1393,
                "confidence": 4,
                "status": 1,
                "timestamp": "2026-08-30T12:00:00Z",
                "source_fingerprint_base64url": encode_base64url(bytes([7]) * 32),
            }
        ]
    }
    assert adapter.report_requests == 1


def test_requests_reject_unknown_fields_and_invalid_time_windows() -> None:
    adapter = FakeAdapter()
    headers = {"Authorization": f"Bearer {TOKEN}"}
    extra = request_body()
    extra["unexpected"] = True
    invalid_window = request_body()
    invalid_window["lookback_hours"] = 0
    naive_time = request_body()
    naive_time["requested_at"] = "2026-08-30T13:00:00"

    with client(adapter) as api:
        extra_response = api.post(
            "/v1/registrations", headers=headers, json=extra
        )
        window_response = api.post(
            "/v1/reports", headers=headers, json=invalid_window
        )
        time_response = api.post(
            "/v1/registrations", headers=headers, json=naive_time
        )

    assert extra_response.status_code == 422
    assert window_response.status_code == 422
    assert time_response.status_code == 422
    assert adapter.registrations == 0
    assert adapter.report_requests == 0
