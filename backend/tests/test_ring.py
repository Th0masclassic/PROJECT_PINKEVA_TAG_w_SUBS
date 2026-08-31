import hashlib
import hmac
from contextlib import asynccontextmanager
from dataclasses import replace
from uuid import uuid4

import httpx
import pytest
from pydantic import ValidationError

from app.auth import Principal, authenticated_principal
from app.config import Settings, get_settings
from app.crypto import (
    b64url_decode_exact,
    b64url_encode,
    tag_authorization_proof,
    tag_control_key,
    tag_reset_command,
    tag_ring_authorization_proof,
)
from app.main import app
from app.models import DeviceRingAuthorizationRequest
from app.service import ProvisioningError, ProvisioningService


SERIAL = "PKV-AABBCCDDEEFF"
CHALLENGE = bytes(range(32, 64))


@pytest.fixture
def settings() -> Settings:
    return Settings(
        database_url="postgresql://unused",
        supabase_jwks_url="https://example.invalid/jwks.json",
        supabase_jwt_issuer="https://example.invalid/auth/v1",
        supabase_jwt_audience="authenticated",
        supabase_jwt_algorithms=("ES256",),
        key_encryption_key=b"e" * 32,
        bootstrap_key_encryption_key=b"b" * 32,
        claim_token_key=b"c" * 32,
        session_ttl_seconds=600,
        claim_ttl_seconds=86_400,
    )


def owned_device():
    user_id = uuid4()
    device_id = uuid4()
    session_id = uuid4()
    return {
        "device_id": device_id,
        "serial_number": SERIAL,
        "device_status": "claimed",
        "provisioning_session_id": session_id,
        "owner_user_id": user_id,
        "session_id": session_id,
        "session_user_id": user_id,
        "session_device_id": device_id,
        "session_serial_number": SERIAL,
        "session_status": "claimed",
        "advertisement_key_sha256": hashlib.sha256(b"owned-tag-key").digest(),
    }


def ring_request(challenge=CHALLENGE, serial=SERIAL):
    return DeviceRingAuthorizationRequest(
        serial_number=serial,
        tag_challenge_base64url=b64url_encode(challenge),
    )


class Cursor:
    def __init__(self, row):
        self.row = row

    async def fetchone(self):
        return self.row


class Connection:
    def __init__(self, row):
        self.row = row
        self.executions = []

    async def execute(self, query, parameters=()):
        self.executions.append((" ".join(query.split()), parameters))
        return Cursor(self.row)


class Database:
    def __init__(self, connection):
        self.connection = connection

    @asynccontextmanager
    async def transaction(self):
        yield self.connection


def derived_control_key(settings, row):
    return tag_control_key(
        settings.claim_token_key,
        session_id=row["session_id"].bytes,
        user_id=row["session_user_id"].bytes,
        device_id=row["session_device_id"].bytes,
        advertisement_key_sha256=row["advertisement_key_sha256"],
    )


def test_ring_proof_matches_wire_vector_and_is_domain_separated():
    key = bytes(range(32))
    proof = tag_ring_authorization_proof(key, SERIAL, CHALLENGE)
    assert proof.hex() == (
        "4d43f89abc2167662a5f30c6f1b17f5910ff1d71a58dcfc30c8f306b58f3df28"
    )
    assert proof == hmac.new(
        key, b"pinqeva:ring-auth:v1\x00" + SERIAL.encode("ascii") + CHALLENGE,
        hashlib.sha256,
    ).digest()
    assert proof != tag_authorization_proof(key, SERIAL, CHALLENGE)
    assert proof != tag_reset_command(key, SERIAL, CHALLENGE)[32:]
    assert proof != tag_ring_authorization_proof(key, SERIAL, b"x" * 32)
    assert proof != tag_ring_authorization_proof(key, "PKV-001122334455", CHALLENGE)
    assert proof != tag_ring_authorization_proof(b"x" * 32, SERIAL, CHALLENGE)


