import hashlib
import os
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4

import pytest
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec

from app.billing import BillingError
from app.config import Settings
from app.crypto import b64url_decode_exact, b64url_encode
from app.entitlement import (
    ENTITLEMENT_BODY_SIZE,
    ENTITLEMENT_PACKET_SIZE,
    ENTITLEMENT_SIGNATURE_MAX_SIZE,
    EntitlementService,
    build_entitlement,
)
from app.models import DeviceEntitlementAcknowledge, DeviceEntitlementRequest


class Cursor:
    def __init__(self, result: Any = None) -> None:
        self.result = result

    async def fetchone(self) -> Any:
        return self.result


class ScriptedConnection:
    def __init__(self, results: list[Any]) -> None:
        self.results = list(results)
        self.executions: list[tuple[str, tuple[Any, ...]]] = []

    async def execute(
        self, query: str, parameters: tuple[Any, ...] = ()
    ) -> Cursor:
        normalized = " ".join(query.split())
        self.executions.append((normalized, parameters))
        if not self.results:
            raise AssertionError(f"Unexpected query: {normalized}")
        return Cursor(self.results.pop(0))


def settings() -> Settings:
    return Settings(
        database_url="postgresql://unused",
        supabase_jwks_url="https://example.invalid/jwks.json",
        supabase_jwt_issuer="https://example.invalid/auth/v1",
        supabase_jwt_audience="authenticated",
        supabase_jwt_algorithms=("ES256",),
        key_encryption_key=os.urandom(32),
        bootstrap_key_encryption_key=os.urandom(32),
        claim_token_key=os.urandom(32),
        session_ttl_seconds=600,
        claim_ttl_seconds=86_400,
        entitlement_private_key=ec.generate_private_key(ec.SECP256R1()),
        dev_bypass_bootstrap_auth=True,
    )


def test_entitlement_packet_is_fixed_size_and_signed() -> None:
    private_key = ec.generate_private_key(ec.SECP256R1())
    issued_at = datetime(2026, 8, 25, 9, 0, tzinfo=UTC)
    packet = build_entitlement(
        serial_number="PKV-AABBCCDDEEFF",
        subscription_id=uuid4(),
        issued_at=issued_at,
        expires_at=issued_at + timedelta(days=30),
        counter=7,
        private_key=private_key,
    )

    assert len(packet) == ENTITLEMENT_PACKET_SIZE
    signature_length = packet[ENTITLEMENT_BODY_SIZE]
    assert 1 <= signature_length <= ENTITLEMENT_SIGNATURE_MAX_SIZE
    private_key.public_key().verify(
        packet[ENTITLEMENT_BODY_SIZE + 1 : ENTITLEMENT_BODY_SIZE + 1 + signature_length],
        packet[:ENTITLEMENT_BODY_SIZE],
        ec.ECDSA(hashes.SHA256()),
    )
    assert len(b64url_encode(packet)) == 180


@pytest.mark.asyncio
async def test_issue_records_exact_packet_as_pending_physical_delivery() -> None:
    user_id = uuid4()
    device_id = uuid4()
    subscription_id = uuid4()
    period_end = datetime.now(UTC) + timedelta(days=30)
    connection = ScriptedConnection(
        [
            {
                "id": device_id,
                "serial_number": "PKV-AABBCCDDEEFF",
                "status": "claimed",
                "entitlement_counter": 8,
                "bootstrap_key_ciphertext": None,
                "bootstrap_key_nonce": None,
                "bootstrap_key_envelope_version": None,
            },
            {
                "id": subscription_id,
                "starts_at": datetime.now(UTC) - timedelta(days=1),
                "current_period_end": period_end,
            },
            {"entitlement_counter": 9},
            None,
        ]
    )
    service = EntitlementService(settings())

    response = await service.issue(
        connection,
        user_id=user_id,
        device_id=device_id,
        request=DeviceEntitlementRequest(
            serial_number="PKV-AABBCCDDEEFF",
            tag_challenge_base64url=b64url_encode(bytes(range(32))),
        ),
    )

    packet = b64url_decode_exact(response.entitlement_base64url, 135)
    assert response.counter == 9
    assert response.expires_at == period_end
    assert b64url_decode_exact(response.packet_sha256_base64url, 32) == (
        hashlib.sha256(packet).digest()
    )
    sync_query, sync_parameters = connection.executions[-1]
    assert "INSERT INTO public.device_entitlement_sync" in sync_query
    assert sync_parameters[0:6] == (
        user_id,
        device_id,
        subscription_id,
        period_end,
        9,
        hashlib.sha256(packet).hexdigest(),
    )


@pytest.mark.asyncio
async def test_acknowledgement_marks_only_exact_read_back_as_installed() -> None:
    user_id = uuid4()
    device_id = uuid4()
    sync_id = uuid4()
    period_end = datetime.now(UTC) + timedelta(days=30)
    digest = bytes(range(32))
    connection = ScriptedConnection(
        [{"id": sync_id, "entitlement_expires_at": period_end}, None]
    )

    response = await EntitlementService(settings()).acknowledge(
        connection,
        user_id=user_id,
        device_id=device_id,
        request=DeviceEntitlementAcknowledge(
            counter=12,
            expires_at=period_end,
            packet_sha256_base64url=b64url_encode(digest),
        ),
    )

    assert response.status == "installed"
    assert response.counter == 12
    assert connection.executions[0][1][-1] == digest.hex()
    assert connection.executions[1][1] == (sync_id,)


@pytest.mark.asyncio
async def test_acknowledgement_rejects_unknown_packet() -> None:
    connection = ScriptedConnection([None])
    with pytest.raises(BillingError) as error:
        await EntitlementService(settings()).acknowledge(
            connection,
            user_id=uuid4(),
            device_id=uuid4(),
            request=DeviceEntitlementAcknowledge(
                counter=1,
                expires_at=datetime.now(UTC) + timedelta(days=30),
                packet_sha256_base64url=b64url_encode(bytes(32)),
            ),
        )
    assert error.value.code == "ENTITLEMENT_ACK_REJECTED"
