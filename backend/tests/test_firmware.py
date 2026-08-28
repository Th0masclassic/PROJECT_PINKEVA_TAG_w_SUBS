import hashlib
import os
from dataclasses import replace
from typing import Any
from uuid import uuid4

import pytest
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec

from app.config import Settings
from app.crypto import b64url_decode_exact, b64url_encode
from app.firmware import (
    FIRMWARE_MANIFEST_BODY_SIZE,
    FIRMWARE_MANIFEST_SIZE,
    FirmwareService,
    build_firmware_manifest,
)
from app.models import FirmwareUpdateAcknowledge, FirmwareUpdateSessionRequest


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


def firmware_image() -> bytes:
    return b"\xE9" + bytes((index % 251 for index in range(8191)))


def settings(image_path: str, private_key: ec.EllipticCurvePrivateKey) -> Settings:
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
        firmware_signing_private_key=private_key,
        dev_bypass_bootstrap_auth=True,
        firmware_image_path=image_path,
        firmware_version="0.4.1",
    )


def owned_device(device_id):
    return {
        "id": device_id,
        "serial_number": "PKV-AABBCCDDEEFF",
        "status": "claimed",
        "firmware_version": "0.3.0",
        "bootstrap_key_ciphertext": None,
        "bootstrap_key_nonce": None,
        "bootstrap_key_envelope_version": None,
    }


def test_firmware_manifest_is_fixed_size_bound_and_signed() -> None:
    private_key = ec.generate_private_key(ec.SECP256R1())
    image = firmware_image()
    manifest = build_firmware_manifest(
        version="0.4.1", image=image, private_key=private_key
    )

    assert len(manifest) == FIRMWARE_MANIFEST_SIZE
    assert manifest[:6] == bytes((1, 1, 0, 4, 1, 0))
    assert int.from_bytes(manifest[6:10], "big") == len(image)
    assert manifest[10:42] == hashlib.sha256(image).digest()
    signature_length = manifest[FIRMWARE_MANIFEST_BODY_SIZE]
    private_key.public_key().verify(
        manifest[
            FIRMWARE_MANIFEST_BODY_SIZE
            + 1 : FIRMWARE_MANIFEST_BODY_SIZE
            + 1
            + signature_length
        ],
        manifest[:FIRMWARE_MANIFEST_BODY_SIZE],
        ec.ECDSA(hashes.SHA256()),
    )
    assert len(b64url_encode(manifest)) == 154


@pytest.mark.asyncio
async def test_owned_tracker_gets_release_and_bound_update_session(tmp_path) -> None:
    image_path = tmp_path / "firmware.bin"
    image_path.write_bytes(firmware_image())
    private_key = ec.generate_private_key(ec.SECP256R1())
    service = FirmwareService(settings(str(image_path), private_key))
    user_id = uuid4()
    device_id = uuid4()

    availability = await service.availability(
        ScriptedConnection([owned_device(device_id)]),
        user_id=user_id,
        device_id=device_id,
    )
    assert availability.update_available is True
    assert availability.latest_version == "0.4.1"

    connection = ScriptedConnection([owned_device(device_id), None])
    session = await service.issue_session(
        connection,
        user_id=user_id,
        device_id=device_id,
        request=FirmwareUpdateSessionRequest(
            serial_number="PKV-AABBCCDDEEFF",
            current_version="0.3.0",
            tag_challenge_base64url=b64url_encode(bytes(range(32))),
        ),
    )
    assert session.device_id == device_id
    assert session.version == "0.4.1"
    assert session.install_required is True
    assert b64url_decode_exact(session.image_sha256_base64url, 32) == hashlib.sha256(
        firmware_image()
    ).digest()
    assert len(b64url_decode_exact(session.manifest_base64url, 115)) == 115
    assert connection.executions[1][1] == ("0.3.0", device_id)


@pytest.mark.asyncio
async def test_unsigned_configured_image_is_not_advertised(tmp_path) -> None:
    image_path = tmp_path / "firmware.bin"
    image_path.write_bytes(firmware_image())
    configured = settings(
        str(image_path), ec.generate_private_key(ec.SECP256R1())
    )
    service = FirmwareService(
        replace(configured, firmware_signing_private_key=None)
    )
    user_id = uuid4()
    device_id = uuid4()

    availability = await service.availability(
        ScriptedConnection([owned_device(device_id)]),
        user_id=user_id,
        device_id=device_id,
    )

    assert availability.update_available is False
    assert availability.latest_version is None


@pytest.mark.asyncio
async def test_equal_tag_version_returns_acknowledgement_only_session(tmp_path) -> None:
    image_path = tmp_path / "firmware.bin"
    image_path.write_bytes(firmware_image())
    service = FirmwareService(
        settings(str(image_path), ec.generate_private_key(ec.SECP256R1()))
    )
    user_id = uuid4()
    device_id = uuid4()
    device = owned_device(device_id)
    device["firmware_version"] = "0.3.0"
    connection = ScriptedConnection([device, None])

    session = await service.issue_session(
        connection,
        user_id=user_id,
        device_id=device_id,
        request=FirmwareUpdateSessionRequest(
            serial_number="PKV-AABBCCDDEEFF",
            current_version="0.4.1",
            tag_challenge_base64url=b64url_encode(bytes(range(32))),
        ),
    )

    assert session.install_required is False
    assert session.version == "0.4.1"
    assert connection.executions[1][1] == ("0.4.1", device_id)


@pytest.mark.asyncio
async def test_acknowledgement_updates_version_only_for_exact_release(tmp_path) -> None:
    image_path = tmp_path / "firmware.bin"
    image_path.write_bytes(firmware_image())
    service = FirmwareService(
        settings(str(image_path), ec.generate_private_key(ec.SECP256R1()))
    )
    user_id = uuid4()
    device_id = uuid4()
    digest = hashlib.sha256(firmware_image()).digest()
    connection = ScriptedConnection([owned_device(device_id), {"id": device_id}])

    acknowledgement = await service.acknowledge(
        connection,
        user_id=user_id,
        device_id=device_id,
        request=FirmwareUpdateAcknowledge(
            version="0.4.1",
            image_sha256_base64url=b64url_encode(digest),
        ),
    )

    assert acknowledgement.status == "installed"
    assert acknowledgement.version == "0.4.1"
    assert connection.executions[-1][1] == ("0.4.1", device_id)
