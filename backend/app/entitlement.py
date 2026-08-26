from __future__ import annotations

import hashlib
import struct
from datetime import UTC, datetime
from uuid import UUID

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from psycopg import AsyncConnection

from .billing import BillingError
from .config import Settings
from .crypto import b64url_decode_exact, b64url_encode
from .models import (
    DeviceEntitlementAcknowledge,
    DeviceEntitlementAcknowledgeResponse,
    DeviceEntitlementRequest,
    DeviceEntitlementResponse,
)
from .service import ProvisioningService


ENTITLEMENT_VERSION = 1
ENTITLEMENT_FINDER_CAPABILITY = 0x01
ENTITLEMENT_PACKET_SIZE = 135
ENTITLEMENT_BODY_SIZE = 62
ENTITLEMENT_SIGNATURE_OFFSET = 63
ENTITLEMENT_SIGNATURE_MAX_SIZE = 72


def build_entitlement(
    *,
    serial_number: str,
    subscription_id: UUID,
    issued_at: datetime,
    expires_at: datetime,
    counter: int,
    private_key: ec.EllipticCurvePrivateKey,
) -> bytes:
    issued_epoch = int(issued_at.astimezone(UTC).timestamp())
    expires_epoch = int(expires_at.astimezone(UTC).timestamp())
    serial = serial_number.encode("ascii")
    if len(serial) != 16:
        raise ValueError("Entitlement serial numbers must be 16 ASCII bytes")
    if not 0 < counter <= 0xFFFFFFFFFFFFFFFF:
        raise ValueError("Entitlement counters must be positive uint64 values")
    if expires_epoch <= issued_epoch:
        raise ValueError("Entitlement expiry must be after issuance")
    if private_key.curve.name != "secp256r1":
        raise ValueError("Entitlement signing requires P-256")

    body = struct.pack(
        ">BB16s16sQQQI",
        ENTITLEMENT_VERSION,
        ENTITLEMENT_FINDER_CAPABILITY,
        serial,
        subscription_id.bytes,
        issued_epoch,
        expires_epoch,
        counter,
        ENTITLEMENT_FINDER_CAPABILITY,
    )
    if len(body) != ENTITLEMENT_BODY_SIZE:
        raise AssertionError("Entitlement body format drifted")
    signature = private_key.sign(body, ec.ECDSA(hashes.SHA256()))
    if not 1 <= len(signature) <= ENTITLEMENT_SIGNATURE_MAX_SIZE:
        raise ValueError("Unexpected entitlement signature size")
    packet = (
        body
        + bytes((len(signature),))
        + signature.ljust(ENTITLEMENT_SIGNATURE_MAX_SIZE, b"\x00")
    )
    if len(packet) != ENTITLEMENT_PACKET_SIZE:
        raise AssertionError("Entitlement packet format drifted")
    return packet


