from __future__ import annotations

import hashlib
import hmac
import struct
from dataclasses import dataclass
from pathlib import Path
from uuid import UUID

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from psycopg import AsyncConnection

from .config import FIRMWARE_VERSION_PATTERN, ConfigurationError, Settings
from .crypto import b64url_decode_exact, b64url_encode
from .models import (
    FirmwareAvailabilityResponse,
    FirmwareUpdateAcknowledge,
    FirmwareUpdateAcknowledgeResponse,
    FirmwareUpdateSessionRequest,
    FirmwareUpdateSessionResponse,
)
from .service import ProvisioningService


FIRMWARE_MANIFEST_VERSION = 1
FIRMWARE_TARGET_CLASSIC_ESP32 = 1
FIRMWARE_MANIFEST_BODY_SIZE = 42
FIRMWARE_MANIFEST_SIZE = 115
FIRMWARE_SIGNATURE_MAX_SIZE = 72
FIRMWARE_PARTITION_MAX_SIZE = 0xE0000


class FirmwareError(RuntimeError):
    def __init__(self, code: str, status_code: int) -> None:
        super().__init__(code)
        self.code = code
        self.status_code = status_code


@dataclass(frozen=True)
class FirmwareRelease:
    version: str
    version_components: tuple[int, int, int]
    image: bytes
    image_sha256: bytes
    manifest: bytes


def parse_firmware_version(value: str) -> tuple[int, int, int] | None:
    normalized = value.strip()
    if not FIRMWARE_VERSION_PATTERN.fullmatch(normalized):
        return None
    parsed = [int(component) for component in normalized.split(".")]
    components = (parsed[0], parsed[1], parsed[2])
    if len(components) != 3 or any(component > 255 for component in components):
        return None
    return components


def build_firmware_manifest(
    *,
    version: str,
    image: bytes,
    private_key: ec.EllipticCurvePrivateKey,
) -> bytes:
    components = parse_firmware_version(version)
    if components is None:
        raise ValueError("Firmware versions must be major.minor.patch")
    if not image or len(image) > FIRMWARE_PARTITION_MAX_SIZE:
        raise ValueError("Firmware image does not fit the OTA partition")
    if image[0] != 0xE9:
        raise ValueError("Firmware image is not an ESP application image")
    if private_key.curve.name != "secp256r1":
        raise ValueError("Firmware signing requires P-256")

    image_digest = hashlib.sha256(image).digest()
    body = struct.pack(
        ">BBBBBBI32s",
        FIRMWARE_MANIFEST_VERSION,
        FIRMWARE_TARGET_CLASSIC_ESP32,
        *components,
        0,
        len(image),
        image_digest,
    )
    if len(body) != FIRMWARE_MANIFEST_BODY_SIZE:
        raise AssertionError("Firmware manifest body format drifted")
    signature = private_key.sign(body, ec.ECDSA(hashes.SHA256()))
    if not 8 <= len(signature) <= FIRMWARE_SIGNATURE_MAX_SIZE:
        raise ValueError("Unexpected firmware signature size")
    manifest = body + bytes((len(signature),)) + signature.ljust(
        FIRMWARE_SIGNATURE_MAX_SIZE, b"\x00"
    )
    if len(manifest) != FIRMWARE_MANIFEST_SIZE:
        raise AssertionError("Firmware manifest format drifted")
    return manifest


