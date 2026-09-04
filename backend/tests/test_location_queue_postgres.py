"""Real PostgreSQL concurrency tests; providers are always local fakes.

The reused fixture creates a disposable database and applies every original and
backend migration. It skips only when local PostgreSQL executables are absent.
"""
from __future__ import annotations

import asyncio
import os
from contextlib import asynccontextmanager
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import psycopg
import pytest

from app.crypto import encrypt_private_key, generate_finder_key_bundle
from app.database import Database
from app.findmy import FinderReport
from app.location import LocationError, LocationService, _SourcedReport
from app.location_queue import LocationQueue
from app.location_worker import LocationSyncWorker
from test_billing_postgres_integration import _settings, migrated_postgres_url


def _run(coro):
    if os.name == "nt":
        with asyncio.Runner(loop_factory=asyncio.SelectorEventLoop) as runner:
            return runner.run(coro)
    return asyncio.run(coro)


@pytest.fixture(autouse=True)
def empty_location_database(migrated_postgres_url):
    with psycopg.connect(migrated_postgres_url, autocommit=True) as connection:
        connection.execute("TRUNCATE auth.users, public.device CASCADE")
        connection.execute("TRUNCATE public.backend_schedule, public.location_rate_limit")


@asynccontextmanager
async def _databases(url, **changes):
    settings = replace(_settings(url), findmy_dsid="123", findmy_search_party_token="fake",
                       **changes)
    first, second = Database(settings), Database(settings)
    await first.open()
    await second.open()
    try:
        yield settings, first, second
    finally:
        await first.close()
        await second.close()


async def _seed(database, settings, *, premium=False, user_id=None):
    user_id, device_id, session_id = user_id or uuid4(), uuid4(), uuid4()
    serial = f"PKV-{device_id.hex[:12].upper()}"
    bundle = generate_finder_key_bundle()
    encrypted = encrypt_private_key(bundle.private_key, settings.key_encryption_key,
                                   f"pinqeva:v1:{session_id}:{user_id}:{device_id}".encode("ascii"))
    async with database.transaction() as connection:
        await connection.execute("INSERT INTO auth.users (id) VALUES (%s) ON CONFLICT DO NOTHING", (user_id,))
        await connection.execute("INSERT INTO public.device (id,serial_number,status) VALUES (%s,%s,'claimed')", (device_id, serial))
        await connection.execute(
            """
            INSERT INTO public.provisioning_session (
              id, user_id, device_id, serial_number, idempotency_key, protocol_version,
              private_key_ciphertext, private_key_nonce, private_key_envelope_version,
              public_key, advertisement_key, advertisement_key_sha256,
              status, expires_at, claim_deadline, completed_at
            ) VALUES (%s,%s,%s,%s,%s,1,%s,%s,1,%s,%s,%s,
                      'claimed',now()+interval '1 day',now()+interval '1 day',now())
            """, (session_id, user_id, device_id, serial, str(session_id), encrypted.ciphertext,
                    encrypted.nonce, bundle.public_key, bundle.advertisement_key, bundle.advertisement_key_sha256),
        )
        await connection.execute("UPDATE public.device SET provisioning_session_id=%s,finding_network='apple' WHERE id=%s", (session_id, device_id))
        await connection.execute("INSERT INTO public.ownership (user_id,device_id) VALUES (%s,%s)", (user_id, device_id))
        if premium:
            await connection.execute(
                "INSERT INTO public.plan (code,name,duration_months,price_cents) VALUES ('location-test','Test',1,299) ON CONFLICT DO NOTHING"
            )
            await connection.execute(
                """INSERT INTO public.subscription (user_id,plan_code,status,starts_at,current_period_end)
                   SELECT %s,'location-test','active',now()-interval '1 day',now()+interval '1 day'
                    WHERE NOT EXISTS (SELECT 1 FROM public.subscription WHERE user_id=%s)""", (user_id, user_id),
            )
    return dict(user_id=user_id, device_id=device_id, session_id=session_id)


async def _sql(database, sql, params=()):
    async with database.transaction() as connection:
        cursor = await connection.execute(sql, params)
        return await cursor.fetchall() if cursor.description else []


