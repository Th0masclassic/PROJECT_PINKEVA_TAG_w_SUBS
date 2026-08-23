import os

import pytest
from pydantic import ValidationError

from app.crypto import b64url_encode
from app.config import ConfigurationError, Settings
from app.models import DeviceClaimStart, DeviceReleaseComplete, validate_idempotency_key


def test_serial_is_normalized() -> None:
    request = DeviceClaimStart(
        serial_number="pkv-aabbccddeeff",
        setup_code="kXxWmpyHXq6YJf4vJ69EBtCaJq8qJm1h",
    )
    assert request.serial_number == "PKV-AABBCCDDEEFF"


@pytest.mark.parametrize(
    "serial", ["PKV-1234", "TAG-AABBCCDDEEFF", "PKV-GGBBCCDDEEFF"]
)
def test_invalid_serial_is_rejected(serial: str) -> None:
    with pytest.raises(ValidationError):
        DeviceClaimStart(
            serial_number=serial,
            setup_code="kXxWmpyHXq6YJf4vJ69EBtCaJq8qJm1h",
        )


def test_key_fingerprint_must_be_canonical_32_byte_base64url() -> None:
    valid = b64url_encode(os.urandom(32))
    assert DeviceClaimStart(
        serial_number="PKV-AABBCCDDEEFF",
        setup_code="kXxWmpyHXq6YJf4vJ69EBtCaJq8qJm1h",
        tag_advertisement_key_sha256_base64url=valid,
    ).tag_advertisement_key_sha256_base64url == valid

    with pytest.raises(ValidationError):
        DeviceClaimStart(
            serial_number="PKV-AABBCCDDEEFF",
            setup_code="kXxWmpyHXq6YJf4vJ69EBtCaJq8qJm1h",
            tag_advertisement_key_sha256_base64url="!" * 43,
        )


def test_release_completion_requires_explicit_empty_tag_state() -> None:
    with pytest.raises(ValidationError):
        DeviceReleaseComplete(
            release_id="c034d7ba-dc96-4e77-8487-96b380e1b9dc",
            serial_number="PKV-AABBCCDDEEFF",
            tag_key_state="present",
            release_completion_token_base64url=b64url_encode(os.urandom(32)),
        )


def test_idempotency_key_character_set() -> None:
    assert validate_idempotency_key("provision:01HZZZZZZZZZZZZZ")
    with pytest.raises(ValueError):
        validate_idempotency_key("not allowed spaces")


def test_backend_secret_roles_cannot_reuse_the_same_key() -> None:
    reused = os.urandom(32)
    with pytest.raises(ConfigurationError):
        Settings(
            database_url="postgresql://unused",
            supabase_jwks_url="https://example.invalid/jwks.json",
            supabase_jwt_issuer="https://example.invalid/auth/v1",
            supabase_jwt_audience="authenticated",
            supabase_jwt_algorithms=("ES256",),
            key_encryption_key=reused,
            claim_token_key=reused,
            setup_code_pepper=os.urandom(32),
            session_ttl_seconds=600,
            claim_ttl_seconds=86_400,
        )
