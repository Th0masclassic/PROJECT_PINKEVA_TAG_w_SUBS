from __future__ import annotations

import asyncio
import logging
import os
import re
import signal
import socket
from dataclasses import dataclass
from datetime import timedelta
from typing import Any, Mapping, Protocol
from uuid import UUID, uuid4

import stripe
from psycopg import AsyncConnection

from .config import (
    STRIPE_API_VERSION_PATTERN,
    ConfigurationError,
    validate_database_url,
    validate_stripe_secret,
)
from .database import Database


logger = logging.getLogger("pinqeva.cancellation_worker")

PROVIDER_SUBSCRIPTION_ID_PATTERN = re.compile(r"^sub_[A-Za-z0-9]{8,250}$")
IDEMPOTENCY_PREFIX = "pinqeva-release-cancel-"


class WorkerConfigurationError(RuntimeError):
    pass


class RetryableProviderError(RuntimeError):
    def __init__(self, code: str = "PROVIDER_TEMPORARY") -> None:
        super().__init__(code)
        self.code = code


class PermanentProviderError(RuntimeError):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def _required_environment(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise WorkerConfigurationError(f"Missing required environment variable: {name}")
    return value


def _bounded_integer(name: str, default: int, minimum: int, maximum: int) -> int:
    raw = os.getenv(name, str(default)).strip()
    try:
        value = int(raw)
    except ValueError:
        raise WorkerConfigurationError(f"{name} must be an integer") from None
    if not minimum <= value <= maximum:
        raise WorkerConfigurationError(
            f"{name} must be between {minimum} and {maximum}"
        )
    return value


@dataclass(frozen=True)
class CancellationWorkerSettings:
    database_url: str
    stripe_secret_key: str
    stripe_api_version: str
    batch_size: int = 10
    poll_interval_seconds: int = 5
    lease_seconds: int = 120
    max_attempts: int = 8
    retry_base_seconds: int = 5
    retry_max_seconds: int = 900
    webhook_timeout_seconds: int = 86_400

    @classmethod
    def from_environment(cls) -> CancellationWorkerSettings:
        try:
            database_url = validate_database_url(_required_environment("DATABASE_URL"))
            stripe_secret_key = validate_stripe_secret(
                "STRIPE_SECRET_KEY",
                _required_environment("STRIPE_SECRET_KEY"),
                ("sk_test_", "sk_live_"),
            )
        except ConfigurationError as exc:
            raise WorkerConfigurationError(str(exc)) from None

        stripe_api_version = os.getenv(
            "STRIPE_API_VERSION", "2025-08-27.basil"
        ).strip()
        if not STRIPE_API_VERSION_PATTERN.fullmatch(stripe_api_version):
            raise WorkerConfigurationError("STRIPE_API_VERSION has an invalid format")

        settings = cls(
            database_url=database_url,
            stripe_secret_key=stripe_secret_key,
            stripe_api_version=stripe_api_version,
            batch_size=_bounded_integer(
                "PINQEVA_CANCELLATION_BATCH_SIZE", 10, 1, 100
            ),
            poll_interval_seconds=_bounded_integer(
                "PINQEVA_CANCELLATION_POLL_SECONDS", 5, 1, 300
            ),
            lease_seconds=_bounded_integer(
                "PINQEVA_CANCELLATION_LEASE_SECONDS", 120, 30, 3600
            ),
            max_attempts=_bounded_integer(
                "PINQEVA_CANCELLATION_MAX_ATTEMPTS", 8, 1, 20
            ),
            retry_base_seconds=_bounded_integer(
                "PINQEVA_CANCELLATION_RETRY_BASE_SECONDS", 5, 1, 300
            ),
            retry_max_seconds=_bounded_integer(
                "PINQEVA_CANCELLATION_RETRY_MAX_SECONDS", 900, 30, 86_400
            ),
            webhook_timeout_seconds=_bounded_integer(
                "PINQEVA_CANCELLATION_WEBHOOK_TIMEOUT_SECONDS",
                86_400,
                300,
                604_800,
            ),
        )
        if settings.retry_base_seconds > settings.retry_max_seconds:
            raise WorkerConfigurationError(
                "PINQEVA_CANCELLATION_RETRY_BASE_SECONDS must not exceed the maximum"
            )
        if settings.lease_seconds <= settings.poll_interval_seconds:
            raise WorkerConfigurationError(
                "PINQEVA_CANCELLATION_LEASE_SECONDS must exceed the poll interval"
            )
        return settings


@dataclass(frozen=True)
class CancellationJob:
    id: UUID
    subscription_id: UUID
    device_release_id: UUID | None
    cancellation_reason: str
    provider_subscription_id: str
    attempt_count: int

    @property
    def idempotency_key(self) -> str:
        return f"{IDEMPOTENCY_PREFIX}{self.id}"


class CancellationGateway(Protocol):
    async def cancel_subscription(
        self, provider_subscription_id: str, *, idempotency_key: str
    ) -> None: ...


class StripeCancellationGateway:
    def __init__(self, settings: CancellationWorkerSettings) -> None:
        self._api_key = settings.stripe_secret_key
        self._api_version = settings.stripe_api_version
        self._client = stripe.StripeClient(
            self._api_key,
            stripe_version=self._api_version,
            max_network_retries=0,
            http_client=stripe.RequestsClient(timeout=15),
        )

    async def cancel_subscription(
        self, provider_subscription_id: str, *, idempotency_key: str
    ) -> None:
        if not PROVIDER_SUBSCRIPTION_ID_PATTERN.fullmatch(provider_subscription_id):
            raise PermanentProviderError("PROVIDER_IDENTIFIER_INVALID")
        try:
            response = await asyncio.to_thread(
                self._client.v1.subscriptions.cancel,
                provider_subscription_id,
                params={"invoice_now": False, "prorate": False},
                options={"idempotency_key": idempotency_key},
            )
        except (stripe.RateLimitError, stripe.APIConnectionError, stripe.APIError):
            raise RetryableProviderError() from None
        except (stripe.AuthenticationError, stripe.PermissionError):
            raise PermanentProviderError("PROVIDER_AUTHORIZATION_FAILED") from None
        except stripe.InvalidRequestError as exc:
            code = getattr(exc, "code", None)
            if code == "resource_missing":
                raise PermanentProviderError(
                    "PROVIDER_SUBSCRIPTION_NOT_FOUND"
                ) from None
            http_status = getattr(exc, "http_status", None)
            if http_status in {409, 429} or (
                isinstance(http_status, int) and http_status >= 500
            ):
                raise RetryableProviderError() from None
            raise PermanentProviderError("PROVIDER_REQUEST_REJECTED") from None
        except stripe.StripeError as exc:
            http_status = getattr(exc, "http_status", None)
            if http_status in {409, 429} or (
                isinstance(http_status, int) and http_status >= 500
            ):
                raise RetryableProviderError() from None
            raise PermanentProviderError("PROVIDER_REQUEST_REJECTED") from None
        except (TimeoutError, ConnectionError, OSError):
            raise RetryableProviderError() from None

        response_id = _provider_field(response, "id")
        response_status = _provider_field(response, "status")
        if response_id != provider_subscription_id or response_status != "canceled":
            raise PermanentProviderError("PROVIDER_RESPONSE_INVALID")


def _provider_field(response: Any, name: str) -> Any:
    if isinstance(response, Mapping):
        return response.get(name)
    return getattr(response, name, None)


class CancellationRepository(Protocol):
    async def expire_webhook_waits(self) -> int: ...

    async def claim_due(
        self, *, lease_owner: str, batch_size: int, lease_seconds: int
    ) -> list[CancellationJob]: ...

    async def validate_claim(
        self, job: CancellationJob, *, lease_owner: str
    ) -> bool: ...

    async def mark_awaiting_webhook(
        self,
        job: CancellationJob,
        *,
        lease_owner: str,
        webhook_timeout_seconds: int,
    ) -> bool: ...

    async def schedule_retry(
        self,
        job: CancellationJob,
        *,
        lease_owner: str,
        delay_seconds: int,
        error_code: str,
    ) -> bool: ...

    async def mark_failed(
        self, job: CancellationJob, *, lease_owner: str, error_code: str
    ) -> bool: ...


class PostgresCancellationRepository:
    def __init__(self, database: Database) -> None:
        self.database = database

    async def expire_webhook_waits(self) -> int:
        async with self.database.transaction() as connection:
            cursor = await connection.execute(
                """
                UPDATE public.subscription_cancellation_outbox
                   SET status = 'failed',
                       last_error_code = 'WEBHOOK_CONFIRMATION_TIMEOUT',
                       updated_at = now()
                 WHERE status = 'awaiting_webhook'
                   AND webhook_deadline_at <= now()
                RETURNING id
                """
            )
            return len(await cursor.fetchall())

    async def claim_due(
        self, *, lease_owner: str, batch_size: int, lease_seconds: int
    ) -> list[CancellationJob]:
        async with self.database.transaction() as connection:
            cursor = await connection.execute(
                """
                WITH due AS (
                    SELECT queue.id
                      FROM public.subscription_cancellation_outbox queue
                     WHERE (
                           queue.status = 'pending'
                       AND queue.next_attempt_at <= now()
                     ) OR (
                           queue.status = 'processing'
                       AND queue.lease_expires_at <= now()
                     )
                     ORDER BY
                       CASE
                         WHEN queue.status = 'pending' THEN queue.next_attempt_at
                         ELSE queue.lease_expires_at
                       END,
                       queue.id
                     FOR UPDATE OF queue SKIP LOCKED
                     LIMIT %s
                )
                UPDATE public.subscription_cancellation_outbox queue
                   SET status = 'processing',
                       attempt_count = queue.attempt_count + 1,
                       last_attempt_at = now(),
                       lease_owner = %s,
                       lease_expires_at = now() + (%s * interval '1 second'),
                       updated_at = now()
                  FROM due
                 WHERE queue.id = due.id
                RETURNING queue.id, queue.subscription_id,
                          queue.device_release_id,
                          queue.cancellation_reason,
                          queue.provider_subscription_id,
                          queue.attempt_count
                """,
                (batch_size, lease_owner, lease_seconds),
            )
            rows = await cursor.fetchall()
        return [
            CancellationJob(
                id=row["id"],
                subscription_id=row["subscription_id"],
                device_release_id=row["device_release_id"],
                cancellation_reason=row["cancellation_reason"],
                provider_subscription_id=row["provider_subscription_id"],
                attempt_count=int(row["attempt_count"]),
            )
            for row in rows
        ]

    async def validate_claim(self, job: CancellationJob, *, lease_owner: str) -> bool:
        async with self.database.transaction() as connection:
            cursor = await connection.execute(
                """
                SELECT queue.id
                  FROM public.subscription_cancellation_outbox queue
                  JOIN public.subscription subscription
                    ON subscription.id = queue.subscription_id
                  LEFT JOIN public.device_release release
                    ON release.id = queue.device_release_id
                 WHERE queue.id = %s
                   AND queue.status = 'processing'
                   AND queue.lease_owner = %s
                   AND queue.lease_expires_at > now()
                   AND queue.subscription_id = %s
                   AND queue.device_release_id IS NOT DISTINCT FROM %s
                   AND queue.cancellation_reason = %s
                   AND queue.provider_subscription_id = %s
                   AND subscription.provider_subscription_id =
                       queue.provider_subscription_id
                   AND (
                       (
                           queue.cancellation_reason = 'device_release'
                           AND queue.device_release_id IS NOT NULL
                           AND subscription.device_id = release.device_id
                           AND subscription.user_id = release.user_id
                           AND release.status = 'completed'
                           AND release.completed_at IS NOT NULL
                           AND release.provider_cancellations_queued > 0
                           AND EXISTS (
                               SELECT 1
                                 FROM public.ownership old_ownership
                                WHERE old_ownership.user_id = release.user_id
                                  AND old_ownership.device_id = release.device_id
                                  AND old_ownership.started_at <= release.completed_at
                                  AND old_ownership.ended_at = release.completed_at
                           )
                       )
                       OR
                       (
                           queue.cancellation_reason = 'ownership_lost_checkout'
                           AND queue.device_release_id IS NULL
                           AND subscription.status IN ('cancelled', 'ended')
                           AND subscription.ended_reason = 'ownership_lost_checkout'
                           AND subscription.provider_terminal_event_at IS NULL
                           AND NOT EXISTS (
                               SELECT 1
                                 FROM public.ownership active_ownership
                                WHERE active_ownership.user_id = subscription.user_id
                                  AND active_ownership.device_id =
                                      subscription.device_id
                                  AND active_ownership.ended_at IS NULL
                           )
                       )
                        OR
                        (
                            queue.cancellation_reason = 'account_unavailable_checkout'
                            AND queue.device_release_id IS NULL
                            AND subscription.status IN ('cancelled', 'ended')
                            AND subscription.ended_reason =
                                'account_unavailable_checkout'
                            AND subscription.provider_terminal_event_at IS NULL
                        )
                        OR
                        (
                            queue.cancellation_reason = 'account_consolidation'
                            AND queue.device_release_id IS NULL
                            AND subscription.status IN ('cancelled', 'ended')
                            AND subscription.ended_reason =
                                'account_subscription_consolidated'
                            AND subscription.provider_terminal_event_at IS NULL
                        )
                        OR
                        (
                            queue.cancellation_reason = 'admin_revoked'
                           AND queue.device_release_id IS NULL
                           AND subscription.status IN ('cancelled', 'ended')
                           AND subscription.ended_reason = 'admin_revoked'
                           AND subscription.provider_terminal_event_at IS NULL
                       )
                   )
                  FOR UPDATE OF queue, subscription
                """,
                (
                    job.id,
                    lease_owner,
                    job.subscription_id,
                    job.device_release_id,
                    job.cancellation_reason,
                    job.provider_subscription_id,
                ),
            )
            return await cursor.fetchone() is not None

    async def mark_awaiting_webhook(
        self,
        job: CancellationJob,
        *,
        lease_owner: str,
        webhook_timeout_seconds: int,
    ) -> bool:
        return await self._finish_claim(
            """
            UPDATE public.subscription_cancellation_outbox
               SET status = 'awaiting_webhook',
                   cancellation_requested_at = COALESCE(
                       cancellation_requested_at, now()
                   ),
                   webhook_deadline_at = now() + (%s * interval '1 second'),
                   lease_owner = NULL,
                   lease_expires_at = NULL,
                   last_error_code = NULL,
                   updated_at = now()
             WHERE id = %s AND status = 'processing' AND lease_owner = %s
            RETURNING id
            """,
            (webhook_timeout_seconds, job.id, lease_owner),
        )

    async def schedule_retry(
        self,
        job: CancellationJob,
        *,
        lease_owner: str,
        delay_seconds: int,
        error_code: str,
    ) -> bool:
        return await self._finish_claim(
            """
            UPDATE public.subscription_cancellation_outbox
               SET status = 'pending',
                   next_attempt_at = now() + (%s * interval '1 second'),
                   lease_owner = NULL,
                   lease_expires_at = NULL,
                   last_error_code = %s,
                   updated_at = now()
             WHERE id = %s AND status = 'processing' AND lease_owner = %s
            RETURNING id
            """,
            (delay_seconds, error_code, job.id, lease_owner),
        )

    async def mark_failed(
        self, job: CancellationJob, *, lease_owner: str, error_code: str
    ) -> bool:
        return await self._finish_claim(
            """
            UPDATE public.subscription_cancellation_outbox
               SET status = 'failed',
                   lease_owner = NULL,
                   lease_expires_at = NULL,
                   last_error_code = %s,
                   updated_at = now()
             WHERE id = %s AND status = 'processing' AND lease_owner = %s
            RETURNING id
            """,
            (error_code, job.id, lease_owner),
        )

    async def _finish_claim(
        self, query: str, parameters: tuple[Any, ...]
    ) -> bool:
        async with self.database.transaction() as connection:
            cursor = await connection.execute(query, parameters)
            return await cursor.fetchone() is not None


class CancellationWorker:
    def __init__(
        self,
        settings: CancellationWorkerSettings,
        repository: CancellationRepository,
        gateway: CancellationGateway,
        *,
        worker_id: str | None = None,
    ) -> None:
        self.settings = settings
        self.repository = repository
        self.gateway = gateway
        generated_id = (
            f"{socket.gethostname()[:48]}:{os.getpid()}:{uuid4().hex[:12]}"
        )
        self.worker_id = (worker_id or generated_id)[:128]

    def retry_delay_seconds(self, job: CancellationJob) -> int:
        exponent = min(max(job.attempt_count - 1, 0), 20)
        unjittered = min(
            self.settings.retry_max_seconds,
            self.settings.retry_base_seconds * (2**exponent),
        )
        # Stable per-job jitter prevents synchronized retries without storing or
        # logging any provider data. The final value remains strictly bounded.
        jitter_basis_points = (job.id.int % 4001) - 2000
        jittered = unjittered + (unjittered * jitter_basis_points // 10_000)
        return max(1, min(self.settings.retry_max_seconds, jittered))

    async def run_once(self) -> int:
        expired = await self.repository.expire_webhook_waits()
        jobs = await self.repository.claim_due(
            lease_owner=self.worker_id,
            # Do not lease a batch that waits through earlier provider calls.
            batch_size=1,
            lease_seconds=self.settings.lease_seconds,
        )
        for job in jobs:
            await self._process(job)
        return expired + len(jobs)

    async def _process(self, job: CancellationJob) -> None:
        if not await self.repository.validate_claim(job, lease_owner=self.worker_id):
            failed = await self.repository.mark_failed(
                job,
                lease_owner=self.worker_id,
                error_code="OUTBOX_BINDING_INVALID",
            )
            if failed:
                logger.error("Cancellation binding rejected job_id=%s", job.id)
            return

        try:
            await self.gateway.cancel_subscription(
                job.provider_subscription_id,
                idempotency_key=job.idempotency_key,
            )
        except PermanentProviderError as exc:
            failed = await self.repository.mark_failed(
                job, lease_owner=self.worker_id, error_code=exc.code
            )
            if failed:
                logger.error(
                    "Cancellation permanently rejected job_id=%s code=%s",
                    job.id,
                    exc.code,
                )
            return
        except RetryableProviderError as exc:
            await self._retry_or_fail(job, exc.code)
            return
        except Exception as exc:
            logger.warning(
                "Cancellation provider call failed job_id=%s type=%s",
                job.id,
                type(exc).__name__,
            )
            await self._retry_or_fail(job, "PROVIDER_TEMPORARY")
            return

        saved = await self.repository.mark_awaiting_webhook(
            job,
            lease_owner=self.worker_id,
            webhook_timeout_seconds=self.settings.webhook_timeout_seconds,
        )
        if saved:
            logger.info("Cancellation request accepted job_id=%s", job.id)

    async def _retry_or_fail(self, job: CancellationJob, error_code: str) -> None:
        if job.attempt_count >= self.settings.max_attempts:
            failed = await self.repository.mark_failed(
                job,
                lease_owner=self.worker_id,
                error_code="PROVIDER_RETRY_EXHAUSTED",
            )
            if failed:
                logger.error("Cancellation retries exhausted job_id=%s", job.id)
            return
        delay = self.retry_delay_seconds(job)
        scheduled = await self.repository.schedule_retry(
            job,
            lease_owner=self.worker_id,
            delay_seconds=delay,
            error_code=error_code,
        )
        if scheduled:
            logger.warning(
                "Cancellation scheduled for retry job_id=%s attempt=%s",
                job.id,
                job.attempt_count,
            )

    async def run(self, stop_event: asyncio.Event) -> None:
        while not stop_event.is_set():
            try:
                processed = await self.run_once()
            except Exception as exc:
                logger.error(
                    "Cancellation worker cycle failed type=%s", type(exc).__name__
                )
                processed = 0
            if processed:
                continue
            try:
                await asyncio.wait_for(
                    stop_event.wait(),
                    timeout=self.settings.poll_interval_seconds,
                )
            except TimeoutError:
                pass


async def _run_from_environment() -> None:
    settings = CancellationWorkerSettings.from_environment()
    # Database only reads the database_url attribute, which this least-privilege
    # worker settings object deliberately supplies without provisioning secrets.
    database = Database(settings)  # type: ignore[arg-type]
    repository = PostgresCancellationRepository(database)
    worker = CancellationWorker(
        settings,
        repository,
        StripeCancellationGateway(settings),
    )
    stop_event = asyncio.Event()
    loop = asyncio.get_running_loop()
    for stop_signal in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(stop_signal, stop_event.set)
        except NotImplementedError:
            pass

    try:
        await database.open()
        logger.info("Cancellation worker started")
        await worker.run(stop_event)
    finally:
        # Signals request a cooperative stop. An in-flight provider call and its
        # state transition finish before the pool is closed; a process crash is
        # recovered by the expiring lease and stable Stripe idempotency key.
        await database.close()
        logger.info("Cancellation worker stopped")


def main() -> None:
    logging.basicConfig(
        level=os.getenv("LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    try:
        asyncio.run(_run_from_environment())
    except WorkerConfigurationError as exc:
        logger.error("Cancellation worker configuration invalid: %s", exc)
        raise SystemExit(2) from None
    except Exception as exc:
        logger.error(
            "Cancellation worker stopped unexpectedly type=%s",
            type(exc).__name__,
        )
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
