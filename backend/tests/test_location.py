from __future__ import annotations

import base64
import hashlib
import json
import logging
import struct
from contextlib import asynccontextmanager
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from typing import AsyncIterator
from uuid import UUID, uuid4

import httpx
import pytest
from cryptography.hazmat.backends import default_backend
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from app.auth import Principal, authenticated_principal
from app.config import Settings
from app.crypto import (
    b64url_encode,
    encrypt_google_identity_key,
    encrypt_private_key,
    generate_finder_key_bundle,
    generate_google_finder_key_bundle,
)
from app.findmy import FindMyClient, FinderReport
from app.google_findhub import GoogleFindHubBridgeClient
from app.location import LocationError, LocationService
from app.main import app
from app.models import DeviceLocationHistoryResponse, DeviceLocationReportResponse


class _Cursor:
    def __init__(self, row: dict | list[dict] | None) -> None:
        self.row = row

    async def fetchone(self) -> dict | None:
        if isinstance(self.row, list):
            return self.row[0] if self.row else None
        return self.row

    async def fetchall(self) -> list[dict]:
        if isinstance(self.row, list):
            return self.row
        return [] if self.row is None else [self.row]


class _Connection:
    def __init__(
        self,
        *,
        binding_row: dict | None,
        accepted_row: dict | None = None,
        current_row: dict | None = None,
        history_rows: list[dict] | None = None,
    ) -> None:
        self.binding_row = binding_row
        self.accepted_row = accepted_row
        self.current_row = current_row
        self.history_rows = history_rows or []
        self.executed: list[tuple[str, tuple[object, ...]]] = []

    async def execute(
        self, query: str, parameters: tuple[object, ...] = ()
    ) -> _Cursor:
        self.executed.append((query, parameters))
        if "private_key_ciphertext" in query:
            return _Cursor(self.binding_row)
        if query.lstrip().startswith("SELECT latitude, longitude, recorded_at"):
            return _Cursor(self.history_rows)
        if query.lstrip().startswith("UPDATE public.device"):
            return _Cursor(self.accepted_row)
        return _Cursor(self.current_row)


class _Database:
    def __init__(self, connection: _Connection) -> None:
        self.connection = connection

    @asynccontextmanager
    async def transaction(self) -> AsyncIterator[_Connection]:
        yield self.connection


class _Response:
    def __init__(self, payload: object) -> None:
        self.payload = payload

    def raise_for_status(self) -> None:
        return None

    def json(self) -> object:
        return self.payload


def _settings() -> Settings:
    return Settings(
        database_url="postgresql://unused",
        supabase_jwks_url="https://example.invalid/jwks.json",
        supabase_jwt_issuer="https://example.invalid/auth/v1",
        supabase_jwt_audience="authenticated",
        supabase_jwt_algorithms=("ES256",),
        key_encryption_key=b"a" * 32,
        bootstrap_key_encryption_key=b"b" * 32,
        claim_token_key=b"c" * 32,
        session_ttl_seconds=600,
        claim_ttl_seconds=86400,
        findmy_dsid="123",
        findmy_search_party_token="search-token",
        findmy_anisette_url="http://anisette.test",
    )


def _binding_row(
    settings: Settings, *, user_id: UUID, device_id: UUID, session_id: UUID
) -> tuple[dict, bytes]:
    apple_bundle = generate_finder_key_bundle()
    apple_encrypted = encrypt_private_key(
        apple_bundle.private_key,
        settings.key_encryption_key,
        f"pinqeva:v1:{session_id}:{user_id}:{device_id}".encode("ascii"),
    )
    google_bundle = generate_google_finder_key_bundle()
    google_encrypted = encrypt_google_identity_key(
        google_bundle.identity_key,
        settings.key_encryption_key,
        f"pinqeva:google-eik:v1:{session_id}:{user_id}:{device_id}".encode(
            "ascii"
        ),
    )
    return (
        {
            "device_id": device_id,
            "serial_number": "PKV-AABBCCDDEEFF",
            "provisioning_session_id": session_id,
            "session_id": session_id,
            "finding_network": "apple",
            "private_key_ciphertext": apple_encrypted.ciphertext,
            "private_key_nonce": apple_encrypted.nonce,
            "private_key_envelope_version": apple_encrypted.version,
            "advertisement_key_sha256": apple_bundle.advertisement_key_sha256,
            "google_identity_key_ciphertext": google_encrypted.ciphertext,
            "google_identity_key_nonce": google_encrypted.nonce,
            "google_identity_key_envelope_version": google_encrypted.version,
            "google_advertisement_key_sha256": (
                google_bundle.advertisement_key_sha256
            ),
            "subscription_active": True,
        },
        apple_bundle.private_key,
    )


