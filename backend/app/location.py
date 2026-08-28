from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from uuid import UUID

from cryptography.exceptions import InvalidTag
from psycopg import AsyncConnection

from .apple_auth import AppleAuthManager
from .config import Settings
from .crypto import (
    EncryptedSecret,
    decrypt_google_identity_key,
    decrypt_private_key,
)
from .database import Database
from .findmy import (
    FindMyClient,
    FindMyConfigurationError,
    FindMyRequestError,
    FinderReport,
)
from .google_findhub import (
    GoogleFindHubBridgeClient,
    GoogleFindHubConfigurationError,
    GoogleFindHubRequestError,
)
from .models import (
    DeviceLocationHistoryPoint,
    DeviceLocationHistoryResponse,
    DeviceLocationReportResponse,
)


logger = logging.getLogger("pinqeva.location")
APPLE_PROVIDER_LOOKBACK_HOURS = 7 * 24
MAX_HISTORY_POINTS = 20_000


class LocationError(RuntimeError):
    def __init__(self, code: str, message: str, status_code: int) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


@dataclass(frozen=True)
class _ReportBinding:
    device_id: UUID
    serial_number: str
    session_id: UUID
    finding_network: str
    advertisement_key_sha256: bytes
    finder_secret: bytes


@dataclass(frozen=True)
class LocationService:
    settings: Settings
    auth_manager: AppleAuthManager | None = None

    def _client(self) -> FindMyClient:
        return FindMyClient(
            auth_file=self.settings.findmy_auth_file,
            dsid=self.settings.findmy_dsid,
            search_party_token=self.settings.findmy_search_party_token,
            auth_manager=self.auth_manager,
            anisette_url=self.settings.findmy_anisette_url,
            timeout_seconds=self.settings.findmy_request_timeout_seconds,
            lookback_hours=self.settings.findmy_lookback_hours,
        )

    def _google_client(self) -> GoogleFindHubBridgeClient:
        return GoogleFindHubBridgeClient(
            base_url=self.settings.google_findhub_bridge_url,
            service_token=self.settings.google_findhub_bridge_token,
            timeout_seconds=self.settings.findmy_request_timeout_seconds,
            lookback_hours=self.settings.findmy_lookback_hours,
        )

    async def request_report(
        self,
        database: Database,
        *,
        user_id: UUID,
        device_id: UUID,
    ) -> DeviceLocationReportResponse:
        binding = await self._load_binding(database, user_id=user_id, device_id=device_id)
        try:
            if binding.finding_network == "apple":
                report = await asyncio.to_thread(
                    self._client().fetch_latest,
                    advertisement_key_sha256=binding.advertisement_key_sha256,
                    private_key=binding.finder_secret,
                )
            else:
                report = await asyncio.to_thread(
                    self._google_client().fetch_latest,
                    device_id=binding.device_id,
                    serial_number=binding.serial_number,
                    identity_key=binding.finder_secret,
                    advertisement_key_sha256=binding.advertisement_key_sha256,
                )
        except (FindMyConfigurationError, GoogleFindHubConfigurationError) as exc:
            logger.warning(
                "finder_configuration_unavailable device=%s network=%s error_type=%s",
                device_id,
                binding.finding_network,
                type(exc).__name__,
            )
            raise LocationError(
                "LOCATION_UNAVAILABLE",
                "Location reports are temporarily unavailable",
                503,
            ) from None
        except (FindMyRequestError, GoogleFindHubRequestError) as exc:
            logger.warning(
                "finder_request_failed device=%s network=%s error_type=%s",
                device_id,
                binding.finding_network,
                type(exc).__name__,
            )
            raise LocationError(
                "LOCATION_UNAVAILABLE",
                "Location reports are temporarily unavailable",
                503,
            ) from None
        except Exception as exc:  # pragma: no cover - defensive production guard
            logger.error(
                "finder_decode_failed device=%s network=%s error_type=%s",
                device_id,
                binding.finding_network,
                type(exc).__name__,
            )
            raise LocationError(
                "LOCATION_UNAVAILABLE",
                "Location reports are temporarily unavailable",
                503,
            ) from None

        async with database.transaction() as connection:
            if report is None:
                return await self._current_projection(
                    connection,
                    user_id=user_id,
                    device_id=device_id,
                    report_status="no_report",
                )
            return await self._accept_report(
                connection,
                user_id=user_id,
                binding=binding,
                report=report,
            )

    async def request_report_history_24h(
        self,
        database: Database,
        *,
        user_id: UUID,
        device_id: UUID,
    ) -> DeviceLocationHistoryResponse:
        return await self.request_report_history(
            database,
            user_id=user_id,
            device_id=device_id,
            days=1,
        )

    async def request_report_history(
        self,
        database: Database,
        *,
        user_id: UUID,
        device_id: UUID,
        days: int,
    ) -> DeviceLocationHistoryResponse:
        if not 1 <= days <= 30:
            raise LocationError(
                "INVALID_HISTORY_WINDOW",
                "Location history is available for one to thirty days",
                422,
            )
        binding = await self._load_binding(database, user_id=user_id, device_id=device_id)
        current = datetime.now(UTC)
        try:
            if binding.finding_network == "apple":
                reports = await asyncio.to_thread(
                    self._client().fetch_reports,
                    advertisement_key_sha256=binding.advertisement_key_sha256,
                    private_key=binding.finder_secret,
                    now=current,
                    # Apple's private report endpoint currently accepts at
                    # most seven days. Older premium history comes from the
                    # backend's own 30-day, session-bound retention table.
                    lookback_hours=min(
                        days * 24, APPLE_PROVIDER_LOOKBACK_HOURS
                    ),
                )
            else:
                reports = await asyncio.to_thread(
                    self._google_client().fetch_reports,
                    device_id=binding.device_id,
                    serial_number=binding.serial_number,
                    identity_key=binding.finder_secret,
                    advertisement_key_sha256=binding.advertisement_key_sha256,
                    now=current,
                    lookback_hours=days * 24,
                )
        except (FindMyConfigurationError, GoogleFindHubConfigurationError) as exc:
            logger.warning(
                "finder_configuration_unavailable device=%s network=%s error_type=%s",
                device_id,
                binding.finding_network,
                type(exc).__name__,
            )
            raise LocationError(
                "LOCATION_UNAVAILABLE",
                "Location reports are temporarily unavailable",
                503,
            ) from None
        except (FindMyRequestError, GoogleFindHubRequestError) as exc:
            logger.warning(
                "finder_request_failed device=%s network=%s error_type=%s",
                device_id,
                binding.finding_network,
                type(exc).__name__,
            )
            raise LocationError(
                "LOCATION_UNAVAILABLE",
                "Location reports are temporarily unavailable",
                503,
            ) from None
        except Exception as exc:  # pragma: no cover - defensive production guard
            logger.error(
                "finder_decode_failed device=%s network=%s error_type=%s",
                device_id,
                binding.finding_network,
                type(exc).__name__,
            )
            raise LocationError(
                "LOCATION_UNAVAILABLE",
                "Location reports are temporarily unavailable",
                503,
            ) from None

        async with database.transaction() as connection:
            for report in reports:
                await self._persist_report(
                    connection,
                    user_id=user_id,
                    binding=binding,
                    report=report,
                )
            history_query = await connection.execute(
                """
                SELECT latitude, longitude, recorded_at
                  FROM public.device_location_report
                 WHERE user_id = %s
                   AND device_id = %s
                   AND provisioning_session_id = %s
                   AND recorded_at >= %s
                   AND recorded_at <= %s
                 ORDER BY recorded_at DESC, id DESC
                 LIMIT %s
                """,
                (
                    user_id,
                    binding.device_id,
                    binding.session_id,
                    current - timedelta(days=days),
                    current + timedelta(minutes=5),
                    MAX_HISTORY_POINTS,
                ),
            )
            stored_reports = await history_query.fetchall()

        return DeviceLocationHistoryResponse(
            device_id=binding.device_id,
            locations=[
                DeviceLocationHistoryPoint(
                    latitude=float(report["latitude"]),
                    longitude=float(report["longitude"]),
                    recorded_at=report["recorded_at"],
                )
                for report in stored_reports
            ],
        )

    async def _load_binding(
        self,
        database: Database,
        *,
        user_id: UUID,
        device_id: UUID,
    ) -> _ReportBinding:
        async with database.transaction() as connection:
            query = await connection.execute(
                """
                SELECT d.id AS device_id, d.serial_number,
                       d.provisioning_session_id, d.finding_network,
                       ps.id AS session_id,
                       ps.private_key_ciphertext,
                       ps.private_key_nonce,
                       ps.private_key_envelope_version,
                       ps.advertisement_key_sha256,
                       ps.google_identity_key_ciphertext,
                       ps.google_identity_key_nonce,
                       ps.google_identity_key_envelope_version,
                       ps.google_advertisement_key_sha256,
                       EXISTS (
                         SELECT 1
                           FROM public.subscription subscription
                          WHERE subscription.user_id = o.user_id
                            AND subscription.device_id = d.id
                            AND subscription.status IN ('active', 'trialing')
                            AND subscription.starts_at <= now()
                            AND subscription.current_period_end > now()
                       ) AS subscription_active
                  FROM public.device d
                  JOIN public.ownership o
                    ON o.device_id = d.id
                   AND o.user_id = %s
                   AND o.ended_at IS NULL
                  JOIN public.provisioning_session ps
                    ON ps.id = d.provisioning_session_id
                   AND ps.device_id = d.id
                   AND ps.user_id = o.user_id
                   AND ps.status = 'claimed'
                 WHERE d.id = %s
                """,
                (user_id, device_id),
            )
            row = await query.fetchone()
        if row is None:
            raise LocationError(
                "LOCATION_UNAVAILABLE",
                "This tag is not available for location reports",
                404,
            )
        if not bool(row.get("subscription_active", False)):
            raise LocationError(
                "PREMIUM_SUBSCRIPTION_REQUIRED",
                "An active subscription is required for cloud location reports",
                402,
            )

        try:
            finding_network = str(row["finding_network"])
            if finding_network == "apple":
                encrypted = EncryptedSecret(
                    version=int(row["private_key_envelope_version"]),
                    nonce=bytes(row["private_key_nonce"]),
                    ciphertext=bytes(row["private_key_ciphertext"]),
                )
                finder_secret = decrypt_private_key(
                    encrypted,
                    self.settings.key_encryption_key,
                    f"pinqeva:v1:{row['session_id']}:{user_id}:{device_id}".encode(
                        "ascii"
                    ),
                )
                advertisement_hash = bytes(row["advertisement_key_sha256"])
                if len(finder_secret) != 28:
                    raise ValueError("invalid Apple private key size")
            elif finding_network == "google":
                encrypted = EncryptedSecret(
                    version=int(row["google_identity_key_envelope_version"]),
                    nonce=bytes(row["google_identity_key_nonce"]),
                    ciphertext=bytes(row["google_identity_key_ciphertext"]),
                )
                finder_secret = decrypt_google_identity_key(
                    encrypted,
                    self.settings.key_encryption_key,
                    (
                        f"pinqeva:google-eik:v1:{row['session_id']}:"
                        f"{user_id}:{device_id}"
                    ).encode("ascii"),
                )
                advertisement_hash = bytes(
                    row["google_advertisement_key_sha256"]
                )
            else:
                raise ValueError("invalid finding network")
            if len(advertisement_hash) != 32:
                raise ValueError("invalid advertisement hash size")
        except (InvalidTag, KeyError, TypeError, ValueError) as exc:
            logger.error(
                "finder_key_unwrap_failed device=%s error_type=%s",
                device_id,
                type(exc).__name__,
            )
            raise LocationError(
                "LOCATION_UNAVAILABLE",
                "Location reports are temporarily unavailable",
                503,
            ) from None

        return _ReportBinding(
            device_id=row["device_id"],
            serial_number=row["serial_number"],
            session_id=row["session_id"],
            finding_network=finding_network,
            advertisement_key_sha256=advertisement_hash,
            finder_secret=finder_secret,
        )

    async def _accept_report(
        self,
        connection: AsyncConnection,
        *,
        user_id: UUID,
        binding: _ReportBinding,
        report: FinderReport,
    ) -> DeviceLocationReportResponse:
        # Only accept reports for the same active owner/session that supplied the
        # decrypted key. A release or transfer racing this request therefore
        # cannot write a location into a future owner's device projection.
        place = f"{report.latitude:.5f}, {report.longitude:.5f}"
        await self._persist_report(
            connection,
            user_id=user_id,
            binding=binding,
            report=report,
        )
        query = await connection.execute(
            """
            UPDATE public.device d
               SET last_latitude = %s,
                   last_longitude = %s,
                   last_location_at = %s,
                   last_place = %s,
                   updated_at = now()
             WHERE d.id = %s
               AND d.provisioning_session_id = %s
               AND EXISTS (
                   SELECT 1 FROM public.ownership o
                    WHERE o.device_id = d.id
                      AND o.user_id = %s
                      AND o.ended_at IS NULL
               )
               AND (
                   d.last_location_at IS NULL
                   OR d.last_location_at < %s
               )
             RETURNING d.id AS device_id, d.serial_number,
                       d.last_latitude, d.last_longitude,
                       d.last_location_at, d.last_place
            """,
            (
                report.latitude,
                report.longitude,
                report.timestamp,
                place,
                binding.device_id,
                binding.session_id,
                user_id,
                report.timestamp,
            ),
        )
        row = await query.fetchone()
        if row is not None:
            return self._projection_response(
                row,
                report_status="updated",
                report=report,
            )

        # A newer report may have been accepted by another app request, or the
        # tag may have been released during the network round trip. Re-read only
        # through the still-active ownership binding and return the safe latest
        # projection; never expose which race occurred.
        return await self._current_projection(
            connection,
            user_id=user_id,
            device_id=binding.device_id,
            report_status="unchanged",
        )

    async def _persist_report(
        self,
        connection: AsyncConnection,
        *,
        user_id: UUID,
        binding: _ReportBinding,
        report: FinderReport,
    ) -> None:
        """Persist only while the owner/session binding used to decrypt is active.

        The database trigger evaluates safe-zone, lost-mode, and movement alerts
        only for a newly inserted report. The uniqueness key makes retries and
        overlapping app requests idempotent.
        """

        place = f"{report.latitude:.5f}, {report.longitude:.5f}"
        await connection.execute(
            """
            INSERT INTO public.device_location_report (
                user_id, device_id, provisioning_session_id,
                latitude, longitude, confidence, status_code,
                place, recorded_at
            )
            SELECT %s, device.id, %s, %s, %s, %s, %s, %s, %s
              FROM public.device device
             WHERE device.id = %s
               AND device.provisioning_session_id = %s
               AND EXISTS (
                 SELECT 1 FROM public.ownership ownership
                  WHERE ownership.device_id = device.id
                    AND ownership.user_id = %s
                    AND ownership.ended_at IS NULL
               )
               AND EXISTS (
                 SELECT 1 FROM public.subscription subscription
                  WHERE subscription.device_id = device.id
                    AND subscription.user_id = %s
                    AND subscription.status IN ('active', 'trialing')
                    AND subscription.starts_at <= now()
                    AND subscription.current_period_end > now()
               )
            ON CONFLICT (
                device_id, provisioning_session_id, recorded_at
            ) DO NOTHING
            """,
            (
                user_id,
                binding.session_id,
                report.latitude,
                report.longitude,
                report.confidence,
                report.status,
                place,
                report.timestamp,
                binding.device_id,
                binding.session_id,
                user_id,
                user_id,
            ),
        )

    async def _current_projection(
        self,
        connection: AsyncConnection,
        *,
        user_id: UUID,
        device_id: UUID,
        report_status: str,
    ) -> DeviceLocationReportResponse:
        query = await connection.execute(
            """
            SELECT d.id AS device_id, d.serial_number,
                   d.last_latitude, d.last_longitude,
                   d.last_location_at, d.last_place
              FROM public.device d
              JOIN public.ownership o
                ON o.device_id = d.id
               AND o.user_id = %s
               AND o.ended_at IS NULL
             WHERE d.id = %s
            """,
            (user_id, device_id),
        )
        row = await query.fetchone()
        if row is None:
            raise LocationError(
                "LOCATION_UNAVAILABLE",
                "This tag is not available for location reports",
                404,
            )
        return self._projection_response(row, report_status=report_status)

    @staticmethod
    def _projection_response(
        row: dict,
        *,
        report_status: str,
        report: FinderReport | None = None,
    ) -> DeviceLocationReportResponse:
        return DeviceLocationReportResponse(
            device_id=row["device_id"],
            serial_number=row["serial_number"],
            report_status=report_status,
            latitude=row.get("last_latitude"),
            longitude=row.get("last_longitude"),
            last_location_at=row.get("last_location_at"),
            last_place=row.get("last_place"),
            confidence=report.confidence if report else None,
            status_code=report.status if report else None,
        )