@pytest.mark.parametrize(
    ("key", "serial", "challenge"),
    [
        (b"k" * 31, SERIAL, CHALLENGE),
        (b"k" * 33, SERIAL, CHALLENGE),
        (b"k" * 32, SERIAL, b"n" * 31),
        (b"k" * 32, SERIAL, b"n" * 33),
        (b"k" * 32, "PKV-AABBCCDDEEF", CHALLENGE),
        (b"k" * 32, "PKV-AABBCCDDEEFF0", CHALLENGE),
        (b"k" * 32, "PKV-AABBCCDDEE\u00e9F", CHALLENGE),
    ],
)
def test_ring_proof_requires_exact_key_challenge_and_ascii_serial(key, serial, challenge):
    with pytest.raises(ValueError):
        tag_ring_authorization_proof(key, serial, challenge)


@pytest.mark.parametrize("dev_bypass", [False, True])
@pytest.mark.asyncio
async def test_owner_gets_real_bound_proof_without_bootstrap_billing_or_writes(
    settings, dev_bypass
):
    configured = replace(settings, dev_bypass_bootstrap_auth=dev_bypass)
    row = owned_device()
    connection = Connection(row)
    response = await ProvisioningService(configured).authorize_ring(
        connection,
        user_id=row["owner_user_id"],
        device_id=row["device_id"],
        request=ring_request(),
    )
    expected = hmac.new(
        derived_control_key(configured, row),
        b"pinqeva:ring-auth:v1\x00" + SERIAL.encode("ascii") + CHALLENGE,
        hashlib.sha256,
    ).digest()
    assert b64url_decode_exact(response.ring_authorization_proof_base64url, 32) == expected
    assert set(response.model_dump()) == {
        "device_id", "serial_number", "ring_authorization_proof_base64url"
    }
    assert response.device_id == row["device_id"]
    assert response.serial_number == SERIAL
    assert len(connection.executions) == 1
    query, parameters = connection.executions[0]
    assert query.startswith("SELECT ")
    assert "o.ended_at IS NULL" in query
    assert "o.user_id = %s" in query
    assert "ps.id = d.provisioning_session_id" in query
    assert parameters == (row["device_id"], row["owner_user_id"])
    assert "subscription" not in query.lower()
    assert "bootstrap" not in query.lower()
    assert all(word not in query for word in ("UPDATE", "INSERT", "DELETE"))


@pytest.mark.asyncio
async def test_ring_proof_changes_with_challenge_and_current_allocation(settings):
    row = owned_device()
    service = ProvisioningService(settings)

    async def issue(device, challenge):
        return await service.authorize_ring(
            Connection(device), user_id=device["owner_user_id"],
            device_id=device["device_id"], request=ring_request(challenge),
        )

    first = await issue(row, CHALLENGE)
    fresh = await issue(row, b"n" * 32)
    new_session_id = uuid4()
    new_allocation = await issue(
        {**row, "session_id": new_session_id, "provisioning_session_id": new_session_id},
        CHALLENGE,
    )
    assert len({
        first.ring_authorization_proof_base64url,
        fresh.ring_authorization_proof_base64url,
        new_allocation.ring_authorization_proof_base64url,
    }) == 3


@pytest.mark.parametrize("missing", [False, True])
@pytest.mark.asyncio
async def test_non_owner_or_missing_active_ownership_is_not_disclosed(settings, missing):
    row = owned_device()
    with pytest.raises(ProvisioningError) as error:
        await ProvisioningService(settings).authorize_ring(
            Connection(None if missing else row), user_id=uuid4(),
            device_id=row["device_id"], request=ring_request(),
        )
    assert error.value.code == "OWNED_DEVICE_NOT_FOUND"
    assert error.value.status_code == 404


@pytest.mark.asyncio
async def test_wrong_connected_serial_cannot_get_owner_proof(settings):
    row = owned_device()
    with pytest.raises(ProvisioningError) as error:
        await ProvisioningService(settings).authorize_ring(
            Connection(row), user_id=row["owner_user_id"], device_id=row["device_id"],
            request=ring_request(serial="PKV-001122334455"),
        )
    assert error.value.code == "TAG_KEY_MISMATCH"
    assert error.value.status_code == 409


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("device_status", "unprovisioned"),
        ("device_status", "provisioning"),
        ("device_status", "suspended"),
        ("provisioning_session_id", None),
        ("session_id", None),
        ("session_id", uuid4()),
        ("session_user_id", uuid4()),
        ("session_device_id", uuid4()),
        ("session_serial_number", "PKV-001122334455"),
        ("session_status", "pending"),
        ("session_status", "revoked"),
        ("session_status", "recovery_required"),
        ("advertisement_key_sha256", None),
        ("advertisement_key_sha256", b"h" * 31),
    ],
)
@pytest.mark.asyncio
async def test_stale_or_inconsistent_claim_cannot_authorize_ring(settings, field, value):
    row = owned_device()
    with pytest.raises(ProvisioningError) as error:
        await ProvisioningService(settings).authorize_ring(
            Connection({**row, field: value}), user_id=row["owner_user_id"],
            device_id=row["device_id"], request=ring_request(),
        )
    assert error.value.code == "RECOVERY_REQUIRED"
    assert error.value.status_code == 409


