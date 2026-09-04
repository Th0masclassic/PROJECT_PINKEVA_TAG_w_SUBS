from __future__ import annotations

import uuid
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator

import pytest

from app.cancellation_worker import (
    CancellationJob,
    CancellationWorker,
    CancellationWorkerSettings,
    PermanentProviderError,
    PostgresCancellationRepository,
    RetryableProviderError,
    StripeCancellationGateway,
)


def worker_settings(**overrides: Any) -> CancellationWorkerSettings:
    values: dict[str, Any] = {
        "database_url": "postgresql://localhost/pinkeva_test",
        "stripe_secret_key": "sk_test_12345678901234567890",
        "stripe_api_version": "2025-08-27.basil",
        "batch_size": 10,
        "poll_interval_seconds": 1,
        "lease_seconds": 60,
        "max_attempts": 4,
        "retry_base_seconds": 5,
        "retry_max_seconds": 60,
        "webhook_timeout_seconds": 3600,
    }
    values.update(overrides)
    return CancellationWorkerSettings(**values)


def cancellation_job(
    attempt_count: int = 1,
    *,
    cancellation_reason: str = "device_release",
    device_release_id: uuid.UUID | None = uuid.UUID(
        "30000000-0000-0000-0000-000000000001"
    ),
) -> CancellationJob:
    return CancellationJob(
        id=uuid.UUID("10000000-0000-0000-0000-000000000001"),
        subscription_id=uuid.UUID("20000000-0000-0000-0000-000000000001"),
        device_release_id=device_release_id,
        cancellation_reason=cancellation_reason,
        provider_subscription_id="sub_12345678",
        attempt_count=attempt_count,
    )


class FakeRepository:
    def __init__(self, job: CancellationJob, *, valid: bool = True) -> None:
        self.job = job
        self.valid = valid
        self.expired_count = 0
        self.claimed = False
        self.awaiting: list[tuple[CancellationJob, str, int]] = []
        self.retries: list[tuple[CancellationJob, str, int, str]] = []
        self.failed: list[tuple[CancellationJob, str, str]] = []

    async def expire_webhook_waits(self) -> int:
        return self.expired_count

    async def claim_due(
        self, *, lease_owner: str, batch_size: int, lease_seconds: int
    ) -> list[CancellationJob]:
        assert batch_size > 0
        assert lease_seconds > 0
        if self.claimed:
            return []
        self.claimed = True
        return [self.job]

    async def validate_claim(
        self, job: CancellationJob, *, lease_owner: str
    ) -> bool:
        assert job == self.job
        return self.valid

    async def mark_awaiting_webhook(
        self,
        job: CancellationJob,
        *,
        lease_owner: str,
        webhook_timeout_seconds: int,
    ) -> bool:
        self.awaiting.append((job, lease_owner, webhook_timeout_seconds))
        return True

    async def schedule_retry(
        self,
        job: CancellationJob,
        *,
        lease_owner: str,
        delay_seconds: int,
        error_code: str,
    ) -> bool:
        self.retries.append((job, lease_owner, delay_seconds, error_code))
        return True

    async def mark_failed(
        self, job: CancellationJob, *, lease_owner: str, error_code: str
    ) -> bool:
        self.failed.append((job, lease_owner, error_code))
        return True


class FakeGateway:
    def __init__(self, error: Exception | None = None) -> None:
        self.error = error
        self.calls: list[tuple[str, str]] = []

    async def cancel_subscription(
        self, provider_subscription_id: str, *, idempotency_key: str
    ) -> None:
        self.calls.append((provider_subscription_id, idempotency_key))
        if self.error is not None:
            raise self.error


@pytest.mark.asyncio
async def test_success_uses_stable_idempotency_and_waits_for_webhook() -> None:
    job = cancellation_job()
    repository = FakeRepository(job)
    gateway = FakeGateway()
    worker = CancellationWorker(
        worker_settings(), repository, gateway, worker_id="worker-a"
    )

    assert await worker.run_once() == 1

    assert gateway.calls == [
        ("sub_12345678", f"pinqeva-release-cancel-{job.id}")
    ]
    assert repository.awaiting == [(job, "worker-a", 3600)]
    assert repository.failed == []
    assert repository.retries == []


@pytest.mark.asyncio
async def test_ownership_lost_checkout_uses_same_idempotent_delivery() -> None:
    job = cancellation_job(
        cancellation_reason="ownership_lost_checkout",
        device_release_id=None,
    )
    repository = FakeRepository(job)
    gateway = FakeGateway()
    worker = CancellationWorker(
        worker_settings(), repository, gateway, worker_id="worker-a"
    )

    await worker.run_once()

    assert gateway.calls == [
        ("sub_12345678", f"pinqeva-release-cancel-{job.id}")
    ]
    assert repository.awaiting == [(job, "worker-a", 3600)]


@pytest.mark.asyncio
async def test_invalid_release_subscription_binding_never_calls_provider() -> None:
    job = cancellation_job()
    repository = FakeRepository(job, valid=False)
    gateway = FakeGateway()
    worker = CancellationWorker(
        worker_settings(), repository, gateway, worker_id="worker-a"
    )

    await worker.run_once()

    assert gateway.calls == []
    assert repository.failed == [(job, "worker-a", "OUTBOX_BINDING_INVALID")]