def _provider(monkeypatch, *, fails=False):
    calls = []
    device_time = datetime.now(UTC) - timedelta(minutes=20)

    async def fetch(self, binding, **kwargs):
        calls.append(binding.device_id)
        await asyncio.sleep(0.03)
        if fails:
            raise LocationError("LOCATION_UNAVAILABLE", "sensitive upstream detail", 503)
        return [_SourcedReport(binding.providers[0], FinderReport(38.72, -9.14, 3, 1, device_time))]

    monkeypatch.setattr(LocationService, "_fetch_provider_reports", fetch)
    return calls, device_time


def _worker(database, settings, service=None, **kwargs):
    return LocationSyncWorker(database, service or LocationService(settings), settings=settings,
                              enabled_networks=frozenset({"apple"}), **kwargs)


def test_scheduler_includes_free_and_premium_and_staggers_due_times(migrated_postgres_url):
    async def scenario():
        async with _databases(migrated_postgres_url) as (settings, first, second):
            for index in range(8):
                await _seed(first, settings, premium=index % 2 == 0)
            workers = [_worker(first, settings), _worker(second, settings)]
            await asyncio.gather(*(worker.reconcile_once() for worker in workers))
            rows = await _sql(first, "SELECT next_attempt_at,created_at FROM public.device_location_sync_state")
            assert len(rows) == 8
            assert len({row['next_attempt_at'] for row in rows}) > 1
            assert all(0 <= (row['next_attempt_at'] - row['created_at']).total_seconds() < 900 for row in rows)
            assert len(await _sql(first, "SELECT * FROM public.backend_schedule")) == 1
    _run(scenario())


def test_two_api_instances_coalesce_and_worker_persists_independent_timestamps(migrated_postgres_url, monkeypatch):
    calls, device_time = _provider(monkeypatch)

    async def scenario():
        async with _databases(migrated_postgres_url) as (settings, first, second):
            binding = await _seed(first, settings, premium=True)
            service = LocationService(settings)
            stop = asyncio.Event()
            worker = _worker(first, settings, service, idle_seconds=0.02)
            task = asyncio.create_task(worker.run(stop))
            try:
                results = await asyncio.gather(*(
                    service.request_report(first if index % 2 else second,
                                           user_id=binding['user_id'], device_id=binding['device_id'])
                    for index in range(8)
                ))
            finally:
                stop.set()
                await task
            assert calls == [binding['device_id']]
            assert all(result.latitude == 38.72 for result in results)
            assert all(result.last_location_at == device_time for result in results)
            assert all(result.server_fetched_at > result.last_location_at for result in results)
            assert all(result.age_seconds >= 1200 for result in results)
            assert len(await _sql(first, "SELECT * FROM public.device_location_report")) == 1
            # A second premium API process reads the fresh fetch without upstream work.
            recent = await service.request_report(second, user_id=binding['user_id'], device_id=binding['device_id'])
            assert recent.source == "cache"
            assert calls == [binding['device_id']]
    _run(scenario())


def test_free_cached_read_never_enqueues_and_scheduled_worker_updates_it(migrated_postgres_url, monkeypatch):
    calls, device_time = _provider(monkeypatch)

    async def scenario():
        async with _databases(migrated_postgres_url) as (settings, first, second):
            binding = await _seed(first, settings)
            service = LocationService(settings)
            initial = await service.request_report(second, user_id=binding['user_id'], device_id=binding['device_id'])
            assert initial.source == "cache" and initial.latitude is None
            assert calls == []
            assert not await LocationQueue(first, settings).request_refresh(**binding)
            assert not await _sql(first, "SELECT * FROM public.device_location_sync_state")
            worker = _worker(first, settings, service)
            await worker.reconcile_once()
            await _sql(first, "UPDATE public.device_location_sync_state SET next_attempt_at=now()")
            first_jobs, second_jobs = await asyncio.gather(worker.claim_due(), _worker(second, settings).claim_due())
            assert len(first_jobs) + len(second_jobs) == 1
            await worker.process((first_jobs + second_jobs)[0])
            cached = await service.request_report(second, user_id=binding['user_id'], device_id=binding['device_id'])
            assert cached.latitude == 38.72 and cached.last_location_at == device_time
            assert len(calls) == 1
            # A duplicate scheduled delivery is fenced after the first ack.
            await worker.process((first_jobs + second_jobs)[0])
            assert len(calls) == 1
            # Free accounts retain the latest projection; history stays premium.
            assert not await _sql(first, "SELECT * FROM public.device_location_report")
            projection = (await _sql(first, "SELECT last_latitude,last_location_at,last_location_fetched_at FROM public.device WHERE id=%s", (binding['device_id'],)))[0]
            assert projection['last_latitude'] == 38.72
            assert projection['last_location_at'] == device_time
            assert projection['last_location_fetched_at'] > device_time
    _run(scenario())


