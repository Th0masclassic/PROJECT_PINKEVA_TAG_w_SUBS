from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from datetime import datetime
from uuid import UUID, uuid4

from .database import Database
from .location import LocationError, LocationService


logger = logging.getLogger("pinqeva.location_sync")
SUPPORTED_NETWORKS = frozenset({"apple", "google"})


@dataclass(frozen=True)
class LocationSyncJob:
    device_id: UUID
    user_id: UUID
    provisioning_session_id: UUID
    consecutive_failures: int


class LocationSyncWorker:
    """Continuously retain provider reports for eligible premium accounts.

    Database leases make this safe to run in more than one API replica. Every
    provider call is re-authorized by ``LocationService`` after the lease is
    acquired, so an ownership transfer or subscription expiry racing a poll
    cannot retain or expose a stale owner's report.
    """

    def __init__(
        self,
        database: Database,
        location: LocationService,
        *,
        enabled_networks: frozenset[str],
        interval_seconds: int = 900,
        batch_size: int = 8,
        idle_seconds: float = 5.0,
        lease_seconds: int = 120,
    ) -> None:
        invalid = enabled_networks - SUPPORTED_NETWORKS
        if invalid:
            raise ValueError("location sync contains an unsupported finding network")
        if interval_seconds < 60 or not 1 <= batch_size <= 64:
            raise ValueError("location sync timing is invalid")
        self.database = database
        self.location = location
        self.enabled_networks = enabled_networks
        self.interval_seconds = interval_seconds
        self.batch_size = batch_size
        self.idle_seconds = idle_seconds
        self.lease_seconds = max(lease_seconds, 60)
        self.worker_id = uuid4()

    async def reconcile_once(self) -> None:
        """Mirror only currently owned, claimed and account-entitled tags."""

        if not self.enabled_networks:
            return
        async with self.database.transaction() as connection:
            await connection.execute(
                """
                DELETE FROM public.device_location_sync_state sync
                 WHERE NOT EXISTS (
                   SELECT 1
                     FROM public.device device
                     JOIN public.ownership ownership
                       ON ownership.device_id = device.id
                      AND ownership.user_id = sync.user_id
                      AND ownership.ended_at IS NULL
                     JOIN public.provisioning_session session
                       ON session.id = device.provisioning_session_id
                      AND session.id = sync.provisioning_session_id
                      AND session.device_id = device.id
                      AND session.user_id = ownership.user_id
                      AND session.status = 'claimed'
                    WHERE device.id = sync.device_id
                      AND public.pinqeva_active_subscription_id(
                            ownership.user_id
                          ) IS NOT NULL
                 )
                """,
            )
            await connection.execute(
                """
                INSERT INTO public.device_location_sync_state (
                  device_id, user_id, provisioning_session_id, next_attempt_at
                )
                SELECT device.id, ownership.user_id,
                       session.id, now()
                  FROM public.device device
                  JOIN public.ownership ownership
                    ON ownership.device_id = device.id
                   AND ownership.ended_at IS NULL
                  JOIN public.provisioning_session session
                    ON session.id = device.provisioning_session_id
                   AND session.device_id = device.id
                   AND session.user_id = ownership.user_id
                   AND session.status = 'claimed'
                 WHERE public.pinqeva_active_subscription_id(
                         ownership.user_id
                       ) IS NOT NULL
                ON CONFLICT (device_id) DO UPDATE
                   SET user_id = EXCLUDED.user_id,
                       provisioning_session_id = EXCLUDED.provisioning_session_id,
                       next_attempt_at = CASE
                         WHEN device_location_sync_state.user_id
                                IS DISTINCT FROM EXCLUDED.user_id
                           OR device_location_sync_state.provisioning_session_id
                                IS DISTINCT FROM EXCLUDED.provisioning_session_id
                         THEN now()
                         ELSE device_location_sync_state.next_attempt_at
                       END,
                       consecutive_failures = CASE
                         WHEN device_location_sync_state.user_id
                                IS DISTINCT FROM EXCLUDED.user_id
                           OR device_location_sync_state.provisioning_session_id
                                IS DISTINCT FROM EXCLUDED.provisioning_session_id
                         THEN 0
                         ELSE device_location_sync_state.consecutive_failures
                       END,
                       lease_owner = CASE
                         WHEN device_location_sync_state.user_id
                                IS DISTINCT FROM EXCLUDED.user_id
                           OR device_location_sync_state.provisioning_session_id
                                IS DISTINCT FROM EXCLUDED.provisioning_session_id
                         THEN NULL
                         ELSE device_location_sync_state.lease_owner
                       END,
                       lease_expires_at = CASE
                         WHEN device_location_sync_state.user_id
                                IS DISTINCT FROM EXCLUDED.user_id
                           OR device_location_sync_state.provisioning_session_id
                                IS DISTINCT FROM EXCLUDED.provisioning_session_id
                         THEN NULL
                         ELSE device_location_sync_state.lease_expires_at
                       END,
                       updated_at = now()
                """,
            )

    async def claim_due(self) -> list[LocationSyncJob]:
        if not self.enabled_networks:
            return []
        async with self.database.transaction() as connection:
            query = await connection.execute(
                """
                WITH due AS (
                  SELECT sync.device_id
                    FROM public.device_location_sync_state sync
                   WHERE sync.next_attempt_at <= now()
                     AND (
                       sync.lease_owner IS NULL
                       OR sync.lease_expires_at <= now()
                     )
                   ORDER BY sync.next_attempt_at, sync.device_id
                   FOR UPDATE SKIP LOCKED
                   LIMIT %s
                )
                UPDATE public.device_location_sync_state sync
                   SET lease_owner = %s,
                       lease_expires_at = now() + make_interval(secs => %s),
                       last_attempt_at = now(),
                       updated_at = now()
                  FROM due
                 WHERE sync.device_id = due.device_id
                RETURNING sync.device_id, sync.user_id,
                          sync.provisioning_session_id, sync.consecutive_failures
                """,
                (
                    self.batch_size,
                    self.worker_id,
                    self.lease_seconds,
                ),
            )
            rows = await query.fetchall()
        return [
            LocationSyncJob(
                device_id=row["device_id"],
                user_id=row["user_id"],
                provisioning_session_id=row["provisioning_session_id"],
                consecutive_failures=int(row["consecutive_failures"]),
            )
            for row in rows
        ]

    async def _finish_success(
        self, job: LocationSyncJob, provider_report_at: datetime | None
    ) -> None:
        async with self.database.transaction() as connection:
            await connection.execute(
                """
                UPDATE public.device_location_sync_state
                   SET next_attempt_at = now() + make_interval(secs => %s),
                       last_success_at = now(),
                       last_provider_report_at = CASE
                         WHEN %s::timestamptz IS NULL
                           THEN last_provider_report_at
                         ELSE GREATEST(
                           COALESCE(last_provider_report_at, %s::timestamptz),
                           %s::timestamptz
                         )
                       END,
                       consecutive_failures = 0,
                       last_error_code = NULL,
                       lease_owner = NULL,
                       lease_expires_at = NULL,
                       updated_at = now()
                 WHERE device_id = %s
                   AND user_id = %s
                   AND provisioning_session_id = %s
                   AND lease_owner = %s
                """,
                (
                    self.interval_seconds,
                    provider_report_at,
                    provider_report_at,
                    provider_report_at,
                    job.device_id,
                    job.user_id,
                    job.provisioning_session_id,
                    self.worker_id,
                ),
            )

    async def _finish_failure(self, job: LocationSyncJob, code: str) -> None:
        failures = min(job.consecutive_failures + 1, 1_000_000)
        backoff_seconds = min(
            self.interval_seconds,
            30 * (2 ** min(job.consecutive_failures, 6)),
        )
        async with self.database.transaction() as connection:
            await connection.execute(
                """
                UPDATE public.device_location_sync_state
                   SET next_attempt_at = now() + make_interval(secs => %s),
                       consecutive_failures = %s,
                       last_error_code = %s,
                       lease_owner = NULL,
                       lease_expires_at = NULL,
                       updated_at = now()
                 WHERE device_id = %s
                   AND user_id = %s
                   AND provisioning_session_id = %s
                   AND lease_owner = %s
                """,
                (
                    backoff_seconds,
                    failures,
                    code,
                    job.device_id,
                    job.user_id,
                    job.provisioning_session_id,
                    self.worker_id,
                ),
            )

    async def _drop_ineligible(self, job: LocationSyncJob) -> None:
        async with self.database.transaction() as connection:
            await connection.execute(
                """
                DELETE FROM public.device_location_sync_state
                 WHERE device_id = %s
                   AND user_id = %s
                   AND provisioning_session_id = %s
                   AND lease_owner = %s
                """,
                (
                    job.device_id,
                    job.user_id,
                    job.provisioning_session_id,
                    self.worker_id,
                ),
            )

    async def process(self, job: LocationSyncJob) -> None:
        try:
            response = await self.location.request_report(
                self.database,
                user_id=job.user_id,
                device_id=job.device_id,
            )
        except LocationError as exc:
            if exc.code in {
                "PREMIUM_SUBSCRIPTION_REQUIRED",
                "LOCATION_UNAVAILABLE",
            } and exc.status_code in {402, 404}:
                await self._drop_ineligible(job)
                return
            await self._finish_failure(job, exc.code)
            return
        except Exception as exc:  # pragma: no cover - production resilience
            logger.error(
                "location_sync_job_failed device=%s error_type=%s",
                job.device_id,
                type(exc).__name__,
            )
            await self._finish_failure(job, "LOCATION_SYNC_FAILED")
            return
        await self._finish_success(job, response.last_location_at)

    async def sync_once(self) -> int:
        await self.reconcile_once()
        jobs = await self.claim_due()
        if jobs:
            await asyncio.gather(*(self.process(job) for job in jobs))
        return len(jobs)

    async def run(self, stop: asyncio.Event) -> None:
        while not stop.is_set():
            try:
                await self.reconcile_once()
                while not stop.is_set():
                    jobs = await self.claim_due()
                    if not jobs:
                        break
                    await asyncio.gather(*(self.process(job) for job in jobs))
            except Exception as exc:  # pragma: no cover - production resilience
                logger.error(
                    "location_sync_cycle_failed error_type=%s", type(exc).__name__
                )
            try:
                await asyncio.wait_for(stop.wait(), timeout=self.idle_seconds)
            except TimeoutError:
                continue
