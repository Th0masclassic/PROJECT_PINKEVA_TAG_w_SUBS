import os
import uuid
from dataclasses import replace
from datetime import UTC, datetime, timedelta

import pytest

from app.config import Settings
from app.crypto import (
    b64url_encode,
    claim_completion_token,
    encrypt_device_bootstrap_key,
    release_completion_token,
    tag_authorization_proof,
)
from app.models import (
    DeviceClaimComplete,
    DeviceClaimStart,
    DeviceProvisioningRequestStart,
    DeviceReleaseComplete,
    DeviceReleaseStart,
)
from app.service import ProvisioningError, ProvisioningService


class Cursor:
    def __init__(self, row=None):
        self.row = row

    async def fetchone(self):
        return self.row


class FakeConnection:
    def __init__(self, rows):
        self.rows = list(rows)
        self.executions = []

    async def execute(self, query, parameters=()):
        self.executions.append((query, parameters))
        row = self.rows.pop(0) if self.rows else None
        return Cursor(row)


@pytest.fixture
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
    )


def device_row(settings: Settings, user_id=None, session_id=None):
    device_id = uuid.uuid4()
    serial_number = "PKV-AABBCCDDEEFF"
    bootstrap_key = os.urandom(32)
    associated_data = (
        f"pinqeva:bootstrap:v1:{device_id}:{serial_number}"
    ).encode("ascii")
    encrypted = encrypt_device_bootstrap_key(
        bootstrap_key, settings.bootstrap_key_encryption_key, associated_data
    )
    return bootstrap_key, {
        "id": device_id,
        "device_id": device_id,
        "serial_number": serial_number,
        "bootstrap_key_ciphertext": encrypted.ciphertext,
        "bootstrap_key_nonce": encrypted.nonce,
        "bootstrap_key_envelope_version": encrypted.version,
        "provisioning_session_id": session_id,
        "owner_user_id": user_id,
    }


def paid_request_row(user_id, device_id, request_id):
    now = datetime.now(UTC)
    return {
        "id": request_id,
        "user_id": user_id,
        "device_id": device_id,
        "serial_number": "PKV-AABBCCDDEEFF",
        "status": "paid",
        "plan_code": "monthly_basic",
        "claim_deadline": now + timedelta(hours=1),
        "subscription_status": "active",
        "starts_at": now - timedelta(minutes=1),
        "current_period_end": now + timedelta(days=30),
        "replacement_claim_id": None,
        "replacement_claim_status": None,
    }


@pytest.mark.asyncio
async def test_fulfilled_replacement_can_be_claimed_after_subscription_expiry(
    settings: Settings,
) -> None:
    user_id = uuid.uuid4()
    device_id = uuid.uuid4()
    request_id = uuid.uuid4()
    now = datetime.now(UTC)
    row = {
        "id": request_id,
        "user_id": user_id,
        "device_id": device_id,
        "serial_number": "PKV-AABBCCDDEEFF",
        "status": "paid",
        "plan_code": "yearly_pro",
        "claim_deadline": now + timedelta(days=7),
        "replacement_claim_id": uuid.uuid4(),
        "subscription_status": "expired",
        "starts_at": now - timedelta(days=365),
        "current_period_end": now - timedelta(days=1),
        "replacement_claim_status": "fulfilled",
    }

    result = await ProvisioningService(settings)._require_paid_provisioning_request(
        FakeConnection([row]),
        user_id=user_id,
        device_id=device_id,
        serial_number="PKV-AABBCCDDEEFF",
        request_id=request_id,
    )

    assert result == row


@pytest.mark.asyncio
async def test_expired_normal_purchase_cannot_allocate_keys(
    settings: Settings,
) -> None:
    user_id = uuid.uuid4()
    device_id = uuid.uuid4()
    request_id = uuid.uuid4()
    now = datetime.now(UTC)
    row = {
        "id": request_id,
        "user_id": user_id,
        "device_id": device_id,
        "serial_number": "PKV-AABBCCDDEEFF",
        "status": "paid",
        "plan_code": "monthly_basic",
        "claim_deadline": now + timedelta(days=7),
        "replacement_claim_id": None,
        "subscription_status": "expired",
        "starts_at": now - timedelta(days=30),
        "current_period_end": now - timedelta(seconds=1),
        "replacement_claim_status": None,
    }

    with pytest.raises(ProvisioningError) as error:
        await ProvisioningService(settings)._require_paid_provisioning_request(
            FakeConnection([row]),
            user_id=user_id,
            device_id=device_id,
            serial_number="PKV-AABBCCDDEEFF",
            request_id=request_id,
        )

    assert error.value.code == "SUBSCRIPTION_REQUIRED"