def _google_binding_row(
    settings: Settings, *, user_id: UUID, device_id: UUID, session_id: UUID
) -> tuple[dict, bytes]:
    google_bundle = generate_google_finder_key_bundle()
    google_encrypted = encrypt_google_identity_key(
        google_bundle.identity_key,
        settings.key_encryption_key,
        f"pinqeva:google-eik:v1:{session_id}:{user_id}:{device_id}".encode("ascii"),
    )
    apple_bundle = generate_finder_key_bundle()
    apple_encrypted = encrypt_private_key(
        apple_bundle.private_key,
        settings.key_encryption_key,
        f"pinqeva:v1:{session_id}:{user_id}:{device_id}".encode("ascii"),
    )
    return (
        {
            "device_id": device_id,
            "serial_number": "PKV-AABBCCDDEEFF",
            "provisioning_session_id": session_id,
            "session_id": session_id,
            "finding_network": "google",
            "private_key_ciphertext": apple_encrypted.ciphertext,
            "private_key_nonce": apple_encrypted.nonce,
            "private_key_envelope_version": apple_encrypted.version,
            "advertisement_key_sha256": apple_bundle.advertisement_key_sha256,
            "google_identity_key_ciphertext": google_encrypted.ciphertext,
            "google_identity_key_nonce": google_encrypted.nonce,
            "google_identity_key_envelope_version": google_encrypted.version,
            "google_advertisement_key_sha256": (
                google_bundle.advertisement_key_sha256
            ),
            "subscription_active": True,
        },
        google_bundle.identity_key,
    )


def _encoded_report(private_key: bytes, timestamp: int) -> str:
    tag_private = ec.derive_private_key(
        int.from_bytes(private_key, "big"), ec.SECP224R1(), default_backend()
    )
    ephemeral_private = ec.generate_private_key(ec.SECP224R1())
    ephemeral_public = ephemeral_private.public_key().public_bytes(
        encoding=Encoding.X962,
        format=PublicFormat.UncompressedPoint,
    )
    shared = tag_private.exchange(ec.ECDH(), ephemeral_private.public_key())
    digest = hashlib.sha256(shared + b"\x00\x00\x00\x01" + ephemeral_public).digest()
    clear = struct.pack(">iiBB", 38_722_300, -9_139_300, 3, 1)
    encryptor = Cipher(
        algorithms.AES(digest[:16]), modes.GCM(digest[16:]), default_backend()
    ).encryptor()
    encrypted = encryptor.update(clear) + encryptor.finalize()
    payload = (
        timestamp.to_bytes(4, "big")
        + b"\x00"
        + ephemeral_public
        + encrypted
        + encryptor.tag
    )
    return base64.b64encode(payload).decode("ascii")


def _install_apple_response(
    monkeypatch: pytest.MonkeyPatch,
    *,
    advertisement_hash: bytes,
    private_key: bytes,
    report_time: datetime,
) -> None:
    identifier = base64.b64encode(advertisement_hash).decode("ascii")
    apple_timestamp = int(report_time.timestamp()) - 978_307_200

    def fake_get(url: str, **_: object) -> _Response:
        assert url == "http://anisette.test"
        return _Response({"X-Apple-I-MD": "otp", "X-Apple-I-MD-M": "machine"})

    def fake_post(url: str, **kwargs: object) -> _Response:
        assert url == "https://gateway.icloud.com/findmyservice/v2/fetch"
        assert kwargs["auth"] == ("123", "search-token")
        request = kwargs["json"]
        assert isinstance(request, dict)
        assert request["fetch"][0]["primaryIds"] == [identifier]
        return _Response(
            {
                "acsnLocations": {"statusCode": "200", "locationPayload": [
                    {
                        "id": identifier,
                        "locationInfo": [_encoded_report(private_key, apple_timestamp)],
                    }
                ]}
            }
        )

    monkeypatch.setattr("app.findmy.requests.get", fake_get)
    monkeypatch.setattr("app.findmy.requests.post", fake_post)