def test_failed_refresh_returns_cached_value_and_preserves_backoff(migrated_postgres_url, monkeypatch):
    calls, _ = _provider(monkeypatch, fails=True)

    async def scenario():
        async with _databases(migrated_postgres_url) as (settings, first, second):
            binding = await _seed(first, settings, premium=True)
            await _sql(first, """UPDATE public.device SET last_latitude=1,last_longitude=2,
                       last_location_at=now()-interval '1 hour',last_location_fetched_at=now()-interval '1 hour'
                       WHERE id=%s""", (binding['device_id'],))
            queue = LocationQueue(first, settings)
            assert await queue.request_refresh(**binding)
            worker = _worker(second, settings)
            await worker.process((await worker.claim_due())[0])
            result = await LocationService(settings).request_report(first, user_id=binding['user_id'], device_id=binding['device_id'])
            assert result.latitude == 1 and result.stale and result.upstream_refresh_failed
            assert result.source == "cache"
            before = await queue.snapshot(**binding)
            assert not await LocationQueue(second, settings).request_refresh(**binding)
            after = await queue.snapshot(**binding)
            assert before['next_attempt_at'] == after['next_attempt_at']
            assert len(calls) == 1
    _run(scenario())


def test_priority_claim_and_cross_instance_user_account_budgets(migrated_postgres_url):
    async def scenario():
        async with _databases(migrated_postgres_url, location_premium_user_limit_per_minute=2,
                              location_account_limit_per_minute=1) as (settings, first, second):
            user = uuid4()
            bindings = [await _seed(first, settings, premium=True, user_id=user) for _ in range(6)]
            worker = _worker(first, settings, batch_size=1)
            await worker.reconcile_once()
            await _sql(first, "UPDATE public.device_location_sync_state SET next_attempt_at=now()-interval '1 hour'")
            queues = [LocationQueue(first, settings), LocationQueue(second, settings)]
            admitted = await asyncio.gather(*(queues[index % 2].request_refresh(**binding) for index, binding in enumerate(bindings)))
            assert sum(admitted) == 2
            claimed = (await worker.claim_due())[0]
            assert claimed.device_id in {binding['device_id'] for index, binding in enumerate(bindings) if admitted[index]}
            assert await worker._reserve_upstream_budget(claimed)
            other = (await _worker(second, settings, batch_size=1).claim_due())[0]
            assert not await worker._reserve_upstream_budget(other)
            rows = await _sql(first, "SELECT lease_owner,attempt_count FROM public.device_location_sync_state WHERE device_id=%s", (other.device_id,))
            assert rows[0]['lease_owner'] is None and rows[0]['attempt_count'] == 0
    _run(scenario())


def test_expired_lease_recovered_and_old_token_cannot_write(migrated_postgres_url, monkeypatch):
    calls, _ = _provider(monkeypatch)

    async def scenario():
        async with _databases(migrated_postgres_url) as (settings, first, second):
            binding = await _seed(first, settings, premium=True)
            await LocationQueue(first, settings).request_refresh(**binding)
            worker = _worker(first, settings)
            original = (await worker.claim_due())[0]
            assert not await _worker(second, settings).claim_due()
            await _sql(first, "UPDATE public.device_location_sync_state SET lease_expires_at=now()-interval '1 second'")
            replacement = (await _worker(second, settings).claim_due())[0]
            assert replacement.lease_owner != original.lease_owner
            with pytest.raises(LocationError):
                await LocationService(settings).refresh_report(first, **binding, lease_owner=original.lease_owner)
            assert not await _sql(first, "SELECT * FROM public.device_location_report")
            await worker.process(replacement)
            assert len(await _sql(first, "SELECT * FROM public.device_location_report")) == 1
    _run(scenario())