class EntitlementService:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.provisioning = ProvisioningService(settings)

    async def issue(
        self,
        connection: AsyncConnection,
        *,
        user_id: UUID,
        device_id: UUID,
        request: DeviceEntitlementRequest,
    ) -> DeviceEntitlementResponse:
        device_query = await connection.execute(
            """
            SELECT d.id, d.serial_number, d.status, d.entitlement_counter,
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
             FOR UPDATE OF d
            """,
            (user_id, device_id),
        )
        device = await device_query.fetchone()
        if device is None:
            raise BillingError("TAG_UNAVAILABLE", 404)
        if device["serial_number"] != request.serial_number:
            raise BillingError("DEVICE_AUTHORIZATION_REJECTED", 403)
        if device["status"] not in {"claimed", "suspended"}:
            raise BillingError("TAG_NOT_READY", 409)
        if not self.settings.dev_bypass_bootstrap_auth and (
            device["bootstrap_key_ciphertext"] is None
            or device["bootstrap_key_nonce"] is None
            or device["bootstrap_key_envelope_version"] is None
        ):
            raise BillingError("DEVICE_AUTHORIZATION_REJECTED", 403)

        authorization_proof = self.provisioning._authorization_proof(
            device, request.tag_challenge_base64url
        )
        now = datetime.now(UTC)
        subscription_query = await connection.execute(
            """
            SELECT id, starts_at, current_period_end
              FROM public.subscription
             WHERE user_id = %s
               AND device_id = %s
               AND status IN ('active', 'trialing')
               AND starts_at <= %s
               AND current_period_end > %s
             ORDER BY current_period_end DESC
             LIMIT 1
             FOR UPDATE
            """,
            (user_id, device_id, now, now),
        )
        subscription = await subscription_query.fetchone()
        if subscription is None:
            raise BillingError("SUBSCRIPTION_REQUIRED", 402)
        if self.settings.entitlement_private_key is None:
            raise BillingError("ENTITLEMENT_UNAVAILABLE", 503)

        period_end = subscription["current_period_end"]
        if period_end.tzinfo is None:
            period_end = period_end.replace(tzinfo=UTC)
        counter_query = await connection.execute(
            """
            UPDATE public.device
               SET entitlement_counter = entitlement_counter + 1,
                   updated_at = now()
             WHERE id = %s
         RETURNING entitlement_counter
            """,
            (device_id,),
        )
        counter_row = await counter_query.fetchone()
        if counter_row is None:
            raise BillingError("TAG_UNAVAILABLE", 404)
        counter = int(counter_row["entitlement_counter"])
        packet = build_entitlement(
            serial_number=request.serial_number,
            subscription_id=UUID(str(subscription["id"])),
            issued_at=now,
            expires_at=period_end,
            counter=counter,
            private_key=self.settings.entitlement_private_key,
        )
        packet_digest = hashlib.sha256(packet).digest()
        await connection.execute(
            """
            INSERT INTO public.device_entitlement_sync (
                user_id, device_id, subscription_id,
                entitlement_expires_at, status, issued_counter,
                packet_sha256, issued_at
            ) VALUES (%s, %s, %s, %s, 'issued', %s, %s, %s)
            ON CONFLICT (
                subscription_id, device_id, entitlement_expires_at
            ) DO UPDATE SET
                user_id = EXCLUDED.user_id,
                status = 'issued',
                issued_counter = EXCLUDED.issued_counter,
                packet_sha256 = EXCLUDED.packet_sha256,
                issued_at = EXCLUDED.issued_at,
                installed_at = NULL,
                updated_at = now()
            """,
            (
                user_id,
                device_id,
                subscription["id"],
                period_end,
                counter,
                packet_digest.hex(),
                now,
            ),
        )
        # Keep the challenge parser here as a defensive check if this service
        # is called directly outside Pydantic request validation.
        b64url_decode_exact(request.tag_challenge_base64url, 32)
        return DeviceEntitlementResponse(
            device_id=device_id,
            serial_number=request.serial_number,
            entitlement_base64url=b64url_encode(packet),
            tag_authorization_proof_base64url=b64url_encode(authorization_proof),
            packet_sha256_base64url=b64url_encode(packet_digest),
            expires_at=period_end,
            counter=counter,
        )

    async def acknowledge(
        self,
        connection: AsyncConnection,
        *,
        user_id: UUID,
        device_id: UUID,
        request: DeviceEntitlementAcknowledge,
    ) -> DeviceEntitlementAcknowledgeResponse:
        """Record installation only after the app has read the packet back.

        The BLE client compares the complete signed packet byte-for-byte before
        sending this digest. The authenticated acknowledgement is idempotent,
        but it cannot acknowledge an older issuance after a newer counter has
        replaced it for the same billing period.
        """

        packet_digest = b64url_decode_exact(
            request.packet_sha256_base64url, 32
        ).hex()
        query = await connection.execute(
            """
            SELECT sync.id, sync.entitlement_expires_at
              FROM public.device_entitlement_sync sync
              JOIN public.ownership ownership
                ON ownership.device_id = sync.device_id
               AND ownership.user_id = %s
               AND ownership.ended_at IS NULL
             WHERE sync.user_id = %s
               AND sync.device_id = %s
               AND sync.issued_counter = %s
               AND sync.entitlement_expires_at = %s
               AND sync.packet_sha256 = %s
               AND sync.status IN ('issued', 'installed')
             FOR UPDATE OF sync
            """,
            (
                user_id,
                user_id,
                device_id,
                request.counter,
                request.expires_at,
                packet_digest,
            ),
        )
        row = await query.fetchone()
        if row is None:
            raise BillingError("ENTITLEMENT_ACK_REJECTED", 409)
        await connection.execute(
            """
            UPDATE public.device_entitlement_sync
               SET status = 'installed',
                   installed_at = COALESCE(installed_at, now()),
                   updated_at = now()
             WHERE id = %s
            """,
            (row["id"],),
        )
        return DeviceEntitlementAcknowledgeResponse(
            device_id=device_id,
            counter=request.counter,
            expires_at=row["entitlement_expires_at"],
            status="installed",
        )
