from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from types import SimpleNamespace
from typing import cast
from uuid import UUID, uuid4

from .config import Settings
from .database import Database
from .location import LocationError, LocationService
from .location_queue import consume_rate_limit


logger = logging.getLogger("pinqeva.location_sync")
SUPPORTED_NETWORKS = frozenset({"apple", "google"})


@dataclass(frozen=True)
class LocationSyncJob:
    device_id: UUID
    user_id: UUID
    provisioning_session_id: UUID
    consecutive_failures: int
    lease_owner: UUID = field(default_factory=uuid4)
    attempt_count: int = 1
    reason: str = "scheduled"
    requested_at: datetime | None = None
    already_completed: bool = False


class LocationScheduler:
    """A durable cadence gate makes any number of schedulers safe to run."""

    def __init__(
        self, database: Database, *, settings: Settings,
        enabled_networks: frozenset[str],
    ) -> None:
        if enabled_networks - SUPPORTED_NETWORKS:
            raise ValueError("location sync contains an unsupported finding network")
        self.database = database
        self.settings = settings
        self.enabled_networks = enabled_networks

    async def reconcile_once(self) -> None:
        if not self.enabled_networks:
            return
        async with self.database.transaction() as connection:
            cursor = await connection.execute(
                """
                INSERT INTO public.backend_schedule (name, next_run_at)
                VALUES ('location-reconcile', now() + make_interval(secs => %s))
                ON CONFLICT (name) DO UPDATE SET next_run_at = EXCLUDED.next_run_at
                  WHERE backend_schedule.next_run_at <= now()
                RETURNING name
                """,
                (self.settings.location_scheduler_interval_seconds,),
            )
            if await cursor.fetchone() is None:
                return
            await connection.execute(
                """
                DELETE FROM public.device_location_sync_state sync
                 WHERE NOT EXISTS (
                   SELECT 1 FROM public.device device
                     JOIN public.ownership ownership ON ownership.device_id = device.id
                      AND ownership.user_id = sync.user_id AND ownership.ended_at IS NULL
                     JOIN public.profiles profile ON profile.id = ownership.user_id
                      AND profile.account_status = 'active'
                     JOIN public.provisioning_session session
                       ON session.id = device.provisioning_session_id
                      AND session.id = sync.provisioning_session_id
                      AND session.device_id = device.id AND session.user_id = ownership.user_id
                      AND session.status = 'claimed'
                    WHERE device.id = sync.device_id
                 )
                """
            )
            await connection.execute(
                """
                INSERT INTO public.device_location_sync_state (
                  device_id, user_id, provisioning_session_id, next_attempt_at
                )
                SELECT device.id, ownership.user_id, session.id,
                       now() + make_interval(secs =>
                         (('x' || substr(md5(device.id::text), 1, 8))::bit(32)::bigint
                          %% %s)::integer)
                  FROM public.device device
                  JOIN public.ownership ownership ON ownership.device_id = device.id
                   AND ownership.ended_at IS NULL
                  JOIN public.profiles profile ON profile.id = ownership.user_id
                   AND profile.account_status = 'active'
                  JOIN public.provisioning_session session
                    ON session.id = device.provisioning_session_id
                   AND session.device_id = device.id AND session.user_id = ownership.user_id
                   AND session.status = 'claimed'
                 WHERE (%s OR (%s AND session.google_identity_key_ciphertext IS NOT NULL))
                ON CONFLICT (device_id) DO NOTHING
                """,
                (self.settings.location_sync_interval_seconds,
                 "apple" in self.enabled_networks, "google" in self.enabled_networks),
            )
            await connection.execute(
                "DELETE FROM public.location_rate_limit "
                "WHERE window_started_at < now() - interval '2 days'"
            )
            await connection.execute(
                "DELETE FROM public.location_refresh_failure "
                "WHERE failed_at < now() - interval '30 days'"
            )

    async def run(self, stop: asyncio.Event) -> None:
        while not stop.is_set():
            try:
                await self.reconcile_once()
            except Exception as exc:
                logger.error("location_scheduler_failed error_type=%s", type(exc).__name__)
            try:
                await asyncio.wait_for(
                    stop.wait(), timeout=self.settings.location_scheduler_interval_seconds
                )
            except TimeoutError:
                pass