def test_crash_after_ingestion_reclaims_ack_without_second_fetch(migrated_postgres_url, monkeypatch):
    calls, _ = _provider(monkeypatch)

    async def scenario():
        async with _databases(migrated_postgres_url) as (settings, first, second):
            binding = await _seed(first, settings, premium=True)
            await LocationQueue(first, settings).request_refresh(**binding)
            worker = _worker(first, settings)
            original = (await worker.claim_due())[0]
            await LocationService(settings).refresh_report(first, **binding, lease_owner=original.lease_owner)
            fetched = (await _sql(first, "SELECT last_success_at FROM public.device_location_sync_state"))[0]['last_success_at']
            await _sql(first, "UPDATE public.device_location_sync_state SET lease_expires_at=now()-interval '1 second'")
            replacement = (await _worker(second, settings).claim_due())[0]
            assert replacement.already_completed
            await worker.process(replacement)
            assert len(calls) == 1
            state = (await _sql(first, "SELECT last_success_at,lease_owner FROM public.device_location_sync_state"))[0]
            assert state['last_success_at'] == fetched and state['lease_owner'] is None
    _run(scenario())


def test_exhausted_retries_are_durable_and_cannot_be_accelerated(migrated_postgres_url, monkeypatch):
    calls, _ = _provider(monkeypatch, fails=True)

    async def scenario():
        async with _databases(migrated_postgres_url, location_max_attempts=2) as (settings, first, second):
            binding = await _seed(first, settings, premium=True)
            queue, worker = LocationQueue(first, settings), _worker(second, settings)
            assert await queue.request_refresh(**binding)
            await worker.process((await worker.claim_due())[0])
            assert not await queue.request_refresh(**binding)
            await _sql(first, "UPDATE public.device_location_sync_state SET next_attempt_at=now()")
            await worker.process((await worker.claim_due())[0])
            failures = await _sql(first, "SELECT * FROM public.location_refresh_failure")
            assert len(failures) == 1 and failures[0]['attempt_count'] == 2
            assert failures[0]['error_code'] == 'LOCATION_UNAVAILABLE'
            assert not await queue.request_refresh(**binding)
            assert len(calls) == 2
            state = await queue.snapshot(**binding)
            assert state['failed_at'] is not None and state['priority'] == 0
    _run(scenario())


def test_google_only_worker_does_not_claim_legacy_apple_device(migrated_postgres_url):
    async def scenario():
        async with _databases(migrated_postgres_url) as (settings, first, second):
            binding = await _seed(first, settings, premium=True)
            await LocationQueue(first, settings).request_refresh(**binding)
            google = LocationSyncWorker(second, LocationService(settings), settings=settings,
                                        enabled_networks=frozenset({'google'}))
            assert not await google.claim_due()
            assert len(await _worker(first, settings).claim_due()) == 1
    _run(scenario())


def test_failure_archive_obeys_device_then_queue_lock_order(migrated_postgres_url):
    async def scenario():
        async with _databases(migrated_postgres_url, location_max_attempts=1) as (settings, first, second):
            binding = await _seed(first, settings, premium=True)
            await LocationQueue(first, settings).request_refresh(**binding)
            worker = _worker(second, settings)
            job = (await worker.claim_due())[0]
            async with first.transaction() as connection:
                await connection.execute("SELECT id FROM public.device WHERE id=%s FOR UPDATE", (job.device_id,))
                finishing = asyncio.create_task(worker._finish_failure(job, "LOCATION_UNAVAILABLE"))
                await asyncio.sleep(0.05)
                assert not finishing.done()
                # An enqueue/transfer already holding the device can still take
                # its queue lock: failure persistence has not inverted the order.
                await asyncio.wait_for(connection.execute(
                    "SELECT device_id FROM public.device_location_sync_state WHERE device_id=%s FOR UPDATE",
                    (job.device_id,),
                ), timeout=1)
            await asyncio.wait_for(finishing, timeout=2)
            assert len(await _sql(first, "SELECT * FROM public.location_refresh_failure")) == 1
    _run(scenario())


def test_account_budget_reservation_renews_nearly_expired_claim(migrated_postgres_url):
    async def scenario():
        async with _databases(migrated_postgres_url) as (settings, first, second):
            binding = await _seed(first, settings, premium=True)
            await LocationQueue(first, settings).request_refresh(**binding)
            worker = _worker(second, settings)
            job = (await worker.claim_due())[0]
            await _sql(first, "UPDATE public.device_location_sync_state SET lease_expires_at=now()+interval '1 second'")
            assert await worker._reserve_upstream_budget(job)
            row = (await _sql(first, "SELECT extract(epoch FROM lease_expires_at-clock_timestamp()) AS remaining FROM public.device_location_sync_state"))[0]
            assert row['remaining'] > settings.location_job_timeout_seconds + 10
    _run(scenario())