@pytest.mark.asyncio
async def test_transient_provider_error_is_retried_with_bounded_backoff() -> None:
    job = cancellation_job(attempt_count=2)
    repository = FakeRepository(job)
    worker = CancellationWorker(
        worker_settings(retry_base_seconds=10, retry_max_seconds=30),
        repository,
        FakeGateway(RetryableProviderError()),
        worker_id="worker-a",
    )

    await worker.run_once()

    assert len(repository.retries) == 1
    retried_job, owner, delay, code = repository.retries[0]
    assert retried_job == job
    assert owner == "worker-a"
    assert 1 <= delay <= 30
    assert code == "PROVIDER_TEMPORARY"
    assert repository.failed == []


@pytest.mark.asyncio
async def test_retry_budget_is_finite() -> None:
    job = cancellation_job(attempt_count=4)
    repository = FakeRepository(job)
    worker = CancellationWorker(
        worker_settings(max_attempts=4),
        repository,
        FakeGateway(RetryableProviderError()),
        worker_id="worker-a",
    )

    await worker.run_once()

    assert repository.retries == []
    assert repository.failed == [
        (job, "worker-a", "PROVIDER_RETRY_EXHAUSTED")
    ]


@pytest.mark.asyncio
async def test_permanent_provider_error_records_only_safe_code() -> None:
    job = cancellation_job()
    repository = FakeRepository(job)
    worker = CancellationWorker(
        worker_settings(),
        repository,
        FakeGateway(PermanentProviderError("PROVIDER_REQUEST_REJECTED")),
        worker_id="worker-a",
    )

    await worker.run_once()

    assert repository.failed == [
        (job, "worker-a", "PROVIDER_REQUEST_REJECTED")
    ]


@pytest.mark.asyncio
async def test_gateway_rejects_malformed_provider_id_without_network() -> None:
    gateway = StripeCancellationGateway(worker_settings())

    with pytest.raises(PermanentProviderError) as error:
        await gateway.cancel_subscription(
            "not-a-subscription", idempotency_key="safe-idempotency-key"
        )

    assert error.value.code == "PROVIDER_IDENTIFIER_INVALID"


@pytest.mark.asyncio
async def test_gateway_uses_immediate_idempotent_cancellation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}

    def fake_cancel(provider_subscription_id: str, **parameters: Any) -> dict[str, str]:
        captured["provider_subscription_id"] = provider_subscription_id
        captured.update(parameters)
        return {"id": provider_subscription_id, "status": "canceled"}

    gateway = StripeCancellationGateway(worker_settings())
    monkeypatch.setattr(gateway._client.v1.subscriptions, "cancel", fake_cancel)

    await gateway.cancel_subscription(
        "sub_12345678", idempotency_key="pinqeva-release-cancel-test"
    )

    assert captured["provider_subscription_id"] == "sub_12345678"
    assert captured["options"]["idempotency_key"] == "pinqeva-release-cancel-test"
    assert captured["params"] == {"invoice_now": False, "prorate": False}


class Cursor:
    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self.rows = rows

    async def fetchall(self) -> list[dict[str, Any]]:
        return self.rows

    async def fetchone(self) -> dict[str, Any] | None:
        return self.rows[0] if self.rows else None


class CapturingConnection:
    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self.rows = rows
        self.query = ""
        self.parameters: tuple[Any, ...] = ()

    async def execute(
        self, query: str, parameters: tuple[Any, ...] = ()
    ) -> Cursor:
        self.query = " ".join(query.split())
        self.parameters = parameters
        return Cursor(self.rows)


class CapturingDatabase:
    def __init__(self, connection: CapturingConnection) -> None:
        self.connection = connection

    @asynccontextmanager
    async def transaction(self) -> AsyncIterator[CapturingConnection]:
        yield self.connection


@pytest.mark.asyncio
async def test_claim_query_uses_skip_locked_and_expiring_leases() -> None:
    job = cancellation_job(attempt_count=3)
    connection = CapturingConnection(
        [
            {
                "id": job.id,
                "subscription_id": job.subscription_id,
                "device_release_id": job.device_release_id,
                "cancellation_reason": job.cancellation_reason,
                "provider_subscription_id": job.provider_subscription_id,
                "attempt_count": job.attempt_count,
            }
        ]
    )
    repository = PostgresCancellationRepository(  # type: ignore[arg-type]
        CapturingDatabase(connection)
    )

    jobs = await repository.claim_due(
        lease_owner="worker-a", batch_size=7, lease_seconds=90
    )

    assert jobs == [job]
    assert "FOR UPDATE OF queue SKIP LOCKED" in connection.query
    assert "queue.lease_expires_at <= now()" in connection.query
    assert "attempt_count = queue.attempt_count + 1" in connection.query
    assert connection.parameters == (7, "worker-a", 90)


@pytest.mark.asyncio
async def test_compensation_validation_requires_no_active_former_ownership() -> None:
    job = cancellation_job(
        cancellation_reason="ownership_lost_checkout",
        device_release_id=None,
    )
    connection = CapturingConnection([{"id": job.id}])
    repository = PostgresCancellationRepository(  # type: ignore[arg-type]
        CapturingDatabase(connection)
    )

    assert await repository.validate_claim(job, lease_owner="worker-a")

    assert "queue.cancellation_reason = 'ownership_lost_checkout'" in connection.query
    assert "queue.device_release_id IS NULL" in connection.query
    assert "subscription.ended_reason = 'ownership_lost_checkout'" in connection.query
    assert "subscription.provider_terminal_event_at IS NULL" in connection.query
    assert "NOT EXISTS" in connection.query
    assert "active_ownership.ended_at IS NULL" in connection.query
    assert connection.parameters == (
        job.id,
        "worker-a",
        job.subscription_id,
        None,
        "ownership_lost_checkout",
        job.provider_subscription_id,
    )