class LocationSyncWorker:
    """Consume a durable priority queue with per-claim fencing and bounded work."""

    def __init__(
        self, database: Database, location: LocationService, *,
        enabled_networks: frozenset[str], settings: Settings | None = None,
        interval_seconds: int | None = None, batch_size: int | None = None,
        idle_seconds: float = 1.0, lease_seconds: int | None = None,
    ) -> None:
        # Keep the former constructor usable by local callers and integrations.
        if settings is None:
            settings = cast(Settings, SimpleNamespace(
                location_sync_interval_seconds=interval_seconds or 900,
                location_sync_batch_size=batch_size or 8,
                location_refresh_lease_seconds=lease_seconds or 120,
                location_job_timeout_seconds=60,
                location_scheduler_interval_seconds=60,
                location_max_attempts=5, location_retry_base_seconds=30,
                location_account_limit_per_minute=60, location_account_key="default",
                location_worker_queue="all", location_inactive_after_days=30,
                location_inactive_interval_seconds=21600,
            ))
        self.settings = settings
        self.database = database
        self.location = location
        self.enabled_networks = enabled_networks
        self.interval_seconds = interval_seconds or settings.location_sync_interval_seconds
        self.batch_size = batch_size or settings.location_sync_batch_size
        self.lease_seconds = lease_seconds or settings.location_refresh_lease_seconds
        self.idle_seconds = idle_seconds
        if self.interval_seconds < 60 or not 1 <= self.batch_size <= 64:
            raise ValueError("location sync timing is invalid")
        if self.lease_seconds < settings.location_job_timeout_seconds + 10:
            raise ValueError("location lease must exceed the job deadline by 10 seconds")
        self.worker_id = uuid4()
        self.scheduler = LocationScheduler(
            database, settings=settings, enabled_networks=enabled_networks
        )

    async def reconcile_once(self) -> None:
        await self.scheduler.reconcile_once()

    async def claim_due(self) -> list[LocationSyncJob]:
        if not self.enabled_networks:
            return []
        async with self.database.transaction() as connection:
            query = await connection.execute(
                """
                WITH due AS (
                  SELECT sync.device_id,
                         COALESCE(sync.last_success_at >= sync.last_attempt_at, false)
                           AND sync.lease_owner IS NOT NULL AS already_completed
                    FROM public.device_location_sync_state sync
                   WHERE sync.next_attempt_at <= now()
                     AND (sync.lease_owner IS NULL OR sync.lease_expires_at <= now())
                     AND EXISTS (
                       SELECT 1 FROM public.provisioning_session session
                         JOIN public.device device ON device.id = session.device_id
                          AND device.provisioning_session_id = session.id
                         JOIN public.ownership ownership ON ownership.device_id = device.id
                          AND ownership.user_id = sync.user_id AND ownership.ended_at IS NULL
                         JOIN public.profiles profile ON profile.id = ownership.user_id
                          AND profile.account_status = 'active'
                        WHERE session.id = sync.provisioning_session_id
                          AND session.user_id = sync.user_id AND session.status = 'claimed'
                          AND (%s OR (%s AND session.google_identity_key_ciphertext IS NOT NULL))
                     )
                     AND (%s = 'all' OR (%s = 'realtime' AND sync.priority = 10)
                                      OR (%s = 'scheduled' AND sync.priority = 0))
                   ORDER BY sync.priority DESC, sync.next_attempt_at, sync.device_id
                   FOR UPDATE OF sync SKIP LOCKED LIMIT %s
                )
                UPDATE public.device_location_sync_state sync
                   SET lease_owner = gen_random_uuid(),
                       lease_expires_at = now() + make_interval(secs => %s),
                       last_attempt_at = now(), attempt_count = sync.attempt_count + 1,
                       updated_at = now()
                  FROM due WHERE sync.device_id = due.device_id
                RETURNING sync.device_id, sync.user_id, sync.provisioning_session_id,
                          sync.consecutive_failures, sync.lease_owner, sync.attempt_count,
                          sync.reason, COALESCE(sync.requested_at, sync.next_attempt_at) AS requested_at,
                          due.already_completed
                """,
                ("apple" in self.enabled_networks, "google" in self.enabled_networks)
                + (self.settings.location_worker_queue,) * 3 + (self.batch_size, self.lease_seconds),
            )
            rows = await query.fetchall()
        return [LocationSyncJob(**row) for row in rows]

    def retry_delay_seconds(self, job: LocationSyncJob) -> int:
        base = min(self.interval_seconds,
                   self.settings.location_retry_base_seconds * (2 ** min(job.attempt_count - 1, 10)))
        # +/-20% stable jitter; bounded integer arithmetic even after many crashes.
        return max(1, min(self.interval_seconds, base + base * ((job.device_id.int % 4001) - 2000) // 10000))

    async def _finish_success(self, job: LocationSyncJob, provider_report_at: datetime | None) -> None:
        async with self.database.transaction() as connection:
            await connection.execute(
                """
                UPDATE public.device_location_sync_state
                   SET next_attempt_at = now() + make_interval(secs =>
                         (CASE WHEN last_accessed_at < now() - make_interval(days => %s)
                          THEN %s ELSE %s END) + %s),
                       last_provider_report_at = GREATEST(last_provider_report_at, %s::timestamptz),
                       consecutive_failures = 0, attempt_count = 0, last_error_code = NULL,
                       priority = 0, reason = 'scheduled', requested_at = NULL, failed_at = NULL,
                       lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
                 WHERE device_id = %s AND user_id = %s AND provisioning_session_id = %s
                   AND lease_owner = %s AND lease_expires_at > clock_timestamp()
                """,
                (self.settings.location_inactive_after_days,
                 self.settings.location_inactive_interval_seconds, self.interval_seconds,
                 (job.device_id.int % max(1, self.interval_seconds // 5)) - self.interval_seconds // 10,
                 provider_report_at, job.device_id, job.user_id,
                 job.provisioning_session_id, job.lease_owner),
            )

    async def _finish_failure(self, job: LocationSyncJob, code: str, *, timeout: bool = False) -> None:
        exhausted = job.attempt_count >= self.settings.location_max_attempts
        delay = self.interval_seconds if exhausted else self.retry_delay_seconds(job)
        if timeout:
            # A cancelled synchronous dependency must not allow immediate overlap.
            delay = max(delay, self.lease_seconds)
        async with self.database.transaction() as connection:
            # The failure archive's foreign key takes a device lock. Acquire it
            # before the queue row, matching ingestion, enqueue and release.
            await connection.execute(
                "SELECT id FROM public.device WHERE id = %s FOR UPDATE",
                (job.device_id,),
            )
            await connection.execute(
                """
                WITH failed AS (
                  UPDATE public.device_location_sync_state
                     SET next_attempt_at = now() + make_interval(secs => %s),
                         consecutive_failures = LEAST(consecutive_failures + 1, 1000000),
                         last_error_code = %s, reason = 'retry',
                         failed_at = CASE WHEN %s THEN now() ELSE failed_at END,
                         priority = CASE WHEN %s THEN 0 ELSE priority END,
                         requested_at = CASE WHEN %s THEN NULL ELSE requested_at END,
                         attempt_count = CASE WHEN %s THEN 0 ELSE attempt_count END,
                         lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
                   WHERE device_id = %s AND user_id = %s AND provisioning_session_id = %s
                     AND lease_owner = %s
                  RETURNING device_id, user_id, provisioning_session_id
                )
                INSERT INTO public.location_refresh_failure
                  (device_id, user_id, provisioning_session_id, reason, attempt_count, error_code)
                SELECT device_id, user_id, provisioning_session_id, %s, %s, %s
                  FROM failed WHERE %s
                """,
                (delay, code, exhausted, exhausted, exhausted, exhausted,
                 job.device_id, job.user_id, job.provisioning_session_id, job.lease_owner,
                 job.reason, job.attempt_count, code, exhausted),
            )
        logger.warning("location_fetch_failed device=%s reason=%s worker=%s attempt=%s code=%s retry_seconds=%s exhausted=%s",
                       job.device_id, job.reason, self.worker_id, job.attempt_count, code, delay, exhausted)

    async def _drop_ineligible(self, job: LocationSyncJob) -> None:
        async with self.database.transaction() as connection:
            await connection.execute(
                """
                DELETE FROM public.device_location_sync_state
                 WHERE device_id = %s AND user_id = %s AND provisioning_session_id = %s
                   AND lease_owner = %s
                """,
                (job.device_id, job.user_id, job.provisioning_session_id, job.lease_owner),
            )

    async def _reserve_upstream_budget(self, job: LocationSyncJob) -> bool:
        async with self.database.transaction() as connection:
            query = await connection.execute(
                """
                SELECT device_id FROM public.device_location_sync_state
                 WHERE device_id = %s AND lease_owner = %s
                   AND lease_expires_at > clock_timestamp()
                 FOR UPDATE
                """, (job.device_id, job.lease_owner),
            )
            if await query.fetchone() is None:
                return False
            if await consume_rate_limit(
                connection, scope=f"upstream:{self.settings.location_account_key}",
                limit=self.settings.location_account_limit_per_minute,
            ):
                # Waiting for the shared account-budget row may have consumed
                # part of this claim. Start provider work with a full deadline
                # while the queue row is still locked against other consumers.
                renewed = await connection.execute(
                    """
                    UPDATE public.device_location_sync_state
                       SET lease_expires_at = clock_timestamp() + make_interval(secs => %s)
                     WHERE device_id = %s AND lease_owner = %s
                    RETURNING device_id
                    """, (self.lease_seconds, job.device_id, job.lease_owner),
                )
                return await renewed.fetchone() is not None
            await connection.execute(
                """
                UPDATE public.device_location_sync_state
                   SET next_attempt_at = date_trunc('minute', now()) + interval '1 minute',
                       attempt_count = GREATEST(0, attempt_count - 1),
                       lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
                 WHERE device_id = %s AND lease_owner = %s
                """, (job.device_id, job.lease_owner),
            )
            return False

    async def process(self, job: LocationSyncJob) -> None:
        if job.already_completed:
            # Ingestion committed before a previous consumer died before ack.
            # Preserve its original fetch timestamp; do not call the provider again.
            await self._finish_success(job, None)
            return
        if job.attempt_count > self.settings.location_max_attempts:
            await self._finish_failure(job, "LOCATION_RETRY_EXHAUSTED")
            return
        if not await self._reserve_upstream_budget(job):
            return
        started = time.monotonic()
        queue_delay = max(0.0, (datetime.now(UTC) - job.requested_at).total_seconds()) if job.requested_at else 0.0
        logger.info("location_fetch_started device=%s reason=%s worker=%s attempt=%s queue_delay_seconds=%.3f",
                    job.device_id, job.reason, self.worker_id, job.attempt_count, queue_delay)
        try:
            response = await asyncio.wait_for(
                self.location.refresh_report(
                    self.database, user_id=job.user_id, device_id=job.device_id,
                    session_id=job.provisioning_session_id, lease_owner=job.lease_owner,
                ), timeout=self.settings.location_job_timeout_seconds,
            )
        except TimeoutError:
            await self._finish_failure(job, "LOCATION_REFRESH_TIMEOUT", timeout=True)
            return
        except LocationError as exc:
            if exc.status_code in {403, 404}:
                await self._drop_ineligible(job)
                return
            await self._finish_failure(job, exc.code)
            return
        except Exception as exc:
            logger.error("location_sync_job_failed device=%s error_type=%s", job.device_id, type(exc).__name__)
            await self._finish_failure(job, "LOCATION_SYNC_FAILED")
            return
        await self._finish_success(job, response.last_location_at)
        device_age = max(0.0, (datetime.now(UTC) - response.last_location_at).total_seconds()) if response.last_location_at else None
        logger.info("location_fetch_completed device=%s reason=%s worker=%s attempt=%s duration_seconds=%.3f device_age_seconds=%s",
                    job.device_id, job.reason, self.worker_id, job.attempt_count,
                    time.monotonic() - started, device_age)

    async def sync_once(self) -> int:
        await self.reconcile_once()
        jobs = await self.claim_due()
        if jobs:
            # A database failure in one job must not detach its siblings and
            # start another batch while those provider calls are still running.
            results = await asyncio.gather(
                *(self.process(job) for job in jobs), return_exceptions=True
            )
            for result in results:
                if isinstance(result, BaseException):
                    raise result
        return len(jobs)

    async def run(self, stop: asyncio.Event) -> None:
        while not stop.is_set():
            try:
                processed = await self.sync_once()
            except Exception as exc:
                logger.error("location_sync_cycle_failed worker=%s error_type=%s", self.worker_id, type(exc).__name__)
                processed = 0
            if processed:
                continue
            try:
                await asyncio.wait_for(stop.wait(), timeout=self.idle_seconds)
            except TimeoutError:
                pass
