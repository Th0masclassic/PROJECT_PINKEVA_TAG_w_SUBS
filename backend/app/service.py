from __future__ import annotations

import hmac
import logging
import os
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from uuid import UUID

from cryptography.exceptions import InvalidTag
from psycopg import AsyncConnection
from psycopg.errors import UniqueViolation

from .config import Settings
from .crypto import (
    EncryptedSecret,
    b64url_decode_exact,
    b64url_encode,
    claim_completion_token,
    decrypt_device_bootstrap_key,
    encrypt_google_identity_key,
    encrypt_private_key,
    generate_finder_key_bundle,
    generate_google_finder_key_bundle,
    release_completion_token,
    tag_authorization_proof,
    tag_control_key,
    tag_reset_command,
)
from .models import (
    DeviceClaimComplete,
    DeviceClaimResponse,
    DeviceClaimStart,
    DeviceClaimStartResponse,
    DeviceProvisioningRequestResponse,
    DeviceProvisioningRequestStart,
    DeviceReleaseComplete,
    DeviceReleaseResponse,
    DeviceReleaseStart,
    DeviceReleaseStartResponse,
)


class ProvisioningError(RuntimeError):
    def __init__(self, code: str, message: str, status_code: int) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class ProvisioningService:
    settings: Settings

    def _associated_data(self, session_id: UUID, user_id: UUID, device_id: UUID) -> bytes:
        return f"pinqeva:v1:{session_id}:{user_id}:{device_id}".encode("ascii")

    def _google_associated_data(
        self, session_id: UUID, user_id: UUID, device_id: UUID
    ) -> bytes:
        return f"pinqeva:google-eik:v1:{session_id}:{user_id}:{device_id}".encode(
            "ascii"
        )

    async def start_provisioning_request(
        self,
        connection: AsyncConnection,
        *,
        user_id: UUID,
        idempotency_key: str,
        request: DeviceProvisioningRequestStart,
    ) -> DeviceProvisioningRequestResponse:
        """Create a payment gate without allocating or returning any key material."""

        device_query = await connection.execute(
            """
            SELECT d.id, d.id AS device_id, d.serial_number, d.provisioning_session_id,
                   dbc.key_ciphertext AS bootstrap_key_ciphertext,
                   dbc.key_nonce AS bootstrap_key_nonce,
                   dbc.envelope_version AS bootstrap_key_envelope_version,
                   (
                       SELECT o.user_id FROM public.ownership o
                        WHERE o.device_id = d.id AND o.ended_at IS NULL
                        LIMIT 1
                   ) AS owner_user_id
              FROM public.device d
              LEFT JOIN public.device_bootstrap_credential dbc
                ON dbc.device_id = d.id
             WHERE d.serial_number = %s
             FOR UPDATE OF d
            """,
            (request.serial_number,),
        )
        device = await device_query.fetchone()
        if device is None:
            logger.warning(
                "Provisioning authorization rejected: device serial is not registered"
            )
            raise ProvisioningError(
                "DEVICE_AUTHORIZATION_REJECTED",
                "The tag identity or factory authorization could not be verified",
                403,
            )
        if not self.settings.dev_bypass_bootstrap_auth and (
            device["bootstrap_key_ciphertext"] is None
            or device["bootstrap_key_nonce"] is None
            or device["bootstrap_key_envelope_version"] is None
        ):
            logger.warning(
                "Provisioning authorization rejected: device bootstrap credential is missing"
            )
            raise ProvisioningError(
                "DEVICE_AUTHORIZATION_REJECTED",
                "The tag identity or factory authorization could not be verified",
                403,
            )

        # This decrypts the manufacturing credential and verifies the supplied
        # challenge, but the proof is deliberately not returned or persisted.
        self._authorization_proof(device, request.tag_challenge_base64url)

        if (
            request.tag_advertisement_key_sha256_base64url is not None
            or request.tag_google_advertisement_key_sha256_base64url is not None
            or request.tag_finding_network is not None
        ):
            raise ProvisioningError(
                "RECOVERY_REQUIRED",
                "The tag contains an unrecognized key and must not be overwritten",
                409,
            )

        subscription_query = await connection.execute(
            """
            SELECT id, plan_code FROM public.subscription
             WHERE user_id = %s
               AND status IN ('active', 'trialing')
               AND starts_at <= now()
               AND current_period_end > now()
             FOR UPDATE
            """,
            (user_id,),
        )
        account_subscription = await subscription_query.fetchone()

        existing_query = await connection.execute(
            """
            SELECT id, device_id, serial_number, status, plan_code,
                   expires_at, claim_deadline
              FROM public.provisioning_request
             WHERE user_id = %s AND idempotency_key = %s
             FOR UPDATE
            """,
            (user_id, idempotency_key),
        )
        existing = await existing_query.fetchone()
        if existing is not None:
            if (
                existing["device_id"] != device["id"]
                or existing["serial_number"] != request.serial_number
            ):
                raise ProvisioningError(
                    "IDEMPOTENCY_CONFLICT",
                    "This idempotency key was already used for a different request",
                    409,
                )
            if (
                account_subscription is not None
                and existing["status"] in {"pending", "creating", "open"}
            ):
                activated_query = await connection.execute(
                    """
                    UPDATE public.provisioning_request
                       SET status = 'paid', plan_code = %s,
                           subscription_id = %s,
                           claim_deadline = now() + (%s * interval '1 second'),
                           paid_at = COALESCE(paid_at, now()), updated_at = now()
                     WHERE id = %s
                     RETURNING id, device_id, serial_number, status, plan_code,
                               expires_at, claim_deadline
                    """,
                    (
                        account_subscription["plan_code"],
                        account_subscription["id"],
                        self.settings.claim_ttl_seconds,
                        existing["id"],
                    ),
                )
                existing = await activated_query.fetchone()
            return self._provisioning_request_response(existing)

        # Expired unpaid requests no longer hold the one-request-per-device
        # slot. Paid/claiming requests are retained and must be resumed.
        await connection.execute(
            """
            UPDATE public.provisioning_request
               SET status = 'expired', updated_at = now()
             WHERE device_id = %s
               AND status IN ('pending', 'creating', 'open')
               AND expires_at <= now()
            """,
            (device["id"],),
        )

        active_query = await connection.execute(
            """
            SELECT id, user_id, device_id, serial_number, status, plan_code,
                   expires_at, claim_deadline
              FROM public.provisioning_request
             WHERE device_id = %s
               AND status IN ('pending', 'creating', 'open', 'paid', 'claiming')
             FOR UPDATE
            """,
            (device["id"],),
        )
        active = await active_query.fetchone()
        if active is not None:
            if (
                active["user_id"] != user_id
                or active["serial_number"] != request.serial_number
            ):
                raise ProvisioningError(
                    "DEVICE_UNAVAILABLE",
                    "The tag is unavailable",
                    409,
                )
            if (
                account_subscription is not None
                and active["status"] in {"pending", "creating", "open"}
            ):
                activated_query = await connection.execute(
                    """
                    UPDATE public.provisioning_request
                       SET status = 'paid', plan_code = %s,
                           subscription_id = %s,
                           claim_deadline = now() + (%s * interval '1 second'),
                           paid_at = COALESCE(paid_at, now()), updated_at = now()
                     WHERE id = %s
                     RETURNING id, user_id, device_id, serial_number, status,
                               plan_code, expires_at, claim_deadline
                    """,
                    (
                        account_subscription["plan_code"],
                        account_subscription["id"],
                        self.settings.claim_ttl_seconds,
                        active["id"],
                    ),
                )
                active = await activated_query.fetchone()
            # A new app session can resume the same request without creating a
            # second checkout or racing the unique device reservation.
            return self._provisioning_request_response(active)

        if device.get("owner_user_id") is not None or device.get("provisioning_session_id") is not None:
            raise ProvisioningError(
                "DEVICE_UNAVAILABLE",
                "The tag is already allocated",
                409,
            )

        try:
            request_query = await connection.execute(
                """
                INSERT INTO public.provisioning_request (
                    id, user_id, device_id, serial_number, idempotency_key,
                    status, plan_code, subscription_id,
                    expires_at, claim_deadline
                ) VALUES (
                    %s, %s, %s, %s, %s, %s, %s, %s,
                    now() + interval '45 minutes',
                    CASE WHEN %s::uuid IS NULL THEN NULL
                         ELSE now() + (%s * interval '1 second') END
                )
                RETURNING id, device_id, serial_number, status, plan_code,
                          expires_at, claim_deadline
                """,
                (
                    uuid.uuid4(),
                    user_id,
                    device["id"],
                    device["serial_number"],
                    idempotency_key,
                    "paid" if account_subscription is not None else "pending",
                    account_subscription["plan_code"] if account_subscription else None,
                    account_subscription["id"] if account_subscription else None,
                    account_subscription["id"] if account_subscription else None,
                    self.settings.claim_ttl_seconds,
                ),
            )
        except UniqueViolation:
            raise ProvisioningError(
                "PROVISIONING_IN_PROGRESS",
                "This tag already has an active provisioning request",
                409,
            ) from None
        created = await request_query.fetchone()
        if created is None:
            raise RuntimeError("Provisioning-request insert returned no row")
        return self._provisioning_request_response(created)

    async def start_claim(
        self,
        connection: AsyncConnection,
        *,
        user_id: UUID,
        idempotency_key: str,
        request: DeviceClaimStart,
    ) -> DeviceClaimStartResponse:
        # Lock the physical device before inspecting or allocating key material.
        # This makes "check then generate" one atomic operation across callers.
        device_query = await connection.execute(
            """
            SELECT d.id, d.id AS device_id, d.serial_number,
                   d.provisioning_session_id,
                   dbc.key_ciphertext AS bootstrap_key_ciphertext,
                   dbc.key_nonce AS bootstrap_key_nonce,
                   dbc.envelope_version AS bootstrap_key_envelope_version,
                   (
                       SELECT o.user_id FROM public.ownership o
                        WHERE o.device_id = d.id AND o.ended_at IS NULL
                        LIMIT 1
                   ) AS owner_user_id
              FROM public.device d
              LEFT JOIN public.device_bootstrap_credential dbc
                ON dbc.device_id = d.id
             WHERE d.serial_number = %s
             FOR UPDATE OF d
            """,
            (request.serial_number,),
        )
        device = await device_query.fetchone()
        # Use one response for unknown serials and devices missing their factory
        # bootstrap credential to avoid turning this endpoint into an inventory oracle.
        if device is None or (
            not self.settings.dev_bypass_bootstrap_auth
            and (
                device["bootstrap_key_ciphertext"] is None
                or device["bootstrap_key_nonce"] is None
                or device["bootstrap_key_envelope_version"] is None
            )
        ):
            raise ProvisioningError(
                "DEVICE_AUTHORIZATION_REJECTED",
                "The tag identity or factory authorization could not be verified",
                403,
            )
        authorization_proof = self._authorization_proof(
            device, request.tag_challenge_base64url
        )
        paid_request = await self._require_paid_provisioning_request(
            connection,
            user_id=user_id,
            device_id=device["id"],
            serial_number=request.serial_number,
            request_id=request.provisioning_request_id,
        )

        existing_idempotency_query = await connection.execute(
            """
            SELECT id, user_id, device_id, serial_number, advertisement_key,
                   advertisement_key_sha256, google_advertisement_key,
                   google_advertisement_key_sha256, finding_network,
                   status, expires_at, claim_deadline,
                   completed_at, provisioning_request_id
              FROM public.provisioning_session
             WHERE user_id = %s AND idempotency_key = %s
             FOR UPDATE
            """,
            (user_id, idempotency_key),
        )
        if existing := await existing_idempotency_query.fetchone():
            if (
                existing["device_id"] != device["id"]
                or existing["serial_number"] != request.serial_number
            ):
                raise ProvisioningError(
                    "IDEMPOTENCY_CONFLICT",
                    "This idempotency key was already used for a different request",
                    409,
                )
            existing = await self._ensure_google_key_material(
                connection, session=existing
            )
            await self._bind_existing_session_if_safe(
                connection, device=device, session=existing
            )
            return await self._resume_claim(
                connection,
                user_id=user_id,
                request=request,
                session=existing,
                authorization_proof=authorization_proof,
            )

        # provisioning_session_id is a permanent allocation marker, set in the
        # same transaction that creates the key. It is intentionally not delayed
        # until ownership completion because the key may already be on the tag.
        if device.get("provisioning_session_id") is not None:
            bound_query = await connection.execute(
                """
                SELECT id, user_id, device_id, serial_number, advertisement_key,
                       advertisement_key_sha256, google_advertisement_key,
                       google_advertisement_key_sha256, finding_network,
                       status, expires_at, claim_deadline,
                       completed_at, provisioning_request_id
                  FROM public.provisioning_session
                 WHERE id = %s
                 FOR UPDATE
                """,
                (device["provisioning_session_id"],),
            )
            bound = await bound_query.fetchone()
            if bound is None:
                raise ProvisioningError(
                    "RECOVERY_REQUIRED",
                    "The tag key binding is inconsistent and requires operator recovery",
                    409,
                )
            if bound["user_id"] != user_id:
                raise ProvisioningError(
                    "DEVICE_UNAVAILABLE", "The tag is already allocated", 409
                )
            bound = await self._ensure_google_key_material(
                connection, session=bound
            )
            await self._bind_existing_session_if_safe(
                connection, device=device, session=bound
            )
            return await self._resume_claim(
                connection,
                user_id=user_id,
                request=request,
                session=bound,
                authorization_proof=authorization_proof,
            )

        # Compatibility safety for rows created before allocation-at-start was
        # introduced. Any historical key row means a key may have reached the
        # physical tag, so it must be resumed or recovered, never regenerated.
        historical_query = await connection.execute(
            """
            SELECT id, user_id, device_id, serial_number, advertisement_key,
                   advertisement_key_sha256, google_advertisement_key,
                   google_advertisement_key_sha256, finding_network,
                   status, expires_at, claim_deadline,
                   completed_at, provisioning_request_id
              FROM public.provisioning_session
             WHERE device_id = %s
               AND status <> 'revoked'
             ORDER BY created_at DESC
             LIMIT 1
             FOR UPDATE
            """,
            (device["id"],),
        )
        if historical := await historical_query.fetchone():
            if historical["user_id"] != user_id:
                raise ProvisioningError(
                    "DEVICE_UNAVAILABLE", "The tag is already allocated", 409
                )
            historical = await self._ensure_google_key_material(
                connection, session=historical
            )
            await self._bind_existing_session_if_safe(
                connection, device=device, session=historical
            )
            return await self._resume_claim(
                connection,
                user_id=user_id,
                request=request,
                session=historical,
                authorization_proof=authorization_proof,
            )

        if device.get("owner_user_id") is not None:
            raise ProvisioningError(
                "DEVICE_UNAVAILABLE",
                "The tag is already owned",
                409,
            )

        if (
            request.tag_advertisement_key_sha256_base64url is not None
            or request.tag_google_advertisement_key_sha256_base64url is not None
            or request.tag_finding_network is not None
        ):
            raise ProvisioningError(
                "RECOVERY_REQUIRED",
                "The tag contains an unrecognized key and must not be overwritten",
                409,
            )

        now = datetime.now(UTC)
        session_id = uuid.uuid4()
        expires_at = now + timedelta(seconds=self.settings.session_ttl_seconds)
        claim_deadline = now + timedelta(seconds=self.settings.claim_ttl_seconds)
        bundle = generate_finder_key_bundle()
        encrypted_private = encrypt_private_key(
            bundle.private_key,
            self.settings.key_encryption_key,
            self._associated_data(session_id, user_id, device["id"]),
        )
        google_bundle = generate_google_finder_key_bundle()
        encrypted_google_identity = encrypt_google_identity_key(
            google_bundle.identity_key,
            self.settings.key_encryption_key,
            self._google_associated_data(session_id, user_id, device["id"]),
        )

        try:
            insert_query = await connection.execute(
                """
                INSERT INTO public.provisioning_session (
                    id, user_id, device_id, serial_number, idempotency_key,
                    provisioning_request_id,
                    protocol_version, private_key_ciphertext, private_key_nonce,
                    private_key_envelope_version, public_key, advertisement_key,
                    advertisement_key_sha256,
                    google_identity_key_ciphertext, google_identity_key_nonce,
                    google_identity_key_envelope_version,
                    google_advertisement_key,
                    google_advertisement_key_sha256, finding_network,
                    status, expires_at, claim_deadline
                ) VALUES (
                    %s, %s, %s, %s, %s,
                    %s,
                    1, %s, %s, %s, %s, %s,
                    %s,
                    %s, %s, %s, %s, %s, %s,
                    'pending', %s, %s
                )
                RETURNING id, user_id, device_id, serial_number,
                          advertisement_key, advertisement_key_sha256,
                          google_advertisement_key,
                          google_advertisement_key_sha256, finding_network, status,
                          expires_at, claim_deadline, completed_at,
                          provisioning_request_id
                """,
                (
                    session_id,
                    user_id,
                    device["id"],
                    device["serial_number"],
                    idempotency_key,
                    paid_request["id"],
                    encrypted_private.ciphertext,
                    encrypted_private.nonce,
                    encrypted_private.version,
                    bundle.public_key,
                    bundle.advertisement_key,
                    bundle.advertisement_key_sha256,
                    encrypted_google_identity.ciphertext,
                    encrypted_google_identity.nonce,
                    encrypted_google_identity.version,
                    google_bundle.advertisement_key,
                    google_bundle.advertisement_key_sha256,
                    request.finding_network,
                    expires_at,
                    claim_deadline,
                ),
            )
            session = await insert_query.fetchone()
        except UniqueViolation:
            raise ProvisioningError(
                "PROVISIONING_IN_PROGRESS",
                "This tag already has an active provisioning attempt",
                409,
            ) from None

        if session is None:
            raise RuntimeError("Provisioning-session insert returned no row")
        await connection.execute(
            """
            UPDATE public.device
               SET provisioning_session_id = %s,
                   status = 'provisioning',
                   finding_network = %s,
                   updated_at = %s
             WHERE id = %s AND provisioning_session_id IS NULL
            """,
            (session_id, request.finding_network, now, device["id"]),
        )
        await connection.execute(
            """
            UPDATE public.provisioning_request
               SET status = 'claiming', updated_at = now()
             WHERE id = %s AND status = 'paid'
            """,
            (paid_request["id"],),
        )
        return self._start_response(
            session, user_id, "write_key", authorization_proof
        )

    async def complete_claim(
        self,
        connection: AsyncConnection,
        *,
        user_id: UUID,
        request: DeviceClaimComplete,
    ) -> DeviceClaimResponse:
        session_query = await connection.execute(
            """
            SELECT ps.id, ps.device_id, ps.serial_number, ps.status,
                   ps.advertisement_key_sha256,
                   ps.google_advertisement_key_sha256, ps.finding_network,
                   ps.claim_deadline,
                   ps.completed_at, ps.provisioning_request_id,
                   d.provisioning_session_id
              FROM public.provisioning_session ps
              JOIN public.device d ON d.id = ps.device_id
             WHERE ps.id = %s AND ps.user_id = %s
             FOR UPDATE OF ps, d
            """,
            (request.session_id, user_id),
        )
        session = await session_query.fetchone()
        if session is None:
            raise ProvisioningError(
                "SESSION_NOT_FOUND", "The provisioning session was not found", 404
            )

        supplied_hash = b64url_decode_exact(
            request.tag_advertisement_key_sha256_base64url, 32
        )
        supplied_google_hash = b64url_decode_exact(
            request.tag_google_advertisement_key_sha256_base64url, 32
        )
        supplied_token = b64url_decode_exact(
            request.claim_completion_token_base64url, 32
        )
        expected_hash = bytes(session["advertisement_key_sha256"])
        expected_google_hash = bytes(session["google_advertisement_key_sha256"])
        expected_token = self._completion_token(
            session_id=session["id"],
            user_id=user_id,
            device_id=session["device_id"],
            advertisement_key_sha256=expected_hash,
            google_advertisement_key_sha256=expected_google_hash,
            finding_network=session["finding_network"],
        )
        if (
            request.serial_number != session["serial_number"]
            or not hmac.compare_digest(supplied_hash, expected_hash)
            or not hmac.compare_digest(
                supplied_google_hash, expected_google_hash
            )
            or request.finding_network != session["finding_network"]
            or not hmac.compare_digest(supplied_token, expected_token)
        ):
            raise ProvisioningError(
                "CLAIM_PROOF_REJECTED",
                "The claim completion proof could not be verified",
                403,
            )

        if session["status"] == "claimed":
            return DeviceClaimResponse(
                device_id=session["device_id"],
                serial_number=session["serial_number"],
                status="claimed",
                claimed_at=session["completed_at"],
                next_action="ready",
                finding_network=session["finding_network"],
            )
        if session["status"] != "pending" or session["claim_deadline"] <= datetime.now(UTC):
            raise ProvisioningError(
                "RECOVERY_REQUIRED",
                "The allocation can no longer be completed automatically",
                409,
            )
        if session["provisioning_session_id"] != session["id"]:
            raise ProvisioningError(
                "RECOVERY_REQUIRED",
                "The tag key binding is inconsistent and requires operator recovery",
                409,
            )

        ownership_query = await connection.execute(
            """
            SELECT user_id FROM public.ownership
             WHERE device_id = %s AND ended_at IS NULL
             FOR UPDATE
            """,
            (session["device_id"],),
        )
        ownership = await ownership_query.fetchone()
        if ownership is not None and ownership["user_id"] != user_id:
            raise ProvisioningError(
                "DEVICE_UNAVAILABLE", "The tag is already owned", 409
            )

        claimed_at = datetime.now(UTC)
        if ownership is None:
            await connection.execute(
                """
                INSERT INTO public.ownership (user_id, device_id, started_at)
                VALUES (%s, %s, %s)
                """,
                (user_id, session["device_id"], claimed_at),
            )
        await connection.execute(
            """
            UPDATE public.device
               SET provisioning_session_id = %s,
                   status = 'claimed',
                   finding_network = %s,
                   updated_at = %s
             WHERE id = %s
            """,
            (
                session["id"],
                session["finding_network"],
                claimed_at,
                session["device_id"],
            ),
        )
        await connection.execute(
            """
            UPDATE public.provisioning_session
               SET status = 'claimed', completed_at = %s
             WHERE id = %s
            """,
            (claimed_at, session["id"]),
        )
        if session.get("provisioning_request_id") is not None:
            await connection.execute(
                """
                UPDATE public.provisioning_request
                   SET status = 'completed', completed_at = %s, updated_at = %s
                 WHERE id = %s AND user_id = %s
                """,
                (
                    claimed_at,
                    claimed_at,
                    session["provisioning_request_id"],
                    user_id,
                ),
            )

        return DeviceClaimResponse(
            device_id=session["device_id"],
            serial_number=session["serial_number"],
            status="claimed",
            claimed_at=claimed_at,
            next_action="ready",
            finding_network=session["finding_network"],
        )

    async def start_release(
        self,
        connection: AsyncConnection,
        *,
        user_id: UUID,
        device_id: UUID,
        idempotency_key: str,
        request: DeviceReleaseStart,
    ) -> DeviceReleaseStartResponse:
        idempotent_query = await connection.execute(
            """
            SELECT dr.id, dr.user_id, dr.device_id, dr.provisioning_session_id,
                   dr.serial_number, dr.reset_nonce, dr.status, dr.expires_at,
                   ps.advertisement_key_sha256,
                   ps.google_advertisement_key_sha256, ps.finding_network,
                   dbc.key_ciphertext AS bootstrap_key_ciphertext,
                   dbc.key_nonce AS bootstrap_key_nonce,
                   dbc.envelope_version AS bootstrap_key_envelope_version
              FROM public.device_release dr
              JOIN public.provisioning_session ps
                ON ps.id = dr.provisioning_session_id
              JOIN public.device_bootstrap_credential dbc
                ON dbc.device_id = dr.device_id
             WHERE dr.user_id = %s AND dr.idempotency_key = %s
             FOR UPDATE OF dr
            """,
            (user_id, idempotency_key),
        )
        if existing := await idempotent_query.fetchone():
            if existing["device_id"] != device_id:
                raise ProvisioningError(
                    "IDEMPOTENCY_CONFLICT",
                    "This idempotency key was already used for a different request",
                    409,
                )
            if existing["status"] != "pending" or existing["expires_at"] <= datetime.now(UTC):
                raise ProvisioningError(
                    "RECOVERY_REQUIRED",
                    "This release can no longer issue a reset command",
                    409,
                )
            self._verify_release_start_binding(request, existing)
            return self._release_start_response(
                existing,
                user_id,
                self._authorization_proof(existing, request.tag_challenge_base64url),
            )

        device_query = await connection.execute(
            """
            SELECT d.id AS device_id, d.serial_number, d.provisioning_session_id,
                   o.user_id AS owner_user_id, ps.user_id AS session_user_id,
                   ps.status AS session_status, ps.advertisement_key_sha256,
                   ps.google_advertisement_key_sha256, ps.finding_network,
                   dbc.key_ciphertext AS bootstrap_key_ciphertext,
                   dbc.key_nonce AS bootstrap_key_nonce,
                   dbc.envelope_version AS bootstrap_key_envelope_version
              FROM public.device d
              JOIN public.ownership o
                ON o.device_id = d.id AND o.ended_at IS NULL
              JOIN public.provisioning_session ps
                ON ps.id = d.provisioning_session_id
              JOIN public.device_bootstrap_credential dbc
                ON dbc.device_id = d.id
             WHERE d.id = %s
             FOR UPDATE OF d, o, ps
            """,
            (device_id,),
        )
        device = await device_query.fetchone()
        # A generic 404 avoids revealing whether another user owns this UUID.
        if device is None or device["owner_user_id"] != user_id:
            raise ProvisioningError(
                "OWNED_DEVICE_NOT_FOUND", "The owned device was not found", 404
            )
        if device["session_user_id"] != user_id or device["session_status"] != "claimed":
            raise ProvisioningError(
                "RECOVERY_REQUIRED",
                "The ownership and key allocation are inconsistent",
                409,
            )
        self._verify_release_start_binding(request, device)

        active_release_query = await connection.execute(
            """
            SELECT dr.id, dr.user_id, dr.device_id, dr.provisioning_session_id,
                   dr.serial_number, dr.reset_nonce, dr.status, dr.expires_at,
                   ps.advertisement_key_sha256,
                   ps.google_advertisement_key_sha256, ps.finding_network,
                   dbc.key_ciphertext AS bootstrap_key_ciphertext,
                   dbc.key_nonce AS bootstrap_key_nonce,
                   dbc.envelope_version AS bootstrap_key_envelope_version
              FROM public.device_release dr
              JOIN public.provisioning_session ps
                ON ps.id = dr.provisioning_session_id
              JOIN public.device_bootstrap_credential dbc
                ON dbc.device_id = dr.device_id
             WHERE dr.device_id = %s AND dr.status = 'pending'
             FOR UPDATE OF dr
            """,
            (device_id,),
        )
        if active := await active_release_query.fetchone():
            if active["user_id"] != user_id:
                raise ProvisioningError(
                    "DEVICE_UNAVAILABLE", "The device has an active release", 409
                )
            if active["expires_at"] <= datetime.now(UTC):
                raise ProvisioningError(
                    "RECOVERY_REQUIRED",
                    "The active release expired and requires operator recovery",
                    409,
                )
            self._verify_release_start_binding(request, active)
            return self._release_start_response(
                active,
                user_id,
                self._authorization_proof(active, request.tag_challenge_base64url),
            )

        now = datetime.now(UTC)
        release_id = uuid.uuid4()
        reset_nonce = os.urandom(32)
        expires_at = now + timedelta(seconds=self.settings.claim_ttl_seconds)
        release_query = await connection.execute(
            """
            INSERT INTO public.device_release (
                id, user_id, device_id, provisioning_session_id, serial_number,
                idempotency_key, reset_nonce, status, expires_at
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, 'pending', %s)
            RETURNING id, user_id, device_id, provisioning_session_id,
                      serial_number, reset_nonce, status, expires_at
            """,
            (
                release_id,
                user_id,
                device_id,
                device["provisioning_session_id"],
                device["serial_number"],
                idempotency_key,
                reset_nonce,
                expires_at,
            ),
        )
        release = await release_query.fetchone()
        if release is None:
            raise RuntimeError("Device-release insert returned no row")
        release = dict(release)
        release["advertisement_key_sha256"] = device["advertisement_key_sha256"]
        release["google_advertisement_key_sha256"] = device[
            "google_advertisement_key_sha256"
        ]
        release["finding_network"] = device["finding_network"]
        release["bootstrap_key_ciphertext"] = device["bootstrap_key_ciphertext"]
        release["bootstrap_key_nonce"] = device["bootstrap_key_nonce"]
        release["bootstrap_key_envelope_version"] = device[
            "bootstrap_key_envelope_version"
        ]
        return self._release_start_response(
            release,
            user_id,
            self._authorization_proof(release, request.tag_challenge_base64url),
        )

    async def complete_release(
        self,
        connection: AsyncConnection,
        *,
        user_id: UUID,
        device_id: UUID,
        request: DeviceReleaseComplete,
    ) -> DeviceReleaseResponse:
        release_query = await connection.execute(
            """
            SELECT dr.id, dr.user_id, dr.device_id, dr.provisioning_session_id,
                   dr.serial_number, dr.reset_nonce, dr.status, dr.expires_at,
                   dr.completed_at, dr.cancelled_subscriptions,
                   dr.provider_cancellations_queued,
                   d.provisioning_session_id AS current_session_id
              FROM public.device_release dr
              JOIN public.device d ON d.id = dr.device_id
             WHERE dr.id = %s AND dr.user_id = %s AND dr.device_id = %s
             FOR UPDATE OF dr, d
            """,
            (request.release_id, user_id, device_id),
        )
        release = await release_query.fetchone()
        if release is None:
            raise ProvisioningError(
                "RELEASE_NOT_FOUND", "The device release was not found", 404
            )

        supplied_token = b64url_decode_exact(
            request.release_completion_token_base64url, 32
        )
        expected_token = self._release_completion_token(release, user_id)
        if (
            request.serial_number != release["serial_number"]
            or not hmac.compare_digest(supplied_token, expected_token)
        ):
            raise ProvisioningError(
                "RELEASE_PROOF_REJECTED",
                "The release completion proof could not be verified",
                403,
            )

        if release["status"] == "completed":
            return self._release_response(release)
        if release["status"] != "pending" or release["expires_at"] <= datetime.now(UTC):
            raise ProvisioningError(
                "RECOVERY_REQUIRED",
                "The tag may be reset but the release requires operator recovery",
                409,
            )
        if release["current_session_id"] != release["provisioning_session_id"]:
            raise ProvisioningError(
                "RECOVERY_REQUIRED", "The active ownership changed during release", 409
            )

        ownership_query = await connection.execute(
            """
            SELECT user_id FROM public.ownership
             WHERE device_id = %s AND ended_at IS NULL
             FOR UPDATE
            """,
            (device_id,),
        )
        ownership = await ownership_query.fetchone()
        if ownership is None or ownership["user_id"] != user_id:
            raise ProvisioningError(
                "RECOVERY_REQUIRED", "The active ownership changed during release", 409
            )

        released_at = datetime.now(UTC)
        # Billing belongs to the account. Releasing one physical tag revokes
        # only that tag's ownership and key material.
        cancelled_count = 0
        queued_count = 0

        await connection.execute(
            """
            UPDATE public.ownership
               SET ended_at = %s
             WHERE device_id = %s AND user_id = %s AND ended_at IS NULL
            """,
            (released_at, device_id, user_id),
        )
        await connection.execute(
            """
            UPDATE public.provisioning_session
               SET status = 'revoked', revoked_at = %s
             WHERE id = %s AND status = 'claimed'
            """,
            (released_at, release["provisioning_session_id"]),
        )
        await connection.execute(
            """
            UPDATE public.device
               SET provisioning_session_id = NULL,
                   status = 'unprovisioned',
                   finding_network = NULL,
                   updated_at = %s
             WHERE id = %s AND provisioning_session_id = %s
            """,
            (released_at, device_id, release["provisioning_session_id"]),
        )
        await connection.execute(
            """
            UPDATE public.device_release
               SET status = 'completed', completed_at = %s,
                   cancelled_subscriptions = %s,
                   provider_cancellations_queued = %s
             WHERE id = %s AND status = 'pending'
            """,
            (released_at, cancelled_count, queued_count, release["id"]),
        )
        completed = dict(release)
        completed.update(
            status="completed",
            completed_at=released_at,
            cancelled_subscriptions=cancelled_count,
            provider_cancellations_queued=queued_count,
        )
        return self._release_response(completed)

    async def _bind_existing_session_if_safe(
        self, connection: AsyncConnection, *, device: dict, session: dict
    ) -> None:
        owner_user_id = device.get("owner_user_id")
        if (
            session["status"] == "claimed"
            and owner_user_id != session["user_id"]
        ) or (session["status"] == "pending" and owner_user_id is not None):
            raise ProvisioningError(
                "RECOVERY_REQUIRED",
                "The key allocation and active ownership are inconsistent",
                409,
            )
        binding = device.get("provisioning_session_id")
        if binding not in (None, session["id"]):
            raise ProvisioningError(
                "RECOVERY_REQUIRED",
                "The tag has multiple key allocations and requires operator recovery",
                409,
            )
        if binding is None:
            await connection.execute(
                """
                UPDATE public.device
                   SET provisioning_session_id = %s,
                       status = CASE
                           WHEN %s = 'claimed' THEN 'claimed'
                           ELSE 'provisioning'
                       END,
                       finding_network = %s,
                       updated_at = now()
                 WHERE id = %s AND provisioning_session_id IS NULL
                """,
                (
                    session["id"],
                    session["status"],
                    session["finding_network"],
                    device["id"],
                ),
            )

    async def _ensure_google_key_material(
        self, connection: AsyncConnection, *, session: dict
    ) -> dict:
        if session.get("google_advertisement_key") is not None:
            if session.get("google_advertisement_key_sha256") is None:
                raise ProvisioningError(
                    "RECOVERY_REQUIRED",
                    "The Google key binding is incomplete and requires operator recovery",
                    409,
                )
            return session

        bundle = generate_google_finder_key_bundle()
        encrypted = encrypt_google_identity_key(
            bundle.identity_key,
            self.settings.key_encryption_key,
            self._google_associated_data(
                session["id"], session["user_id"], session["device_id"]
            ),
        )
        await connection.execute(
            """
            UPDATE public.provisioning_session
               SET google_identity_key_ciphertext = %s,
                   google_identity_key_nonce = %s,
                   google_identity_key_envelope_version = %s,
                   google_advertisement_key = %s,
                   google_advertisement_key_sha256 = %s
             WHERE id = %s
               AND google_advertisement_key IS NULL
            """,
            (
                encrypted.ciphertext,
                encrypted.nonce,
                encrypted.version,
                bundle.advertisement_key,
                bundle.advertisement_key_sha256,
                session["id"],
            ),
        )
        updated = dict(session)
        updated["google_advertisement_key"] = bundle.advertisement_key
        updated["google_advertisement_key_sha256"] = (
            bundle.advertisement_key_sha256
        )
        return updated

    async def _resume_claim(
        self,
        connection: AsyncConnection,
        *,
        user_id: UUID,
        request: DeviceClaimStart,
        session: dict,
        authorization_proof: bytes,
    ) -> DeviceClaimStartResponse:
        if session["status"] not in {"pending", "claimed"}:
            raise ProvisioningError(
                "RECOVERY_REQUIRED",
                "The previous key allocation requires operator recovery",
                409,
            )
        if request.finding_network != session["finding_network"]:
            raise ProvisioningError(
                "FINDING_NETWORK_MISMATCH",
                "This allocation was created for a different finding network",
                409,
            )
        if (
            request.tag_finding_network is not None
            and request.tag_finding_network != session["finding_network"]
        ):
            raise ProvisioningError(
                "FINDING_NETWORK_MISMATCH",
                "The tag is configured for a different finding network",
                409,
            )

        observed_hash = (
            None
            if request.tag_advertisement_key_sha256_base64url is None
            else b64url_decode_exact(
                request.tag_advertisement_key_sha256_base64url, 32
            )
        )
        expected_hash = bytes(session["advertisement_key_sha256"])
        observed_google_hash = (
            None
            if request.tag_google_advertisement_key_sha256_base64url is None
            else b64url_decode_exact(
                request.tag_google_advertisement_key_sha256_base64url, 32
            )
        )
        expected_google_hash = bytes(
            session["google_advertisement_key_sha256"]
        )
        if observed_hash is not None and not hmac.compare_digest(
            observed_hash, expected_hash
        ):
            raise ProvisioningError(
                "TAG_KEY_MISMATCH",
                "The tag contains a different key; automatic replacement is forbidden",
                409,
            )
        if observed_google_hash is not None and not hmac.compare_digest(
            observed_google_hash, expected_google_hash
        ):
            raise ProvisioningError(
                "TAG_KEY_MISMATCH",
                "The tag contains a different Google key; automatic replacement is forbidden",
                409,
            )

        if session["status"] == "claimed":
            if observed_hash is None:
                raise ProvisioningError(
                    "RECOVERY_REQUIRED",
                    "The backend is claimed but the tag reports no stored key",
                    409,
                )
            action = (
                "verify_existing_key"
                if observed_google_hash is not None
                and request.tag_finding_network is not None
                else "write_key"
            )
            return self._start_response(session, user_id, action, authorization_proof)

        now = datetime.now(UTC)
        if session["claim_deadline"] <= now:
            raise ProvisioningError(
                "RECOVERY_REQUIRED",
                "The key may already be on the tag; physical recovery is required",
                409,
            )

        if (
            observed_hash is not None
            and observed_google_hash is not None
            and request.tag_finding_network is not None
        ):
            return self._start_response(
                session, user_id, "verify_existing_key", authorization_proof
            )

        # The tag explicitly reports empty. Re-open delivery of the exact same
        # allocated key, bounded by the original claim deadline. Never generate
        # a replacement merely because the short delivery window elapsed.
        if session["expires_at"] <= now:
            renewed_expiry = min(
                now + timedelta(seconds=self.settings.session_ttl_seconds),
                session["claim_deadline"],
            )
            await connection.execute(
                """
                UPDATE public.provisioning_session
                   SET expires_at = %s
                 WHERE id = %s AND status = 'pending'
                """,
                (renewed_expiry, session["id"]),
            )
            session = dict(session)
            session["expires_at"] = renewed_expiry
        return self._start_response(
            session, user_id, "write_key", authorization_proof
        )

    def _completion_token(
        self,
        *,
        session_id: UUID,
        user_id: UUID,
        device_id: UUID,
        advertisement_key_sha256: bytes,
        google_advertisement_key_sha256: bytes,
        finding_network: str,
    ) -> bytes:
        return claim_completion_token(
            self.settings.claim_token_key,
            session_id=session_id.bytes,
            user_id=user_id.bytes,
            device_id=device_id.bytes,
            advertisement_key_sha256=advertisement_key_sha256,
            google_advertisement_key_sha256=google_advertisement_key_sha256,
            finding_network=finding_network,
        )

    async def _require_paid_provisioning_request(
        self,
        connection: AsyncConnection,
        *,
        user_id: UUID,
        device_id: UUID,
        serial_number: str,
        request_id: UUID,
    ) -> dict:
        query = await connection.execute(
            """
            SELECT pr.id, pr.user_id, pr.device_id, pr.serial_number,
                   pr.status, pr.plan_code, pr.claim_deadline,
                   pr.replacement_claim_id,
                   account_subscription.status AS subscription_status,
                   account_subscription.starts_at,
                   account_subscription.current_period_end,
                   replacement.status AS replacement_claim_status
              FROM public.provisioning_request pr
              LEFT JOIN LATERAL (
                SELECT subscription.status, subscription.starts_at,
                       subscription.current_period_end
                  FROM public.subscription subscription
                 WHERE subscription.user_id = pr.user_id
                   AND subscription.status IN ('active', 'trialing')
                   AND subscription.starts_at <= now()
                   AND subscription.current_period_end > now()
                 ORDER BY subscription.current_period_end DESC,
                          subscription.created_at DESC
                 LIMIT 1
              ) account_subscription ON true
              LEFT JOIN public.device_replacement_claim replacement
                ON replacement.id = pr.replacement_claim_id
               AND replacement.user_id = pr.user_id
               AND replacement.replacement_device_id = pr.device_id
             WHERE pr.id = %s
               AND pr.user_id = %s
               AND pr.device_id = %s
               AND pr.serial_number = %s
             FOR UPDATE OF pr
            """,
            (request_id, user_id, device_id, serial_number),
        )
        row = await query.fetchone()
        now = datetime.now(UTC)
        if (
            row is None
            or row["status"] not in {"paid", "claiming", "completed"}
            or (
                row["status"] in {"paid", "claiming"}
                and (
                    row["claim_deadline"] is None
                    or row["claim_deadline"] <= now
                )
            )
            or not (
                (
                    row["subscription_status"] in {"active", "trialing"}
                    and row["starts_at"] <= now
                    and row["current_period_end"] > now
                )
                or row.get("replacement_claim_status") == "fulfilled"
            )
        ):
            raise ProvisioningError(
                "SUBSCRIPTION_REQUIRED",
                "An active subscription is required before key allocation",
                402,
            )
        return row

    @staticmethod
    def _provisioning_request_response(row: dict) -> DeviceProvisioningRequestResponse:
        return DeviceProvisioningRequestResponse(
            request_id=row["id"],
            device_id=row["device_id"],
            serial_number=row["serial_number"],
            status=row["status"],
            plan_code=row.get("plan_code"),
            expires_at=row["expires_at"],
            claim_deadline=row.get("claim_deadline"),
        )

    def _tag_control_key(
        self,
        *,
        session_id: UUID,
        user_id: UUID,
        device_id: UUID,
        advertisement_key_sha256: bytes,
    ) -> bytes:
        return tag_control_key(
            self.settings.claim_token_key,
            session_id=session_id.bytes,
            user_id=user_id.bytes,
            device_id=device_id.bytes,
            advertisement_key_sha256=advertisement_key_sha256,
        )

    def _start_response(
        self,
        row: dict,
        user_id: UUID,
        tag_action: str,
        authorization_proof: bytes,
    ) -> DeviceClaimStartResponse:
        advertisement_hash = bytes(row["advertisement_key_sha256"])
        google_advertisement_hash = bytes(
            row["google_advertisement_key_sha256"]
        )
        return DeviceClaimStartResponse(
            session_id=row["id"],
            serial_number=row["serial_number"],
            protocol_version=1,
            tag_action=tag_action,
            advertisement_key_base64url=b64url_encode(bytes(row["advertisement_key"])),
            advertisement_key_sha256_base64url=b64url_encode(advertisement_hash),
            google_advertisement_key_base64url=b64url_encode(
                bytes(row["google_advertisement_key"])
            ),
            google_advertisement_key_sha256_base64url=b64url_encode(
                google_advertisement_hash
            ),
            finding_network=row["finding_network"],
            tag_authorization_proof_base64url=b64url_encode(authorization_proof),
            claim_completion_token_base64url=b64url_encode(
                self._completion_token(
                    session_id=row["id"],
                    user_id=user_id,
                    device_id=row["device_id"],
                    advertisement_key_sha256=advertisement_hash,
                    google_advertisement_key_sha256=google_advertisement_hash,
                    finding_network=row["finding_network"],
                )
            ),
            tag_control_key_base64url=(
                b64url_encode(
                    self._tag_control_key(
                        session_id=row["id"],
                        user_id=user_id,
                        device_id=row["device_id"],
                        advertisement_key_sha256=advertisement_hash,
                    )
                )
                if tag_action == "write_key"
                else None
            ),
            expires_at=row["expires_at"],
            claim_deadline=row["claim_deadline"],
        )

    @staticmethod
    def _verify_release_start_binding(request: DeviceReleaseStart, row: dict) -> None:
        observed_hash = b64url_decode_exact(
            request.tag_advertisement_key_sha256_base64url, 32
        )
        observed_google_hash = b64url_decode_exact(
            request.tag_google_advertisement_key_sha256_base64url, 32
        )
        if (
            request.serial_number != row["serial_number"]
            or not hmac.compare_digest(
                observed_hash, bytes(row["advertisement_key_sha256"])
            )
            or not hmac.compare_digest(
                observed_google_hash,
                bytes(row["google_advertisement_key_sha256"]),
            )
            or request.finding_network != row["finding_network"]
        ):
            raise ProvisioningError(
                "TAG_KEY_MISMATCH",
                "The connected tag does not match the owned dual-network binding",
                409,
            )

    def _release_completion_token(self, row: dict, user_id: UUID) -> bytes:
        return release_completion_token(
            self.settings.claim_token_key,
            release_id=row["id"].bytes,
            user_id=user_id.bytes,
            device_id=row["device_id"].bytes,
            nonce=bytes(row["reset_nonce"]),
        )

    def _release_start_response(
        self, row: dict, user_id: UUID, authorization_proof: bytes
    ) -> DeviceReleaseStartResponse:
        control_key = self._tag_control_key(
            session_id=row["provisioning_session_id"],
            user_id=user_id,
            device_id=row["device_id"],
            advertisement_key_sha256=bytes(row["advertisement_key_sha256"]),
        )
        command = tag_reset_command(
            control_key, row["serial_number"], bytes(row["reset_nonce"])
        )
        return DeviceReleaseStartResponse(
            release_id=row["id"],
            device_id=row["device_id"],
            serial_number=row["serial_number"],
            tag_authorization_proof_base64url=b64url_encode(authorization_proof),
            reset_command_base64url=b64url_encode(command),
            release_completion_token_base64url=b64url_encode(
                self._release_completion_token(row, user_id)
            ),
            expires_at=row["expires_at"],
        )

    def _authorization_proof(self, row: dict, encoded_challenge: str) -> bytes:
        try:
            challenge = b64url_decode_exact(encoded_challenge, 32)
            if self.settings.dev_bypass_bootstrap_auth:
                logger.warning(
                    "Development bootstrap authorization bypass is enabled"
                )
                return hmac.new(
                    self.settings.claim_token_key,
                    b"pinqeva:dev-bootstrap-bypass:v1\x00"
                    + row["serial_number"].encode("ascii")
                    + challenge,
                    "sha256",
                ).digest()
            encrypted = EncryptedSecret(
                version=int(row["bootstrap_key_envelope_version"]),
                nonce=bytes(row["bootstrap_key_nonce"]),
                ciphertext=bytes(row["bootstrap_key_ciphertext"]),
            )
            associated_data = (
                f"pinqeva:bootstrap:v1:{row['device_id']}:{row['serial_number']}"
            ).encode("ascii")
            bootstrap_key = decrypt_device_bootstrap_key(
                encrypted,
                self.settings.bootstrap_key_encryption_key,
                associated_data,
            )
            return tag_authorization_proof(
                bootstrap_key, row["serial_number"], challenge
            )
        except (InvalidTag, KeyError, TypeError, ValueError) as error:
            logger.warning(
                "Provisioning authorization rejected: bootstrap proof failed (%s)",
                type(error).__name__,
            )
            raise ProvisioningError(
                "DEVICE_AUTHORIZATION_REJECTED",
                "The tag identity or factory authorization could not be verified",
                403,
            ) from None

    @staticmethod
    def _release_response(row: dict) -> DeviceReleaseResponse:
        return DeviceReleaseResponse(
            device_id=row["device_id"],
            serial_number=row["serial_number"],
            status="unprovisioned",
            released_at=row["completed_at"],
            cancelled_subscriptions=int(row["cancelled_subscriptions"]),
            provider_cancellations_queued=int(
                row["provider_cancellations_queued"]
            ),
            next_action="ready_for_new_owner",
        )