class FirmwareService:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.provisioning = ProvisioningService(settings)
        self.release = self._load_release()

    def _load_release(self) -> FirmwareRelease | None:
        if not self.settings.firmware_image_path:
            return None
        if self.settings.firmware_signing_private_key is None:
            # Availability can still report the configured release, but session
            # issuance will fail closed until the matching signer is installed.
            image_path = Path(self.settings.firmware_image_path).expanduser()
            image = self._read_image(image_path)
            components = parse_firmware_version(self.settings.firmware_version)
            if components is None:
                raise ConfigurationError("Configured firmware version is invalid")
            return FirmwareRelease(
                version=self.settings.firmware_version,
                version_components=components,
                image=image,
                image_sha256=hashlib.sha256(image).digest(),
                manifest=b"",
            )

        image_path = Path(self.settings.firmware_image_path).expanduser()
        image = self._read_image(image_path)
        components = parse_firmware_version(self.settings.firmware_version)
        if components is None:
            raise ConfigurationError("Configured firmware version is invalid")
        try:
            manifest = build_firmware_manifest(
                version=self.settings.firmware_version,
                image=image,
                private_key=self.settings.firmware_signing_private_key,
            )
        except ValueError as exc:
            raise ConfigurationError(str(exc)) from exc
        return FirmwareRelease(
            version=self.settings.firmware_version,
            version_components=components,
            image=image,
            image_sha256=hashlib.sha256(image).digest(),
            manifest=manifest,
        )

    def _published_release(self) -> FirmwareRelease | None:
        release = self.release
        return release if release is not None and release.manifest else None

    @staticmethod
    def _read_image(image_path: Path) -> bytes:
        try:
            image = image_path.read_bytes()
        except OSError as exc:
            raise ConfigurationError(
                "PINQEVA_FIRMWARE_IMAGE_PATH could not be read"
            ) from exc
        if not image or len(image) > FIRMWARE_PARTITION_MAX_SIZE or image[0] != 0xE9:
            raise ConfigurationError(
                "PINQEVA_FIRMWARE_IMAGE_PATH must be an ESP image that fits the OTA slot"
            )
        return image

    async def availability(
        self,
        connection: AsyncConnection,
        *,
        user_id: UUID,
        device_id: UUID,
    ) -> FirmwareAvailabilityResponse:
        device = await self._owned_device(connection, user_id=user_id, device_id=device_id)
        current_version = device.get("firmware_version")
        if not isinstance(current_version, str) or not current_version.strip():
            current_version = None
        release = self._published_release()
        update_available = bool(
            release
            and (
                current_version is None
                or (parse_firmware_version(current_version) or (-1, -1, -1))
                < release.version_components
            )
        )
        return FirmwareAvailabilityResponse(
            device_id=device_id,
            current_version=current_version,
            update_available=update_available,
            latest_version=release.version if release else None,
            image_size=len(release.image) if release else None,
            image_sha256_base64url=(
                b64url_encode(release.image_sha256) if release else None
            ),
        )

    async def issue_session(
        self,
        connection: AsyncConnection,
        *,
        user_id: UUID,
        device_id: UUID,
        request: FirmwareUpdateSessionRequest,
    ) -> FirmwareUpdateSessionResponse:
        release = self._published_release()
        if (
            release is None
            or self.settings.firmware_signing_private_key is None
            or not release.manifest
        ):
            raise FirmwareError("FIRMWARE_UNAVAILABLE", 503)
        device = await self._owned_device(connection, user_id=user_id, device_id=device_id)
        if device["serial_number"] != request.serial_number:
            raise FirmwareError("DEVICE_AUTHORIZATION_REJECTED", 403)
        if device["status"] != "claimed":
            raise FirmwareError("TAG_NOT_READY", 409)
        if not self.settings.dev_bypass_bootstrap_auth and (
            device["bootstrap_key_ciphertext"] is None
            or device["bootstrap_key_nonce"] is None
            or device["bootstrap_key_envelope_version"] is None
        ):
            raise FirmwareError("DEVICE_AUTHORIZATION_REJECTED", 403)

        authorization_proof = self.provisioning._authorization_proof(
            device, request.tag_challenge_base64url
        )
        await connection.execute(
            """
            UPDATE public.device
               SET firmware_version = %s, updated_at = now()
             WHERE id = %s
            """,
            (request.current_version, device_id),
        )
        current_components = parse_firmware_version(request.current_version)
        if current_components is None or current_components > release.version_components:
            raise FirmwareError("FIRMWARE_UP_TO_DATE", 409)

        return FirmwareUpdateSessionResponse(
            device_id=device_id,
            serial_number=request.serial_number,
            version=release.version,
            install_required=current_components < release.version_components,
            image_size=len(release.image),
            image_sha256_base64url=b64url_encode(release.image_sha256),
            manifest_base64url=b64url_encode(release.manifest),
            tag_authorization_proof_base64url=b64url_encode(authorization_proof),
            image_url=f"/v1/devices/{device_id}/firmware/image?version={release.version}",
        )

    async def image_for_download(
        self,
        connection: AsyncConnection,
        *,
        user_id: UUID,
        device_id: UUID,
        version: str,
    ) -> FirmwareRelease:
        release = self._published_release()
        if release is None or version != release.version:
            raise FirmwareError("FIRMWARE_NOT_FOUND", 404)
        await self._owned_device(connection, user_id=user_id, device_id=device_id)
        return release

    async def acknowledge(
        self,
        connection: AsyncConnection,
        *,
        user_id: UUID,
        device_id: UUID,
        request: FirmwareUpdateAcknowledge,
    ) -> FirmwareUpdateAcknowledgeResponse:
        release = self._published_release()
        supplied_digest = b64url_decode_exact(
            request.image_sha256_base64url, 32
        )
        if (
            release is None
            or request.version != release.version
            or not hmac.compare_digest(supplied_digest, release.image_sha256)
        ):
            raise FirmwareError("FIRMWARE_ACK_REJECTED", 409)
        await self._owned_device(connection, user_id=user_id, device_id=device_id)
        updated = await connection.execute(
            """
            UPDATE public.device
               SET firmware_version = %s, updated_at = now()
             WHERE id = %s
         RETURNING id
            """,
            (release.version, device_id),
        )
        if await updated.fetchone() is None:
            raise FirmwareError("FIRMWARE_ACK_REJECTED", 409)
        return FirmwareUpdateAcknowledgeResponse(
            device_id=device_id,
            version=release.version,
            status="installed",
        )

    @staticmethod
    async def _owned_device(
        connection: AsyncConnection,
        *,
        user_id: UUID,
        device_id: UUID,
    ) -> dict:
        query = await connection.execute(
            """
            SELECT d.id, d.serial_number, d.status, d.firmware_version,
                   dbc.key_ciphertext AS bootstrap_key_ciphertext,
                   dbc.key_nonce AS bootstrap_key_nonce,
                   dbc.envelope_version AS bootstrap_key_envelope_version
              FROM public.device d
              JOIN public.ownership o
                ON o.device_id = d.id
               AND o.user_id = %s
               AND o.ended_at IS NULL
              LEFT JOIN public.device_bootstrap_credential dbc
                ON dbc.device_id = d.id
             WHERE d.id = %s
            """,
            (user_id, device_id),
        )
        device = await query.fetchone()
        if device is None:
            raise FirmwareError("TAG_UNAVAILABLE", 404)
        return device