def test_ring_request_normalizes_serial_and_forbids_extra_fields():
    assert ring_request(serial=SERIAL.lower()).serial_number == SERIAL
    with pytest.raises(ValidationError):
        DeviceRingAuthorizationRequest(
            **ring_request().model_dump(), control_key_base64url=b64url_encode(b"x" * 32)
        )


@pytest.mark.parametrize(
    "challenge", ["!" * 43, "A" * 42 + "B", "A" * 42, "A" * 44, "A" * 43 + "="]
)
def test_ring_request_rejects_invalid_or_noncanonical_challenge(challenge):
    with pytest.raises(ValidationError):
        DeviceRingAuthorizationRequest(serial_number=SERIAL, tag_challenge_base64url=challenge)


@pytest.mark.parametrize("serial", ["PKV-1234", "TAG-AABBCCDDEEFF", "PKV-GGBBCCDDEEFF"])
def test_ring_request_rejects_invalid_serial(serial):
    with pytest.raises(ValidationError):
        ring_request(serial=serial)


@pytest.mark.parametrize("owned", [False, True])
@pytest.mark.asyncio
async def test_ring_endpoint_uses_owner_identity_and_disables_caching(settings, monkeypatch, owned):
    row = owned_device()
    connection = Connection(row if owned else None)
    monkeypatch.setitem(
        app.dependency_overrides, authenticated_principal,
        lambda: Principal(user_id=row["owner_user_id"]),
    )
    monkeypatch.setattr(app.state, "service", ProvisioningService(settings), raising=False)
    monkeypatch.setattr(app.state, "database", Database(connection), raising=False)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.post(
            f"/v1/devices/{row['device_id']}/ring/authorize", json=ring_request().model_dump()
        )
    assert response.status_code == (200 if owned else 404)
    assert response.headers["cache-control"] == "private, no-store"
    assert response.headers["pragma"] == "no-cache"
    assert response.headers["x-request-id"]
    if owned:
        assert set(response.json()) == {
            "device_id", "serial_number", "ring_authorization_proof_base64url"
        }
        assert response.json()["device_id"] == str(row["device_id"])
    else:
        assert response.json()["error"]["code"] == "OWNED_DEVICE_NOT_FOUND"


@pytest.mark.asyncio
async def test_ring_endpoint_validation_is_no_store_and_never_echoes_challenge(settings, monkeypatch):
    row = owned_device()
    connection = Connection(row)
    monkeypatch.setitem(
        app.dependency_overrides, authenticated_principal,
        lambda: Principal(user_id=row["owner_user_id"]),
    )
    monkeypatch.setattr(app.state, "database", Database(connection), raising=False)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.post(
            f"/v1/devices/{row['device_id']}/ring/authorize",
            json={"serial_number": SERIAL, "tag_challenge_base64url": "private-invalid-input"},
        )
    assert response.status_code == 422
    assert response.headers["cache-control"] == "private, no-store"
    assert "private-invalid-input" not in response.text
    assert response.json()["error"]["code"] == "INVALID_REQUEST"
    assert connection.executions == []


@pytest.mark.asyncio
async def test_ring_endpoint_requires_bearer_authentication(settings, monkeypatch):
    connection = Connection(None)
    monkeypatch.setitem(app.dependency_overrides, get_settings, lambda: settings)
    monkeypatch.setattr(app.state, "database", Database(connection), raising=False)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.post(
            f"/v1/devices/{uuid4()}/ring/authorize", json=ring_request().model_dump()
        )
    assert response.status_code == 401
    assert response.headers["cache-control"] == "private, no-store"
    assert connection.executions == []