@pytest.mark.asyncio
async def test_start_claim_generates_once_binds_immediately_and_returns_no_private_key(
    settings: Settings,
) -> None:
    user_id = uuid.uuid4()
    bootstrap_key, device = device_row(settings)
    challenge = os.urandom(32)
    provisioning_request_id = uuid.uuid4()
    session_id_holder = {}

    # The insert RETURNING row needs values generated inside the service. The
    # fake cursor supplies stable shape; response/security assertions inspect
    # the actual INSERT parameters.
    returned_session = {
        "id": uuid.uuid4(),
        "user_id": user_id,
        "device_id": device["id"],
        "serial_number": device["serial_number"],
        "advertisement_key": os.urandom(28),
        "advertisement_key_sha256": os.urandom(32),
        "google_advertisement_key": os.urandom(20),
        "google_advertisement_key_sha256": os.urandom(32),
        "finding_network": "apple",
        "status": "pending",
        "expires_at": datetime.now(UTC) + timedelta(minutes=10),
        "claim_deadline": datetime.now(UTC) + timedelta(days=1),
        "completed_at": None,
    }
    connection = FakeConnection(
        [
            device,
            paid_request_row(user_id, device["id"], provisioning_request_id),
            None,
            None,
            returned_session,
            None,
            None,
        ]
    )

    response = await ProvisioningService(settings).start_claim(
        connection,
        user_id=user_id,
        idempotency_key="provision:01HZZZZZZZZZZZZZ",
        request=DeviceClaimStart(
            provisioning_request_id=provisioning_request_id,
            serial_number=device["serial_number"],
            tag_challenge_base64url=b64url_encode(challenge),
        ),
    )

    insert_execution = next(
        execution for execution in connection.executions if "INSERT INTO public.provisioning_session" in execution[0]
    )
    insert_parameters = insert_execution[1]
    assert len(insert_parameters[6]) == 44  # 28-byte scalar + GCM tag
    assert len(insert_parameters[7]) == 12
    assert len(insert_parameters[9]) == 57
    assert len(insert_parameters[10]) == 28
    assert len(insert_parameters[11]) == 32
    assert len(insert_parameters[12]) == 48  # 32-byte EIK + GCM tag
    assert len(insert_parameters[13]) == 12
    assert len(insert_parameters[15]) == 20
    assert len(insert_parameters[16]) == 32
    assert insert_parameters[17] == "apple"
    assert response.tag_action == "write_key"
    assert len(response.google_advertisement_key_base64url) == 27
    assert len(response.claim_completion_token_base64url) == 43
    assert len(response.tag_control_key_base64url) == 43
    assert response.tag_authorization_proof_base64url == b64url_encode(
        tag_authorization_proof(bootstrap_key, device["serial_number"], challenge)
    )
    assert not hasattr(response, "private_key")
    assert not hasattr(response, "public_key")
    assert any(
        "SET provisioning_session_id" in query for query, _ in connection.executions
    )


@pytest.mark.asyncio
async def test_unknown_device_uses_generic_authorization_rejection(
    settings: Settings,
) -> None:
    connection = FakeConnection([None])
    with pytest.raises(ProvisioningError) as error:
        await ProvisioningService(settings).start_claim(
            connection,
            user_id=uuid.uuid4(),
            idempotency_key="provision:01HZZZZZZZZZZZZZ",
            request=DeviceClaimStart(
                provisioning_request_id=uuid.uuid4(),
                serial_number="PKV-AABBCCDDEEFF",
                tag_challenge_base64url=b64url_encode(os.urandom(32)),
            ),
        )
    assert error.value.code == "DEVICE_AUTHORIZATION_REJECTED"
    assert error.value.status_code == 403


