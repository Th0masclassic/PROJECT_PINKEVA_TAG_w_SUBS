from __future__ import annotations

import asyncio
import hashlib
import hmac
import logging
import struct
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
    derive_google_advertisement_key,
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
class _ProviderBinding:
    finding_network: str
    advertisement_key_sha256: bytes
    finder_secret: bytes


@dataclass(frozen=True)
class _ReportBinding:
    device_id: UUID
    serial_number: str
    session_id: UUID
    providers: tuple[_ProviderBinding, ...]


@dataclass(frozen=True)
class _SourcedReport:
    provider: _ProviderBinding
    report: FinderReport


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

    def _apple_configured(self) -> bool:
        return self.auth_manager is not None or bool(
            self.settings.findmy_auth_file
            or (
                self.settings.findmy_dsid
                and self.settings.findmy_search_party_token
            )
        )

    def _google_configured(self) -> bool:
        return bool(
            self.settings.google_findhub_bridge_url
            and self.settings.google_findhub_bridge_token
        )

    async def _fetch_provider_reports(
        self,
        binding: _ReportBinding,
        *,
        current: datetime,
        apple_lookback_hours: int,
        google_lookback_hours: int,
    ) -> list[_SourcedReport]:
        requests_by_provider = []
        for provider in binding.providers:
            if provider.finding_network == "apple" and self._apple_configured():
                request = asyncio.to_thread(
                    self._client().fetch_reports,
                    advertisement_key_sha256=provider.advertisement_key_sha256,
                    private_key=provider.finder_secret,
                    now=current,
                    lookback_hours=apple_lookback_hours,
                )
            elif provider.finding_network == "google" and self._google_configured():
                request = asyncio.to_thread(
                    self._google_client().fetch_reports,
                    device_id=binding.device_id,
                    serial_number=binding.serial_number,
                    identity_key=provider.finder_secret,
                    advertisement_key_sha256=provider.advertisement_key_sha256,
                    now=current,
                    lookback_hours=google_lookback_hours,
                )
            else:
                continue
            requests_by_provider.append((provider, request))

        if not requests_by_provider:
            raise LocationError(
                "LOCATION_UNAVAILABLE",
                "Location reports are temporarily unavailable",
                503,
            )

        results = await asyncio.gather(
            *(request for _provider, request in requests_by_provider),
            return_exceptions=True,
        )
        successful_providers = 0
        reports: list[_SourcedReport] = []
        for (provider, _request), result in zip(
            requests_by_provider, results, strict=True
        ):
            if isinstance(result, asyncio.CancelledError):
                raise result
            if isinstance(result, BaseException):
                if isinstance(
                    result,
                    (FindMyConfigurationError, GoogleFindHubConfigurationError),
                ):
                    event = "finder_configuration_unavailable"
                    log = logger.warning
                elif isinstance(
                    result, (FindMyRequestError, GoogleFindHubRequestError)
                ):
                    event = "finder_request_failed"
                    log = logger.warning
                else:
                    event = "finder_decode_failed"
                    log = logger.error
                log(
                    "%s device=%s network=%s error_type=%s",
                    event,
                    binding.device_id,
                    provider.finding_network,
                    type(result).__name__,
                )
                continue
            successful_providers += 1
            reports.extend(
                _SourcedReport(provider=provider, report=report)
                for report in result
            )

        # One ecosystem being temporarily unavailable must not hide a newer
        # report successfully returned by the other. Fail only when neither
        # configured provider completed an authoritative request.
        if successful_providers == 0:
            raise LocationError(
                "LOCATION_UNAVAILABLE",
                "Location reports are temporarily unavailable",
                503,
            )
        return reports

    async def request_report(
        self,
        database: Database,
        *,
        user_id: UUID,
        device_id: UUID,
    ) -> DeviceLocationReportResponse:
        binding = await self._load_binding(database, user_id=user_id, device_id=device_id)
        current = datetime.now(UTC)
        reports = await self._fetch_provider_reports(
            binding,
            current=current,
            apple_lookback_hours=min(
                self.settings.findmy_lookback_hours,
                APPLE_PROVIDER_LOOKBACK_HOURS,
            ),
            google_lookback_hours=self.settings.findmy_lookback_hours,
        )

        async with database.transaction() as connection:
            sourced_report = await self._ingest_reports(
                connection,
                user_id=user_id,
                binding=binding,
                reports=reports,
            )
            if sourced_report is None:
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
                sourced_report=sourced_report,
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
        reports = await self._fetch_provider_reports(
            binding,
            current=current,
            # Apple's reverse-engineered endpoint currently exposes at most
            # seven days. Older premium history is served from our own table.
            apple_lookback_hours=min(days * 24, APPLE_PROVIDER_LOOKBACK_HOURS),
            google_lookback_hours=days * 24,
        )

        async with database.transaction() as connection:
            latest = await self._ingest_reports(
                connection,
                user_id=user_id,
                binding=binding,
                reports=reports,
            )
            if latest is not None:
                await self._accept_report(
                    connection,
                    user_id=user_id,
                    binding=binding,
                    sourced_report=latest,
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
                 ORDER BY recorded_at DESC, finding_network DESC,
                          source_fingerprint DESC, id DESC
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
            if str(row["finding_network"]) not in {"apple", "google"}:
                raise ValueError("invalid preferred finding network")

            apple_encrypted = EncryptedSecret(
                version=int(row["private_key_envelope_version"]),
                nonce=bytes(row["private_key_nonce"]),
                ciphertext=bytes(row["private_key_ciphertext"]),
            )
            apple_secret = decrypt_private_key(
                apple_encrypted,
                self.settings.key_encryption_key,
                f"pinqeva:v1:{row['session_id']}:{user_id}:{device_id}".encode(
                    "ascii"
                ),
            )
            apple_hash = bytes(row["advertisement_key_sha256"])
            if len(apple_secret) != 28 or len(apple_hash) != 32:
                raise ValueError("invalid Apple finder key material")

            # Google material was added after the original Apple-only
            # allocations were provisioned. A legacy Apple allocation is valid
            # without it, so only require the Google bundle when any of its
            # fields are present (or when Google is the selected network).
            google_fields = (
                row["google_identity_key_envelope_version"],
                row["google_identity_key_nonce"],
                row["google_identity_key_ciphertext"],
                row["google_advertisement_key_sha256"],
            )
            if all(value is None for value in google_fields):
                if str(row["finding_network"]) == "google":
                    raise ValueError("Google finder key material is missing")
                google_hash: bytes | None = None
                google_secret: bytes | None = None
            else:
                if any(value is None for value in google_fields):
                    raise ValueError("incomplete Google finder key material")
                google_encrypted = EncryptedSecret(
                    version=int(row["google_identity_key_envelope_version"]),
                    nonce=bytes(row["google_identity_key_nonce"]),
                    ciphertext=bytes(row["google_identity_key_ciphertext"]),
                )
                google_secret = decrypt_google_identity_key(
                    google_encrypted,
                    self.settings.key_encryption_key,
                    (
                        f"pinqeva:google-eik:v1:{row['session_id']}:"
                        f"{user_id}:{device_id}"
                    ).encode("ascii"),
                )
                google_hash = bytes(row["google_advertisement_key_sha256"])
                if len(google_hash) != 32 or not hmac.compare_digest(
                    hashlib.sha256(
                        derive_google_advertisement_key(google_secret)
                    ).digest(),
                    google_hash,
                ):
                    raise ValueError("Google identity does not match tag fingerprint")
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

        providers = [
            _ProviderBinding(
                finding_network="apple",
                advertisement_key_sha256=apple_hash,
                finder_secret=apple_secret,
            )
        ]
        if google_hash is not None and google_secret is not None:
            providers.append(
                _ProviderBinding(
                    finding_network="google",
                    advertisement_key_sha256=google_hash,
                    finder_secret=google_secret,
                )
            )

        return _ReportBinding(
            device_id=row["device_id"],
            serial_number=row["serial_number"],
            session_id=row["session_id"],
            providers=tuple(providers),
        )

    async def _accept_report(
        self,
        connection: AsyncConnection,
        *,
        user_id: UUID,
        binding: _ReportBinding,
        sourced_report: _SourcedReport,
    ) -> DeviceLocationReportResponse:
        # Only accept reports for the same active owner/session that supplied the
        # decrypted key. A release or transfer racing this request therefore
        # cannot write a location into a future owner's device projection.
        provider = sourced_report.provider
        report = sourced_report.report
        place = f"{report.latitude:.5f}, {report.longitude:.5f}"
        source_fingerprint = self._source_fingerprint(provider, report)
        query = await connection.execute(
            """
            UPDATE public.device d
               SET last_latitude = %s,
                   last_longitude = %s,
                   last_location_at = %s,
                   last_place = %s,
                   last_location_finding_network = %s,
                   last_location_source_fingerprint = %s,
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
                   OR (
                     d.last_location_at = %s
                     AND (
                       COALESCE(
                         d.last_location_source_fingerprint,
                         decode(repeat('00', 32), 'hex')
                       ) < %s
                       OR (
                         d.last_location_source_fingerprint = %s
                         AND COALESCE(d.last_location_finding_network, '') < %s
                       )
                     )
                   )
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
                provider.finding_network,
                source_fingerprint,
                binding.device_id,
                binding.session_id,
                user_id,
                report.timestamp,
                report.timestamp,
                source_fingerprint,
                source_fingerprint,
                provider.finding_network,
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
        sourced_report: _SourcedReport,
    ) -> None:
        """Persist only while the owner/session binding used to decrypt is active.

        The database trigger evaluates safe-zone, separation, and movement alerts
        only for a newly inserted report. The uniqueness key makes retries and
        overlapping app requests idempotent.
        """

        provider = sourced_report.provider
        report = sourced_report.report
        place = f"{report.latitude:.5f}, {report.longitude:.5f}"
        source_fingerprint = self._source_fingerprint(provider, report)
        await connection.execute(
            """
            INSERT INTO public.device_location_report (
                user_id, device_id, provisioning_session_id,
                finding_network, source_fingerprint,
                latitude, longitude, confidence, status_code,
                place, recorded_at
            )
            SELECT %s, device.id, %s, %s, %s, %s, %s, %s, %s, %s, %s
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
                  WHERE subscription.user_id = %s
                    AND subscription.status IN ('active', 'trialing')
                    AND subscription.starts_at <= now()
                    AND subscription.current_period_end > now()
               )
            ON CONFLICT (
                device_id, provisioning_session_id,
                finding_network, source_fingerprint
            ) DO NOTHING
            """,
            (
                user_id,
                binding.session_id,
                provider.finding_network,
                source_fingerprint,
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

    async def _ingest_reports(
        self,
        connection: AsyncConnection,
        *,
        user_id: UUID,
        binding: _ReportBinding,
        reports: list[_SourcedReport],
    ) -> _SourcedReport | None:
        """Store reports chronologically and return one deterministic latest."""

        ordered = sorted(
            reports,
            key=lambda sourced_report: (
                sourced_report.report.timestamp,
                self._source_fingerprint(
                    sourced_report.provider, sourced_report.report
                ),
                sourced_report.provider.finding_network,
            ),
        )
        for sourced_report in ordered:
            await self._persist_report(
                connection,
                user_id=user_id,
                binding=binding,
                sourced_report=sourced_report,
            )
        return ordered[-1] if ordered else None

    @staticmethod
    def _source_fingerprint(
        provider: _ProviderBinding, report: FinderReport
    ) -> bytes:
        if report.source_fingerprint is not None:
            fingerprint = bytes(report.source_fingerprint)
            if len(fingerprint) != 32:
                raise ValueError("provider report fingerprint must be 32 bytes")
            return fingerprint
        timestamp = report.timestamp.astimezone(UTC)
        fallback = b"\x00".join(
            (
                b"pinqeva-location-v1",
                provider.finding_network.encode("ascii"),
                timestamp.isoformat(timespec="microseconds").encode("ascii"),
                struct.pack(
                    ">ddBB",
                    report.latitude,
                    report.longitude,
                    report.confidence,
                    report.status,
                ),
            )
        )
        return hashlib.sha256(fallback).digest()

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
