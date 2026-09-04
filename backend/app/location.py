from __future__ import annotations

import asyncio
import hashlib
import hmac
import logging
import struct
import time
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from uuid import UUID
from typing import Any, Literal, Protocol

from cryptography.exceptions import InvalidTag
from psycopg import AsyncConnection
from psycopg.rows import DictRow

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


class LocationProvider(Protocol):
    """The same report contract for direct test clients and isolated workers."""

    def fetch_reports(self, *args: Any, **kwargs: Any) -> list[FinderReport]: ...


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

    def _client(self) -> LocationProvider:
        return FindMyClient(
            auth_file=self.settings.findmy_auth_file,
            dsid=self.settings.findmy_dsid,
            search_party_token=self.settings.findmy_search_party_token,
            auth_manager=self.auth_manager,
            anisette_url=self.settings.findmy_anisette_url,
            timeout_seconds=self.settings.findmy_request_timeout_seconds,
            lookback_hours=self.settings.findmy_lookback_hours,
            report_api=self.settings.findmy_report_api,
        )

    def _google_client(self) -> LocationProvider:
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
        """Read the owner-scoped cache; only entitled stale reads request work."""
        from .location_queue import LocationQueue

        queue = LocationQueue(database, self.settings)
        row = await self._read_cached_location(database, user_id=user_id, device_id=device_id)
        premium = bool(row["subscription_active"])
        threshold = (
            self.settings.premium_location_freshness_seconds
            if premium else self.settings.location_sync_interval_seconds
        )
        result = self._cache_response(row, threshold=threshold)
        if not premium or not self._fetch_is_stale(row, threshold):
            logger.info("location_cache_hit device=%s premium=%s", device_id, premium)
            return result

        session_id = row["session_id"]
        admitted = await queue.request_refresh(
            user_id=user_id, device_id=device_id, session_id=session_id
        )
        before = row.get("last_location_fetched_at")
        previous_location = (row.get("last_location_at"), row.get("last_latitude"), row.get("last_longitude"))
        deadline = time.monotonic() + self.settings.location_refresh_wait_seconds
        snapshot = None
        while True:
            snapshot = await queue.snapshot(
                user_id=user_id, device_id=device_id, session_id=session_id
            )
            # Re-authorize every read, including a transfer or ban while waiting.
            row = await self._read_cached_location(
                database, user_id=user_id, device_id=device_id
            )
            if row["session_id"] != session_id:
                raise LocationError("LOCATION_UNAVAILABLE", "This tag is unavailable", 404)
            fetched = row.get("last_location_fetched_at")
            if fetched is not None and (before is None or fetched > before):
                return self._cache_response(row, threshold=threshold).model_copy(
                    update={
                        "source": "refresh",
                        "report_status": "updated" if previous_location != (
                            row.get("last_location_at"), row.get("last_latitude"), row.get("last_longitude")
                        ) else ("unchanged" if row.get("last_location_at") else "no_report"),
                    }
                )
            if (
                not admitted or not snapshot
                or not snapshot.get("refreshing", False)
                or time.monotonic() >= deadline
            ):
                break
            await asyncio.sleep(min(0.25, max(0, deadline - time.monotonic())))
        return self._cache_response(row, threshold=threshold).model_copy(update={
            "refreshing": bool(snapshot and snapshot.get("refreshing")),
            "upstream_refresh_failed": bool(snapshot and snapshot.get("last_error_code")),
        })

    @staticmethod
    def _fetch_is_stale(row: dict, threshold: int) -> bool:
        fetched = row.get("last_location_fetched_at")
        return fetched is None or (datetime.now(UTC) - fetched).total_seconds() >= threshold

    def _cache_response(self, row: dict, *, threshold: int) -> DeviceLocationReportResponse:
        result = self._projection_response(
            row, report_status="unchanged" if row.get("last_location_at") else "no_report"
        )
        current = datetime.now(UTC)
        recorded = row.get("last_location_at")
        fetched = row.get("last_location_fetched_at")
        return result.model_copy(update={
            "server_fetched_at": fetched,
            "age_seconds": max(0, int((current - recorded).total_seconds())) if recorded else None,
            "fetch_age_seconds": max(0, int((current - fetched).total_seconds())) if fetched else None,
            "stale": self._fetch_is_stale(row, threshold) or recorded is None
                or (current - recorded).total_seconds() >= threshold,
        })

    async def _read_cached_location(
        self, database: Database, *, user_id: UUID, device_id: UUID
    ) -> dict:
        async with database.transaction() as connection:
            query = await connection.execute(
                """
                SELECT d.id AS device_id, d.serial_number,
                       d.last_latitude, d.last_longitude, d.last_location_at,
                       d.last_place, d.last_location_fetched_at,
                       d.last_location_confidence, d.last_location_status_code,
                       ps.id AS session_id,
                       public.pinqeva_active_subscription_id(o.user_id) IS NOT NULL
                         AS subscription_active
                  FROM public.device d
                  JOIN public.ownership o ON o.device_id = d.id
                   AND o.user_id = %s AND o.ended_at IS NULL
                  JOIN public.profiles p ON p.id = o.user_id
                   AND p.account_status <> 'banned'
                  JOIN public.provisioning_session ps ON ps.id = d.provisioning_session_id
                   AND ps.device_id = d.id AND ps.user_id = o.user_id AND ps.status = 'claimed'
                 WHERE d.id = %s
                """, (user_id, device_id),
            )
            row = await query.fetchone()
            if row is None:
                raise LocationError("LOCATION_UNAVAILABLE", "This tag is unavailable", 404)
            # Throttle access writes. These are hints for scheduling, never auth state.
            await connection.execute(
                """UPDATE public.device_location_sync_state
                      SET last_accessed_at = now()
                    WHERE device_id = %s AND user_id = %s AND provisioning_session_id = %s
                      AND (last_accessed_at IS NULL OR last_accessed_at < now() - interval '5 minutes')""",
                (device_id, user_id, row["session_id"]),
            )
        return row

    async def refresh_report(
        self,
        database: Database,
        *,
        user_id: UUID,
        device_id: UUID,
        session_id: UUID,
        lease_owner: UUID,
    ) -> DeviceLocationReportResponse:
        """Worker-only upstream operation. All writes require the current lease."""
        binding = await self._load_binding(
            database, user_id=user_id, device_id=device_id, require_premium=False
        )
        if binding.session_id != session_id:
            raise LocationError("LOCATION_UNAVAILABLE", "This tag is unavailable", 404)
        async with database.transaction() as connection:
            lease = await connection.execute(
                """SELECT device_id FROM public.device_location_sync_state
                    WHERE device_id = %s AND user_id = %s AND provisioning_session_id = %s
                      AND lease_owner = %s
                      AND lease_expires_at > clock_timestamp() + make_interval(secs => %s)""",
                (device_id, user_id, session_id, lease_owner, self.settings.location_job_timeout_seconds),
            )
            if await lease.fetchone() is None:
                raise LocationError("LOCATION_LEASE_LOST", "Refresh no longer active", 409)
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
            # Match ownership-release lock order: device before sync state.
            await connection.execute("SELECT id FROM public.device WHERE id = %s FOR UPDATE", (device_id,))
            fence = await connection.execute(
                """SELECT device_id FROM public.device_location_sync_state
                    WHERE device_id = %s AND user_id = %s AND provisioning_session_id = %s
                      AND lease_owner = %s AND lease_expires_at > clock_timestamp()
                      AND EXISTS (
                        SELECT 1 FROM public.device d
                          JOIN public.ownership o ON o.device_id = d.id AND o.ended_at IS NULL
                          JOIN public.profiles p ON p.id = o.user_id AND p.account_status <> 'banned'
                         WHERE d.id = device_location_sync_state.device_id
                           AND d.provisioning_session_id = device_location_sync_state.provisioning_session_id
                           AND o.user_id = device_location_sync_state.user_id
                      )
                    FOR UPDATE""", (device_id, user_id, session_id, lease_owner),
            )
            if await fence.fetchone() is None:
                raise LocationError("LOCATION_LEASE_LOST", "Refresh no longer active", 409)
            sourced_report = await self._ingest_reports(
                connection,
                user_id=user_id,
                binding=binding,
                reports=reports,
            )
            # A successful empty response is still a successful fetch. It must
            # not turn an old device report into a new device timestamp.
            await connection.execute(
                """UPDATE public.device SET last_location_fetched_at = now()
                    WHERE id = %s AND provisioning_session_id = %s""", (device_id, session_id),
            )
            await connection.execute(
                """UPDATE public.device_location_sync_state SET last_success_at = now(),
                           last_error_code = NULL
                    WHERE device_id = %s AND lease_owner = %s""", (device_id, lease_owner),
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
        row = await self._read_cached_location(database, user_id=user_id, device_id=device_id)
        if not row["subscription_active"]:
            raise LocationError("PREMIUM_SUBSCRIPTION_REQUIRED", "An active subscription is required", 402)
        # History uses the same coalesced refresh path and never bypasses its
        # freshness/rate protections. Historical retention stays premium.
        await self.request_report(database, user_id=user_id, device_id=device_id)
        current = datetime.now(UTC)
        async with database.transaction() as connection:
            history_query = await connection.execute(
                """
                SELECT latitude, longitude, recorded_at
                  FROM public.device_location_report
                 WHERE user_id = %s
                   AND device_id = %s
                   AND provisioning_session_id = %s
                   AND recorded_at >= %s
                   AND recorded_at <= %s
                   AND EXISTS (
                     SELECT 1 FROM public.device d JOIN public.ownership o ON o.device_id = d.id
                       JOIN public.profiles p ON p.id = o.user_id AND p.account_status <> 'banned'
                      WHERE d.id = device_location_report.device_id
                        AND d.provisioning_session_id = device_location_report.provisioning_session_id
                        AND o.user_id = device_location_report.user_id AND o.ended_at IS NULL
                        AND public.pinqeva_active_subscription_id(o.user_id) IS NOT NULL
                   )
                 ORDER BY recorded_at DESC, finding_network DESC,
                          source_fingerprint DESC, id DESC
                 LIMIT %s
                """,
                (
                    user_id,
                    device_id,
                    row["session_id"],
                    current - timedelta(days=days),
                    current + timedelta(minutes=5),
                    MAX_HISTORY_POINTS,
                ),
            )
            stored_reports = await history_query.fetchall()

        return DeviceLocationHistoryResponse(
            device_id=device_id,
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
        require_premium: bool = True,
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
                  JOIN public.profiles p ON p.id = o.user_id AND p.account_status <> 'banned'
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
        if require_premium and not bool(row.get("subscription_active", False)):
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
        connection: AsyncConnection[DictRow],
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
                   last_location_confidence = %s,
                   last_location_status_code = %s,
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
                report.confidence,
                report.status,
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
        connection: AsyncConnection[DictRow],
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
        connection: AsyncConnection[DictRow],
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
        connection: AsyncConnection[DictRow],
        *,
        user_id: UUID,
        device_id: UUID,
        report_status: Literal["updated", "unchanged", "no_report"],
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
        report_status: Literal["updated", "unchanged", "no_report"],
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
            confidence=report.confidence if report else row.get("last_location_confidence"),
            status_code=report.status if report else row.get("last_location_status_code"),
        )