@pytest.mark.asyncio
async def test_claim_refuses_before_payment_without_generating_key_material(
    settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    user_id = uuid.uuid4()
    _, device = device_row(settings)
    connection = FakeConnection([device, None])

    def unexpected_key_generation():
        raise AssertionError("key material must not be generated before payment")

    monkeypatch.setattr(
        "app.service.generate_finder_key_bundle", unexpected_key_generation
    )

    with pytest.raises(ProvisioningError) as error:
        await ProvisioningService(settings).start_claim(
            connection,
            user_id=user_id,
            idempotency_key="provision:before-payment-01",
            request=DeviceClaimStart(
                provisioning_request_id=uuid.uuid4(),
                serial_number=device["serial_number"],
                tag_challenge_base64url=b64url_encode(os.urandom(32)),
            ),
        )

    assert error.value.code == "SUBSCRIPTION_REQUIRED"
    assert not any(
        "INSERT INTO public.provisioning_session" in query
        for query, _ in connection.executions
    )


@pytest.mark.asyncio
async def test_payment_request_rejects_device_without_bootstrap_credential(
    settings: Settings,
) -> None:
    user_id = uuid.uuid4()
    _, device = device_row(settings)
    device["bootstrap_key_ciphertext"] = None
    device["bootstrap_key_nonce"] = None
    device["bootstrap_key_envelope_version"] = None
    connection = FakeConnection([device])

    with pytest.raises(ProvisioningError) as error:
        await ProvisioningService(settings).start_provisioning_request(
            connection,
            user_id=user_id,
            idempotency_key="request:missing-bootstrap-0001",
            request=DeviceProvisioningRequestStart(
                serial_number=device["serial_number"],
                tag_challenge_base64url=b64url_encode(os.urandom(32)),
            ),
        )

    assert error.value.code == "DEVICE_AUTHORIZATION_REJECTED"


@pytest.mark.asyncio
async def test_payment_request_allows_missing_bootstrap_credential_in_dev_mode(
    settings: Settings,
) -> None:
    settings = replace(settings, dev_bypass_bootstrap_auth=True)
    user_id = uuid.uuid4()
    _, device = device_row(settings)
    device["bootstrap_key_ciphertext"] = None
    device["bootstrap_key_nonce"] = None
    device["bootstrap_key_envelope_version"] = None
    request_id = uuid.uuid4()
    created = {
        "id": request_id,
        "device_id": device["id"],
        "serial_number": device["serial_number"],
        "status": "pending",
        "plan_code": None,
        "expires_at": datetime.now(UTC) + timedelta(minutes=29),
        "claim_deadline": None,
    }
    connection = FakeConnection([device, None, None, None, None, created])

    response = await ProvisioningService(settings).start_provisioning_request(
        connection,
        user_id=user_id,
        idempotency_key="request:dev-bypass-0001",
        request=DeviceProvisioningRequestStart(
            serial_number=device["serial_number"],
            tag_challenge_base64url=b64url_encode(os.urandom(32)),
        ),
    )

    assert response.request_id == request_id


@pytest.mark.asyncio
async def test_claim_passes_bootstrap_check_in_dev_mode(
    settings: Settings,
) -> None:
    settings = replace(settings, dev_bypass_bootstrap_auth=True)
    _, device = device_row(settings)
    device["bootstrap_key_ciphertext"] = None
    device["bootstrap_key_nonce"] = None
    device["bootstrap_key_envelope_version"] = None
    connection = FakeConnection([device, None])

    with pytest.raises(ProvisioningError) as error:
        await ProvisioningService(settings).start_claim(
            connection,
            user_id=uuid.uuid4(),
            idempotency_key="provision:dev-bypass-0001",
            request=DeviceClaimStart(
                provisioning_request_id=uuid.uuid4(),
                serial_number=device["serial_number"],
                tag_challenge_base64url=b64url_encode(os.urandom(32)),
            ),
        )

    assert error.value.code == "SUBSCRIPTION_REQUIRED"


@pytest.mark.asyncio
async def test_payment_request_has_no_key_allocation(
    settings: Settings,
) -> None:
    user_id = uuid.uuid4()
    _, device = device_row(settings)
    # FakeConnection returns rows exactly as supplied, so model the
    # `device_id` alias that the production SELECT must provide.
    device.pop("device_id")
    query_device = {**device, "device_id": device["id"]}
    request_id = uuid.uuid4()
    created = {
        "id": request_id,
        "device_id": device["id"],
        "serial_number": device["serial_number"],
        "status": "pending",
        "plan_code": None,
        "expires_at": datetime.now(UTC) + timedelta(minutes=29),
        "claim_deadline": None,
    }
    connection = FakeConnection([query_device, None, None, None, None, created])

    response = await ProvisioningService(settings).start_provisioning_request(
        connection,
        user_id=user_id,
        idempotency_key="request:payment-gate-0001",
        request=DeviceProvisioningRequestStart(
            serial_number=device["serial_number"],
            tag_challenge_base64url=b64url_encode(os.urandom(32)),
        ),
    )

    assert response.request_id == request_id
    assert response.status == "pending"
    assert any(
        "d.id AS device_id" in query
        for query, _ in connection.executions
    )
    assert not any(
        "provisioning_session" in query and "INSERT" in query
        for query, _ in connection.executions
    )


@pytest.mark.asyncio
async def test_payment_request_resumes_existing_user_reservation(
    settings: Settings,
) -> None:
    user_id = uuid.uuid4()
    _, device = device_row(settings)
    existing = {
        "id": uuid.uuid4(),
        "user_id": user_id,
        "device_id": device["id"],
        "serial_number": device["serial_number"],
        "status": "open",
        "plan_code": "monthly_basic",
        "expires_at": datetime.now(UTC) + timedelta(minutes=10),
        "claim_deadline": None,
    }
    connection = FakeConnection([device, None, None, existing])

    response = await ProvisioningService(settings).start_provisioning_request(
        connection,
        user_id=user_id,
        idempotency_key="request:payment-resume-01",
        request=DeviceProvisioningRequestStart(
            serial_number=device["serial_number"],
            tag_challenge_base64url=b64url_encode(os.urandom(32)),
        ),
    )

    assert response.request_id == existing["id"]
    assert response.status == "open"
    assert not any("INSERT INTO" in query for query, _ in connection.executions)


@pytest.mark.asyncio
async def test_bound_session_is_resumed_without_generating_a_replacement(
    settings: Settings,
) -> None:
    user_id = uuid.uuid4()
    session_id = uuid.uuid4()
    provisioning_request_id = uuid.uuid4()
    _, device = device_row(settings, session_id=session_id)
    stored_key = os.urandom(28)
    stored_hash = os.urandom(32)
    google_key = os.urandom(20)
    google_hash = os.urandom(32)
    bound = {
        "id": session_id,
        "user_id": user_id,
        "device_id": device["id"],
        "serial_number": device["serial_number"],
        "advertisement_key": stored_key,
        "advertisement_key_sha256": stored_hash,
        "google_advertisement_key": google_key,
        "google_advertisement_key_sha256": google_hash,
        "finding_network": "apple",
        "status": "pending",
        "expires_at": datetime.now(UTC) + timedelta(minutes=5),
        "claim_deadline": datetime.now(UTC) + timedelta(hours=1),
        "completed_at": None,
    }
    connection = FakeConnection(
        [
            device,
            paid_request_row(user_id, device["id"], provisioning_request_id),
            None,
            bound,
        ]
    )

    response = await ProvisioningService(settings).start_claim(
        connection,
        user_id=user_id,
        idempotency_key="provision:new-retry-0001",
        request=DeviceClaimStart(
            provisioning_request_id=provisioning_request_id,
            serial_number=device["serial_number"],
            tag_challenge_base64url=b64url_encode(os.urandom(32)),
        ),
    )

    assert response.session_id == session_id
    assert response.advertisement_key_base64url == b64url_encode(stored_key)
    assert response.google_advertisement_key_base64url == b64url_encode(google_key)
    assert response.tag_action == "write_key"
    assert not any("INSERT INTO" in query for query, _ in connection.executions)


@pytest.mark.asyncio
async def test_tag_with_different_stored_key_fails_closed(settings: Settings) -> None:
    user_id = uuid.uuid4()
    session_id = uuid.uuid4()
    provisioning_request_id = uuid.uuid4()
    _, device = device_row(settings, session_id=session_id)
    bound = {
        "id": session_id,
        "user_id": user_id,
        "device_id": device["id"],
        "serial_number": device["serial_number"],
        "advertisement_key": os.urandom(28),
        "advertisement_key_sha256": os.urandom(32),
        "google_advertisement_key": os.urandom(20),
        "google_advertisement_key_sha256": os.urandom(32),
        "finding_network": "apple",
        "status": "pending",
        "expires_at": datetime.now(UTC) + timedelta(minutes=5),
        "claim_deadline": datetime.now(UTC) + timedelta(hours=1),
        "completed_at": None,
    }
    connection = FakeConnection(
        [
            device,
            paid_request_row(user_id, device["id"], provisioning_request_id),
            None,
            bound,
        ]
    )
    with pytest.raises(ProvisioningError) as error:
        await ProvisioningService(settings).start_claim(
            connection,
            user_id=user_id,
            idempotency_key="provision:mismatch-0001",
            request=DeviceClaimStart(
                provisioning_request_id=provisioning_request_id,
                serial_number=device["serial_number"],
                tag_challenge_base64url=b64url_encode(os.urandom(32)),
                tag_advertisement_key_sha256_base64url=b64url_encode(os.urandom(32)),
            ),
        )
    assert error.value.code == "TAG_KEY_MISMATCH"


@pytest.mark.asyncio
async def test_allocation_owned_by_another_user_is_unavailable(settings: Settings) -> None:
    current_user = uuid.uuid4()
    other_user = uuid.uuid4()
    session_id = uuid.uuid4()
    provisioning_request_id = uuid.uuid4()
    _, device = device_row(settings, user_id=other_user, session_id=session_id)
    bound = {
        "id": session_id,
        "user_id": other_user,
        "device_id": device["id"],
        "serial_number": device["serial_number"],
        "advertisement_key": os.urandom(28),
        "advertisement_key_sha256": os.urandom(32),
        "status": "claimed",
        "expires_at": datetime.now(UTC),
        "claim_deadline": datetime.now(UTC),
        "completed_at": datetime.now(UTC),
    }
    connection = FakeConnection(
        [
            device,
            paid_request_row(current_user, device["id"], provisioning_request_id),
            None,
            bound,
        ]
    )
    with pytest.raises(ProvisioningError) as error:
        await ProvisioningService(settings).start_claim(
            connection,
            user_id=current_user,
            idempotency_key="provision:other-owner-01",
            request=DeviceClaimStart(
                provisioning_request_id=provisioning_request_id,
                serial_number=device["serial_number"],
                tag_challenge_base64url=b64url_encode(os.urandom(32)),
            ),
        )
    assert error.value.code == "DEVICE_UNAVAILABLE"


@pytest.mark.asyncio
async def test_claim_retry_returns_the_original_result(settings: Settings) -> None:
    session_id = uuid.uuid4()
    device_id = uuid.uuid4()
    user_id = uuid.uuid4()
    completed_at = datetime.now(UTC) - timedelta(seconds=2)
    advertisement_hash = os.urandom(32)
    google_advertisement_hash = os.urandom(32)
    token = claim_completion_token(
        settings.claim_token_key,
        session_id=session_id.bytes,
        user_id=user_id.bytes,
        device_id=device_id.bytes,
        advertisement_key_sha256=advertisement_hash,
        google_advertisement_key_sha256=google_advertisement_hash,
        finding_network="google",
    )
    connection = FakeConnection(
        [
            {
                "id": session_id,
                "device_id": device_id,
                "serial_number": "PKV-AABBCCDDEEFF",
                "status": "claimed",
                "advertisement_key_sha256": advertisement_hash,
                "google_advertisement_key_sha256": google_advertisement_hash,
                "finding_network": "google",
                "claim_deadline": datetime.now(UTC) + timedelta(hours=1),
                "completed_at": completed_at,
                "provisioning_session_id": session_id,
            }
        ]
    )

    response = await ProvisioningService(settings).complete_claim(
        connection,
        user_id=user_id,
        request=DeviceClaimComplete(
            session_id=session_id,
            serial_number="PKV-AABBCCDDEEFF",
            tag_advertisement_key_sha256_base64url=b64url_encode(advertisement_hash),
            tag_google_advertisement_key_sha256_base64url=b64url_encode(
                google_advertisement_hash
            ),
            finding_network="google",
            claim_completion_token_base64url=b64url_encode(token),
        ),
    )
    assert response.device_id == device_id
    assert response.claimed_at == completed_at
    assert response.finding_network == "google"
    assert len(connection.executions) == 1


@pytest.mark.asyncio
async def test_start_release_returns_challenge_bound_authorization(
    settings: Settings,
) -> None:
    user_id = uuid.uuid4()
    session_id = uuid.uuid4()
    bootstrap_key, device = device_row(
        settings, user_id=user_id, session_id=session_id
    )
    advertisement_hash = os.urandom(32)
    google_advertisement_hash = os.urandom(32)
    device.update(
        owner_user_id=user_id,
        session_user_id=user_id,
        session_status="claimed",
        advertisement_key_sha256=advertisement_hash,
        google_advertisement_key_sha256=google_advertisement_hash,
        finding_network="google",
    )
    release_id = uuid.uuid4()
    release = {
        "id": release_id,
        "user_id": user_id,
        "device_id": device["device_id"],
        "provisioning_session_id": session_id,
        "serial_number": device["serial_number"],
        "reset_nonce": os.urandom(32),
        "status": "pending",
        "expires_at": datetime.now(UTC) + timedelta(hours=1),
    }
    challenge = os.urandom(32)
    connection = FakeConnection([None, device, None, release])

    response = await ProvisioningService(settings).start_release(
        connection,
        user_id=user_id,
        device_id=device["device_id"],
        idempotency_key="release:01HZZZZZZZZZZZZZZ",
        request=DeviceReleaseStart(
            serial_number=device["serial_number"],
            tag_challenge_base64url=b64url_encode(challenge),
            tag_advertisement_key_sha256_base64url=b64url_encode(
                advertisement_hash
            ),
            tag_google_advertisement_key_sha256_base64url=b64url_encode(
                google_advertisement_hash
            ),
            finding_network="google",
        ),
    )

    assert response.release_id == release_id
    assert response.tag_authorization_proof_base64url == b64url_encode(
        tag_authorization_proof(bootstrap_key, device["serial_number"], challenge)
    )
    assert len(response.reset_command_base64url) == 86


@pytest.mark.asyncio
async def test_completed_release_ends_one_owner_and_cancels_subscriptions(
    settings: Settings,
) -> None:
    release_id = uuid.uuid4()
    user_id = uuid.uuid4()
    device_id = uuid.uuid4()
    session_id = uuid.uuid4()
    nonce = os.urandom(32)
    token = release_completion_token(
        settings.claim_token_key,
        release_id=release_id.bytes,
        user_id=user_id.bytes,
        device_id=device_id.bytes,
        nonce=nonce,
    )
    release = {
        "id": release_id,
        "user_id": user_id,
        "device_id": device_id,
        "provisioning_session_id": session_id,
        "serial_number": "PKV-AABBCCDDEEFF",
        "reset_nonce": nonce,
        "status": "pending",
        "expires_at": datetime.now(UTC) + timedelta(hours=1),
        "completed_at": None,
        "cancelled_subscriptions": 0,
        "provider_cancellations_queued": 0,
        "current_session_id": session_id,
    }
    connection = FakeConnection(
        [
            release,
            {"user_id": user_id},
            {"cancelled_count": 2, "queued_count": 1},
            None,
            None,
            None,
            None,
        ]
    )

    response = await ProvisioningService(settings).complete_release(
        connection,
        user_id=user_id,
        device_id=device_id,
        request=DeviceReleaseComplete(
            release_id=release_id,
            serial_number="PKV-AABBCCDDEEFF",
            tag_key_state="empty",
            tag_google_key_state="empty",
            tag_finding_network_state="empty",
            release_completion_token_base64url=b64url_encode(token),
        ),
    )
    assert response.status == "unprovisioned"
    assert response.cancelled_subscriptions == 2
    assert response.provider_cancellations_queued == 1
    statements = "\n".join(query for query, _ in connection.executions)
    assert "SET ended_at" in statements
    assert "SET status = 'revoked'" in statements
    assert "SET provisioning_session_id = NULL" in statements
