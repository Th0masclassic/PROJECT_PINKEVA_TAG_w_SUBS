from __future__ import annotations

import asyncio
from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest

from app.location import LocationError
from app.location_worker import LocationSyncJob, LocationSyncWorker


def _job(**changes):
    return replace(LocationSyncJob(uuid4(), uuid4(), uuid4(), 0), **changes)


def _worker(location=None):
    worker = LocationSyncWorker(
        SimpleNamespace(), location or SimpleNamespace(), enabled_networks=frozenset({"apple"})
    )
    worker._reserve_upstream_budget = AsyncMock(return_value=True)
    worker._finish_success = AsyncMock()
    worker._finish_failure = AsyncMock()
    worker._drop_ineligible = AsyncMock()
    return worker


@pytest.mark.asyncio
async def test_worker_passes_fenced_claim_to_provider_and_acknowledges():
    location = SimpleNamespace(refresh_report=AsyncMock(return_value=SimpleNamespace(last_location_at=None)))
    worker, job = _worker(location), _job()
    await worker.process(job)
    location.refresh_report.assert_awaited_once_with(
        worker.database, user_id=job.user_id, device_id=job.device_id,
        session_id=job.provisioning_session_id, lease_owner=job.lease_owner,
    )
    worker._finish_success.assert_awaited_once_with(job, None)


@pytest.mark.asyncio
async def test_worker_retries_safe_provider_error_without_logging_details():
    worker = _worker(SimpleNamespace(refresh_report=AsyncMock(
        side_effect=LocationError("LOCATION_UNAVAILABLE", "private credentials", 503)
    )))
    job = _job()
    await worker.process(job)
    worker._finish_failure.assert_awaited_once_with(job, "LOCATION_UNAVAILABLE")


@pytest.mark.asyncio
async def test_worker_removes_invalid_owner_binding():
    worker = _worker(SimpleNamespace(refresh_report=AsyncMock(
        side_effect=LocationError("LOCATION_UNAVAILABLE", "unavailable", 404)
    )))
    job = _job()
    await worker.process(job)
    worker._drop_ineligible.assert_awaited_once_with(job)


@pytest.mark.asyncio
async def test_worker_timeout_preserves_cooldown():
    async def hang(*args, **kwargs):
        await asyncio.Event().wait()

    worker = _worker(SimpleNamespace(refresh_report=hang))
    worker.settings.location_job_timeout_seconds = 0.01
    job = _job()
    await worker.process(job)
    worker._finish_failure.assert_awaited_once_with(job, "LOCATION_REFRESH_TIMEOUT", timeout=True)


@pytest.mark.asyncio
async def test_worker_no_upstream_when_account_budget_is_exhausted():
    location = SimpleNamespace(refresh_report=AsyncMock())
    worker = _worker(location)
    worker._reserve_upstream_budget.return_value = False
    await worker.process(_job())
    location.refresh_report.assert_not_called()


@pytest.mark.asyncio
async def test_worker_crash_after_ingestion_only_acknowledges():
    location = SimpleNamespace(refresh_report=AsyncMock())
    worker, job = _worker(location), _job(already_completed=True)
    await worker.process(job)
    location.refresh_report.assert_not_called()
    worker._reserve_upstream_budget.assert_not_called()
    worker._finish_success.assert_awaited_once_with(job, None)


@pytest.mark.asyncio
async def test_worker_exhausted_crashed_claims_become_persisted_failure():
    location = SimpleNamespace(refresh_report=AsyncMock())
    worker, job = _worker(location), _job(attempt_count=6)
    await worker.process(job)
    location.refresh_report.assert_not_called()
    worker._finish_failure.assert_awaited_once_with(job, "LOCATION_RETRY_EXHAUSTED")


def test_retry_backoff_is_exponential_jittered_and_bounded():
    worker, job = _worker(), _job()
    delays = [worker.retry_delay_seconds(replace(job, attempt_count=n)) for n in range(1, 12)]
    assert 24 <= delays[0] <= 36
    assert delays[1] >= delays[0] * 1.8
    assert delays == sorted(delays)
    assert max(delays) <= worker.interval_seconds


def test_lease_must_outlast_job_timeout():
    with pytest.raises(ValueError, match="lease"):
        LocationSyncWorker(SimpleNamespace(), SimpleNamespace(), enabled_networks=frozenset({"apple"}), lease_seconds=60)


@pytest.mark.asyncio
async def test_failed_batch_drains_all_siblings_before_raising():
    worker = _worker()
    first, second = _job(), _job()
    worker.reconcile_once = AsyncMock()
    worker.claim_due = AsyncMock(return_value=[first, second])
    release_sibling = asyncio.Event()
    sibling_started = asyncio.Event()

    async def process(job):
        if job is first:
            raise ConnectionError("database acknowledgement failed")
        sibling_started.set()
        await release_sibling.wait()

    worker.process = process
    batch = asyncio.create_task(worker.sync_once())
    await sibling_started.wait()
    await asyncio.sleep(0)
    assert not batch.done()
    release_sibling.set()
    with pytest.raises(ConnectionError):
        await batch
