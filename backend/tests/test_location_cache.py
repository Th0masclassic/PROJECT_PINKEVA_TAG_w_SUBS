from __future__ import annotations

import asyncio
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest

from app.location import LocationError, LocationService
from test_location import _settings


class SharedStore:
    def __init__(self, *, premium=True, fetched_seconds=120, device_seconds=120):
        now = datetime.now(UTC)
        self.row = {
            "device_id": uuid4(), "serial_number": "PKV-AABBCCDDEEFF",
            "session_id": uuid4(), "subscription_active": premium,
            "last_latitude": 38.72, "last_longitude": -9.14,
            "last_place": "38.72, -9.14",
            "last_location_at": now - timedelta(seconds=device_seconds),
            "last_location_fetched_at": now - timedelta(seconds=fetched_seconds),
        }
        self.requests = 0
        self.upstream_calls = 0
        self.refreshing = False
        self.error = None
        self.fail = False
        self.hang = False
        self.denied = False
        self.reads = 0
        self.revoke_on_wait = False
        self.tasks = []

    async def request_refresh(self, **_kwargs):
        self.requests += 1
        if self.denied:
            return False
        if not self.refreshing:
            self.refreshing = True
            if not self.hang:
                self.tasks.append(asyncio.create_task(self.consume()))
        return True

    async def consume(self):
        self.upstream_calls += 1
        await asyncio.sleep(0.01)
        if self.fail:
            self.error = "PROVIDER_UNAVAILABLE"
        else:
            self.row["last_location_fetched_at"] = datetime.now(UTC)
        self.refreshing = False

    async def snapshot(self, **_kwargs):
        return {"refreshing": self.refreshing, "last_error_code": self.error}


def install(monkeypatch, store):
    import app.location_queue
    monkeypatch.setattr(app.location_queue, "LocationQueue", lambda *_args: store)

    async def read_cache(_self, _database, **_kwargs):
        store.reads += 1
        if store.revoke_on_wait and store.reads > 1:
            raise LocationError("LOCATION_UNAVAILABLE", "Unavailable", 404)
        return dict(store.row)

    async def unexpected_provider(*_args, **_kwargs):
        raise AssertionError("API instances must never execute providers")

    monkeypatch.setattr(LocationService, "_read_cached_location", read_cache)
    monkeypatch.setattr(LocationService, "_fetch_provider_reports", unexpected_provider)


async def request(service, store):
    return await service.request_report(
        object(), user_id=uuid4(), device_id=store.row["device_id"]
    )


@pytest.mark.asyncio
async def test_free_request_returns_cache_without_publishing_or_contacting_provider(monkeypatch):
    store = SharedStore(premium=False, fetched_seconds=10000)
    install(monkeypatch, store)
    result = await request(LocationService(_settings()), store)
    assert result.latitude == 38.72
    assert result.source == "cache" and result.stale
    assert store.requests == store.upstream_calls == 0


@pytest.mark.asyncio
async def test_recent_premium_cache_avoids_refresh(monkeypatch):
    store = SharedStore(fetched_seconds=10, device_seconds=10)
    install(monkeypatch, store)
    result = await request(LocationService(_settings()), store)
    assert result.source == "cache" and not result.stale
    assert store.requests == 0


@pytest.mark.asyncio
async def test_premium_stale_refresh_publishes_waits_and_returns_result(monkeypatch):
    store = SharedStore()
    install(monkeypatch, store)
    result = await request(LocationService(_settings()), store)
    assert result.source == "refresh"
    assert result.server_fetched_at == store.row["last_location_fetched_at"]
    assert store.upstream_calls == 1


@pytest.mark.asyncio
async def test_two_api_instances_share_one_refresh_for_five_simultaneous_requests(monkeypatch):
    store = SharedStore()
    install(monkeypatch, store)
    instances = [LocationService(_settings()), LocationService(_settings())]
    results = await asyncio.gather(*[
        request(instances[index % 2], store) for index in range(5)
    ])
    assert store.requests == 5 and store.upstream_calls == 1
    assert all(result.source == "refresh" for result in results)
    assert len({result.server_fetched_at for result in results}) == 1


@pytest.mark.asyncio
async def test_failed_refresh_returns_stale_last_known_location(monkeypatch):
    store = SharedStore()
    store.fail = True
    install(monkeypatch, store)
    result = await request(LocationService(_settings()), store)
    assert result.source == "cache" and result.stale
    assert result.upstream_refresh_failed and not result.refreshing
    assert result.latitude == 38.72


@pytest.mark.asyncio
async def test_timeout_returns_cache_and_does_not_cancel_durable_work(monkeypatch):
    store = SharedStore()
    store.hang = True
    install(monkeypatch, store)
    result = await request(LocationService(replace(_settings(), location_refresh_wait_seconds=0)), store)
    assert result.source == "cache" and result.refreshing and result.stale
    assert not result.upstream_refresh_failed


@pytest.mark.asyncio
async def test_rate_limit_denial_returns_cache(monkeypatch):
    store = SharedStore()
    store.denied = True
    install(monkeypatch, store)
    result = await request(LocationService(_settings()), store)
    assert result.source == "cache" and not result.refreshing
    assert store.upstream_calls == 0


@pytest.mark.asyncio
async def test_recent_fetch_does_not_make_old_device_location_recent(monkeypatch):
    store = SharedStore(fetched_seconds=5, device_seconds=1200)
    install(monkeypatch, store)
    result = await request(LocationService(_settings()), store)
    assert result.stale
    assert result.age_seconds >= 1200 and result.fetch_age_seconds < 10
    assert store.requests == 0


@pytest.mark.asyncio
async def test_ownership_rechecked_while_waiting(monkeypatch):
    store = SharedStore()
    store.revoke_on_wait = store.hang = True
    install(monkeypatch, store)
    with pytest.raises(LocationError) as error:
        await request(LocationService(_settings()), store)
    assert error.value.status_code == 404


@pytest.mark.asyncio
async def test_missing_location_returns_explicit_null_cache_for_free_owner(monkeypatch):
    store = SharedStore(premium=False)
    store.row.update(last_location_at=None, last_latitude=None, last_longitude=None,
                     last_location_fetched_at=None, last_place=None)
    install(monkeypatch, store)
    result = await request(LocationService(_settings()), store)
    assert result.report_status == "no_report"
    assert result.latitude is result.age_seconds is result.server_fetched_at is None
    assert store.requests == 0


@pytest.mark.asyncio
async def test_history_denies_free_account_before_refresh(monkeypatch):
    store = SharedStore(premium=False)
    install(monkeypatch, store)
    with pytest.raises(LocationError) as error:
        await LocationService(_settings()).request_report_history(
            object(), user_id=uuid4(), device_id=store.row["device_id"], days=30
        )
    assert error.value.code == "PREMIUM_SUBSCRIPTION_REQUIRED"
    assert store.requests == 0