@pytest.mark.asyncio
async def test_request_report_returns_one_tag_coordinates_as_json(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = _settings()
    service = LocationService(settings)
    user_id = uuid4()
    device_id = uuid4()
    session_id = uuid4()
    binding, private_key = _binding_row(
        settings, user_id=user_id, device_id=device_id, session_id=session_id
    )
    report_time = datetime.now(UTC).replace(microsecond=0)
    _install_apple_response(
        monkeypatch,
        advertisement_hash=binding["advertisement_key_sha256"],
        private_key=private_key,
        report_time=report_time,
    )
    accepted = {
        "device_id": device_id,
        "serial_number": binding["serial_number"],
        "last_latitude": 3.87223,
        "last_longitude": -0.91393,
        "last_location_at": report_time,
        "last_place": "3.87223, -0.91393",
    }
    database = _Database(_Connection(binding_row=binding, accepted_row=accepted))

    result = await service.request_report(
        database, user_id=user_id, device_id=device_id
    )
    payload = result.model_dump(mode="json")

    json.dumps(payload)
    assert payload["device_id"] == str(device_id)
    assert payload["serial_number"] == "PKV-AABBCCDDEEFF"
    assert payload["report_status"] == "updated"
    assert payload["latitude"] == pytest.approx(3.87223)
    assert payload["longitude"] == pytest.approx(-0.91393)
    assert payload["last_place"] == "3.87223, -0.91393"
    assert payload["confidence"] == 3
    assert payload["status_code"] == 1
    assert database.connection.executed[0][1] == (user_id, device_id)


@pytest.mark.asyncio
async def test_legacy_apple_binding_without_google_material_remains_available() -> None:
    settings = _settings()
    service = LocationService(settings)
    user_id = uuid4()
    device_id = uuid4()
    session_id = uuid4()
    binding, _private_key = _binding_row(
        settings, user_id=user_id, device_id=device_id, session_id=session_id
    )
    for field in (
        "google_identity_key_ciphertext",
        "google_identity_key_nonce",
        "google_identity_key_envelope_version",
        "google_advertisement_key_sha256",
    ):
        binding[field] = None

    loaded = await service._load_binding(
        _Database(_Connection(binding_row=binding)),
        user_id=user_id,
        device_id=device_id,
    )

    assert [provider.finding_network for provider in loaded.providers] == ["apple"]


@pytest.mark.asyncio
async def test_partial_google_binding_is_rejected() -> None:
    settings = _settings()
    service = LocationService(settings)
    user_id = uuid4()
    device_id = uuid4()
    session_id = uuid4()
    binding, _private_key = _binding_row(
        settings, user_id=user_id, device_id=device_id, session_id=session_id
    )
    binding["google_identity_key_nonce"] = None

    with pytest.raises(LocationError) as error:
        await service._load_binding(
            _Database(_Connection(binding_row=binding)),
            user_id=user_id,
            device_id=device_id,
        )

    assert error.value.code == "LOCATION_UNAVAILABLE"


@pytest.mark.asyncio
async def test_google_tag_uses_only_the_configured_find_hub_bridge(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = replace(
        _settings(),
        findmy_dsid="",
        findmy_search_party_token="",
        google_findhub_bridge_url="https://google-bridge.test",
        google_findhub_bridge_token="bridge-secret",
    )
    service = LocationService(settings)
    user_id = uuid4()
    device_id = uuid4()
    session_id = uuid4()
    binding, identity_key = _google_binding_row(
        settings, user_id=user_id, device_id=device_id, session_id=session_id
    )
    report_time = datetime.now(UTC).replace(microsecond=0)

    def fake_google_post(url: str, **kwargs: object) -> _Response:
        assert url in {
            "https://google-bridge.test/v1/registrations",
            "https://google-bridge.test/v1/reports",
        }
        headers = kwargs["headers"]
        assert isinstance(headers, dict)
        assert headers["Authorization"] == "Bearer bridge-secret"
        request = kwargs["json"]
        assert isinstance(request, dict)
        assert request["device_id"] == str(device_id)
        assert request["identity_key_base64url"] == b64url_encode(identity_key)
        assert request["advertisement_key_sha256_base64url"] == b64url_encode(
            binding["google_advertisement_key_sha256"]
        )
        if url.endswith("/v1/registrations"):
            return _Response({"status": "current"})
        return _Response(
            {
                "reports": [
                    {
                        "latitude": 38.7223,
                        "longitude": -9.1393,
                        "confidence": 4,
                        "status": 1,
                        "timestamp": report_time.isoformat().replace("+00:00", "Z"),
                    }
                ]
            }
        )

    def unexpected_apple_call(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("Google tags must never query Apple's report service")

    monkeypatch.setattr("app.google_findhub.requests.post", fake_google_post)
    monkeypatch.setattr(FindMyClient, "fetch_reports", unexpected_apple_call)
    accepted = {
        "device_id": device_id,
        "serial_number": binding["serial_number"],
        "last_latitude": 38.7223,
        "last_longitude": -9.1393,
        "last_location_at": report_time,
        "last_place": "38.72230, -9.13930",
    }
    database = _Database(_Connection(binding_row=binding, accepted_row=accepted))

    result = await service.request_report(
        database, user_id=user_id, device_id=device_id
    )

    assert result.report_status == "updated"
    assert result.latitude == pytest.approx(38.7223)
    assert result.last_location_at == report_time


@pytest.mark.asyncio
async def test_dual_provider_reports_project_the_newest_ecosystem(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = replace(
        _settings(),
        google_findhub_bridge_url="https://google-bridge.test",
        google_findhub_bridge_token="bridge-secret",
    )
    user_id = uuid4()
    device_id = uuid4()
    binding, _apple_private_key = _binding_row(
        settings, user_id=user_id, device_id=device_id, session_id=uuid4()
    )
    apple_time = datetime(2026, 8, 29, 12, 0, tzinfo=UTC)
    google_time = apple_time + timedelta(minutes=3)

    monkeypatch.setattr(
        FindMyClient,
        "fetch_reports",
        lambda *_args, **_kwargs: [
            FinderReport(38.72, -9.14, 3, 1, apple_time, b"a" * 32)
        ],
    )
    monkeypatch.setattr(
        GoogleFindHubBridgeClient,
        "fetch_reports",
        lambda *_args, **_kwargs: [
            FinderReport(38.73, -9.13, 4, 1, google_time, b"g" * 32)
        ],
    )
    connection = _Connection(
        binding_row=binding,
        accepted_row={
            "device_id": device_id,
            "serial_number": binding["serial_number"],
            "last_latitude": 38.73,
            "last_longitude": -9.13,
            "last_location_at": google_time,
            "last_place": "38.73000, -9.13000",
        },
    )

    result = await LocationService(settings).request_report(
        _Database(connection), user_id=user_id, device_id=device_id
    )

    inserts = [
        parameters
        for query, parameters in connection.executed
        if "INSERT INTO public.device_location_report" in query
    ]
    assert [parameters[2] for parameters in inserts] == ["apple", "google"]
    projection = next(
        parameters
        for query, parameters in connection.executed
        if query.lstrip().startswith("UPDATE public.device")
    )
    assert projection[0:5] == (38.73, -9.13, google_time, "38.73000, -9.13000", "google")
    assert result.last_location_at == google_time


@pytest.mark.asyncio
async def test_google_tag_fails_closed_when_bridge_is_not_configured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = replace(
        _settings(), findmy_dsid="", findmy_search_party_token=""
    )
    user_id = uuid4()
    device_id = uuid4()
    binding, _identity_key = _google_binding_row(
        settings, user_id=user_id, device_id=device_id, session_id=uuid4()
    )
    monkeypatch.setattr(
        FindMyClient,
        "fetch_latest",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("Google tags must never query Apple")
        ),
    )

    with pytest.raises(LocationError) as error:
        await LocationService(settings).request_report(
            _Database(_Connection(binding_row=binding)),
            user_id=user_id,
            device_id=device_id,
        )

    assert error.value.code == "LOCATION_UNAVAILABLE"
    assert error.value.status_code == 503


@pytest.mark.asyncio
async def test_request_report_cannot_read_a_tag_owned_by_another_user() -> None:
    settings = _settings()
    service = LocationService(settings)
    database = _Database(_Connection(binding_row=None))

    with pytest.raises(LocationError) as error:
        await service.request_report(
            database, user_id=uuid4(), device_id=uuid4()
        )

    assert error.value.status_code == 404
    assert error.value.code == "LOCATION_UNAVAILABLE"
    assert len(database.connection.executed) == 1


@pytest.mark.asyncio
async def test_no_report_returns_existing_coordinates_without_fabricating_values(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = _settings()
    service = LocationService(settings)
    user_id = uuid4()
    device_id = uuid4()
    session_id = uuid4()
    binding, _ = _binding_row(
        settings, user_id=user_id, device_id=device_id, session_id=session_id
    )
    previous_time = datetime(2026, 8, 24, 12, 0, tzinfo=UTC)
    current = {
        "device_id": device_id,
        "serial_number": binding["serial_number"],
        "last_latitude": 38.7223,
        "last_longitude": -9.13993,
        "last_location_at": previous_time,
        "last_place": "38.72230, -9.13993",
    }
    monkeypatch.setattr(FindMyClient, "fetch_reports", lambda *_args, **_kwargs: [])
    database = _Database(
        _Connection(binding_row=binding, current_row=current)
    )

    result = await service.request_report(
        database, user_id=user_id, device_id=device_id
    )
    payload = result.model_dump(mode="json")

    json.dumps(payload)
    assert payload["report_status"] == "no_report"
    assert payload["latitude"] == pytest.approx(38.7223)
    assert payload["longitude"] == pytest.approx(-9.13993)
    assert payload["last_location_at"] is not None
    assert payload["confidence"] is None
    assert payload["status_code"] is None


@pytest.mark.asyncio
async def test_location_route_returns_the_safe_json_projection(
    caplog: pytest.LogCaptureFixture,
) -> None:
    owner_id = uuid4()
    device_id = uuid4()
    device_id_value = device_id
    location_time = datetime(2026, 8, 25, 12, 0, tzinfo=UTC)

    class StubLocationService:
        async def request_report(
            self, _database: object, *, user_id: UUID, device_id: UUID
        ) -> DeviceLocationReportResponse:
            assert user_id == owner_id
            assert device_id == device_id_value
            return DeviceLocationReportResponse(
                device_id=device_id_value,
                serial_number="PKV-AABBCCDDEEFF",
                report_status="updated",
                latitude=3.87223,
                longitude=-0.91393,
                last_location_at=location_time,
                last_place="3.87223, -0.91393",
                confidence=3,
                status_code=1,
            )

    missing = object()
    original_location = getattr(app.state, "location", missing)
    original_database = getattr(app.state, "database", missing)
    app.state.location = StubLocationService()
    app.state.database = object()
    caplog.set_level(logging.INFO, logger="pinqeva.api")
    app.dependency_overrides[authenticated_principal] = lambda: Principal(
        user_id=owner_id
    )
    try:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(
            transport=transport, base_url="http://testserver"
        ) as client:
            response = await client.post(
                f"/v1/devices/{device_id}/location/report"
            )
    finally:
        app.dependency_overrides.pop(authenticated_principal, None)
        if original_location is not missing:
            app.state.location = original_location
        else:
            app.state._state.pop("location", None)
        if original_database is not missing:
            app.state.database = original_database
        else:
            app.state._state.pop("database", None)

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/json")
    payload = response.json()
    assert payload["device_id"] == str(device_id)
    assert payload["report_status"] == "updated"
    assert payload["latitude"] == pytest.approx(3.87223)
    assert payload["longitude"] == pytest.approx(-0.91393)
    assert payload["last_location_at"] == "2026-08-25T12:00:00Z"
    messages = [record.getMessage() for record in caplog.records]
    assert any(
        "location_report_request_received" in message
        and str(owner_id) in message
        and str(device_id) in message
        for message in messages
    )
    assert any(
        "location_report_request_completed" in message
        and "report_status=updated" in message
        for message in messages
    )
    assert all("3.87223" not in message and "-0.91393" not in message for message in messages)


@pytest.mark.asyncio
async def test_request_report_history_24h_returns_only_owned_tag_coordinates(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = _settings()
    service = LocationService(settings)
    user_id = uuid4()
    device_id = uuid4()
    session_id = uuid4()
    binding, _ = _binding_row(
        settings, user_id=user_id, device_id=device_id, session_id=session_id
    )
    newer = datetime(2026, 8, 25, 20, 0, tzinfo=UTC)
    older = datetime(2026, 8, 25, 19, 0, tzinfo=UTC)

    def fake_fetch_reports(*_args: object, **kwargs: object) -> list[FinderReport]:
        assert kwargs["lookback_hours"] == 24
        return [
            FinderReport(38.73, -9.13, 3, 1, newer),
            FinderReport(38.72, -9.14, 4, 1, older),
        ]

    monkeypatch.setattr(FindMyClient, "fetch_reports", fake_fetch_reports)
    database = _Database(
        _Connection(
            binding_row=binding,
            accepted_row={
                "device_id": device_id,
                "serial_number": binding["serial_number"],
                "last_latitude": 38.73,
                "last_longitude": -9.13,
                "last_location_at": newer,
                "last_place": "38.73000, -9.13000",
            },
            history_rows=[
                {"latitude": 38.73, "longitude": -9.13, "recorded_at": newer},
                {"latitude": 38.72, "longitude": -9.14, "recorded_at": older},
            ],
        )
    )
    result = await service.request_report_history_24h(
        database, user_id=user_id, device_id=device_id
    )
    payload = result.model_dump(mode="json")

    json.dumps(payload)
    assert payload == {
        "device_id": str(device_id),
        "locations": [
            {
                "latitude": 38.73,
                "longitude": -9.13,
                "recorded_at": "2026-08-25T20:00:00Z",
            },
            {
                "latitude": 38.72,
                "longitude": -9.14,
                "recorded_at": "2026-08-25T19:00:00Z",
            },
        ],
    }
    assert database.connection.executed[0][1] == (user_id, device_id)


@pytest.mark.asyncio
async def test_report_history_24h_cannot_read_another_users_tag(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    called = False

    def unexpected_fetch(*_args: object, **_kwargs: object) -> list[FinderReport]:
        nonlocal called
        called = True
        return []

    monkeypatch.setattr(FindMyClient, "fetch_reports", unexpected_fetch)
    database = _Database(_Connection(binding_row=None))
    with pytest.raises(LocationError) as error:
        await LocationService(_settings()).request_report_history_24h(
            database, user_id=uuid4(), device_id=uuid4()
        )

    assert error.value.status_code == 404
    assert error.value.code == "LOCATION_UNAVAILABLE"
    assert called is False


@pytest.mark.asyncio
async def test_cloud_location_requires_subscription_without_tag_state() -> None:
    settings = _settings()
    user_id = uuid4()
    device_id = uuid4()
    binding, _ = _binding_row(
        settings, user_id=user_id, device_id=device_id, session_id=uuid4()
    )
    binding["subscription_active"] = False
    database = _Database(_Connection(binding_row=binding))

    with pytest.raises(LocationError) as error:
        await LocationService(settings).request_report(
            database, user_id=user_id, device_id=device_id
        )

    assert error.value.code == "PREMIUM_SUBSCRIPTION_REQUIRED"
    assert error.value.status_code == 402
    binding_query = database.connection.executed[0][0]
    assert "public.subscription" in binding_query
    assert "device_entitlement_sync" not in binding_query


@pytest.mark.asyncio
async def test_premium_history_supports_thirty_days_and_persists_reports(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = _settings()
    user_id = uuid4()
    device_id = uuid4()
    binding, _ = _binding_row(
        settings, user_id=user_id, device_id=device_id, session_id=uuid4()
    )
    current = datetime.now(UTC)
    provider_reported_at = current - timedelta(days=1)
    retained_at = current - timedelta(days=20)

    def fake_fetch_reports(*_args: object, **kwargs: object) -> list[FinderReport]:
        assert kwargs["lookback_hours"] == 7 * 24
        return [FinderReport(38.72, -9.14, 4, 1, provider_reported_at)]

    monkeypatch.setattr(FindMyClient, "fetch_reports", fake_fetch_reports)
    database = _Database(
        _Connection(
            binding_row=binding,
            accepted_row={
                "device_id": device_id,
                "serial_number": binding["serial_number"],
                "last_latitude": 38.72,
                "last_longitude": -9.14,
                "last_location_at": provider_reported_at,
                "last_place": "38.72000, -9.14000",
            },
            history_rows=[
                {
                    "latitude": 38.72,
                    "longitude": -9.14,
                    "recorded_at": retained_at,
                }
            ],
        )
    )

    result = await LocationService(settings).request_report_history(
        database,
        user_id=user_id,
        device_id=device_id,
        days=30,
    )

    assert len(result.locations) == 1
    assert result.locations[0].recorded_at == retained_at
    history_inserts = [
        query
        for query, _parameters in database.connection.executed
        if "INSERT INTO public.device_location_report" in query
    ]
    assert len(history_inserts) == 1
    history_reads = [
        (query, parameters)
        for query, parameters in database.connection.executed
        if query.lstrip().startswith("SELECT latitude, longitude, recorded_at")
    ]
    assert len(history_reads) == 1
    assert "provisioning_session_id = %s" in history_reads[0][0]


@pytest.mark.asyncio
async def test_unsorted_provider_batch_is_stored_oldest_first_and_projects_newest(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = _settings()
    user_id = uuid4()
    device_id = uuid4()
    binding, _ = _binding_row(
        settings, user_id=user_id, device_id=device_id, session_id=uuid4()
    )
    older = datetime(2026, 8, 29, 10, 0, tzinfo=UTC)
    newer = datetime(2026, 8, 29, 11, 0, tzinfo=UTC)
    monkeypatch.setattr(
        FindMyClient,
        "fetch_reports",
        lambda *_args, **_kwargs: [
            FinderReport(38.73, -9.13, 4, 1, newer, b"n" * 32),
            FinderReport(38.72, -9.14, 3, 1, older, b"o" * 32),
        ],
    )
    connection = _Connection(
        binding_row=binding,
        accepted_row={
            "device_id": device_id,
            "serial_number": binding["serial_number"],
            "last_latitude": 38.73,
            "last_longitude": -9.13,
            "last_location_at": newer,
            "last_place": "38.73000, -9.13000",
        },
    )

    result = await LocationService(settings).request_report(
        _Database(connection), user_id=user_id, device_id=device_id
    )

    inserts = [
        parameters
        for query, parameters in connection.executed
        if "INSERT INTO public.device_location_report" in query
    ]
    assert [parameters[9] for parameters in inserts] == [older, newer]
    assert inserts[0][3] == b"o" * 32
    assert inserts[1][3] == b"n" * 32
    assert result.last_location_at == newer
    projection_update = next(
        parameters
        for query, parameters in connection.executed
        if query.lstrip().startswith("UPDATE public.device")
    )
    assert projection_update[0:3] == (38.73, -9.13, newer)


@pytest.mark.asyncio
async def test_history_window_is_bounded_before_any_database_or_provider_call() -> None:
    database = _Database(_Connection(binding_row=None))
    with pytest.raises(LocationError) as error:
        await LocationService(_settings()).request_report_history(
            database, user_id=uuid4(), device_id=uuid4(), days=31
        )
    assert error.value.code == "INVALID_HISTORY_WINDOW"
    assert database.connection.executed == []


@pytest.mark.asyncio
async def test_location_history_route_matches_mobile_contract_and_logs_without_coordinates(
    caplog: pytest.LogCaptureFixture,
) -> None:
    owner_id = uuid4()
    device_id = uuid4()
    recorded_at = datetime(2026, 8, 25, 20, 0, tzinfo=UTC)

    class StubLocationService:
        async def request_report_history_24h(
            self, _database: object, *, user_id: UUID, device_id: UUID
        ) -> DeviceLocationHistoryResponse:
            assert user_id == owner_id
            assert device_id == expected_device_id
            return DeviceLocationHistoryResponse(
                device_id=expected_device_id,
                locations=[
                    {
                        "latitude": 38.73,
                        "longitude": -9.13,
                        "recorded_at": recorded_at,
                    }
                ],
            )

    expected_device_id = device_id
    missing = object()
    original_location = getattr(app.state, "location", missing)
    original_database = getattr(app.state, "database", missing)
    app.state.location = StubLocationService()
    app.state.database = object()
    caplog.set_level(logging.INFO, logger="pinqeva.api")
    app.dependency_overrides[authenticated_principal] = lambda: Principal(
        user_id=owner_id
    )
    try:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(
            transport=transport, base_url="http://testserver"
        ) as client:
            response = await client.post(
                f"/v1/devices/{device_id}/location/report_24h"
            )
    finally:
        app.dependency_overrides.pop(authenticated_principal, None)
        if original_location is not missing:
            app.state.location = original_location
        else:
            app.state._state.pop("location", None)
        if original_database is not missing:
            app.state.database = original_database
        else:
            app.state._state.pop("database", None)

    assert response.status_code == 200
    assert response.json() == {
        "device_id": str(device_id),
        "locations": [
            {
                "latitude": 38.73,
                "longitude": -9.13,
                "recorded_at": "2026-08-25T20:00:00Z",
            }
        ],
    }
    messages = [record.getMessage() for record in caplog.records]
    assert any("location_history_24h_request_received" in message for message in messages)
    assert any(
        "location_history_24h_request_completed" in message
        and "location_count=1" in message
        for message in messages
    )
    assert all("38.73" not in message and "-9.13" not in message for message in messages)
