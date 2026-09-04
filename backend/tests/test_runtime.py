from __future__ import annotations

import asyncio
import json
import logging
from contextlib import asynccontextmanager
from types import SimpleNamespace

import pytest
from fastapi import FastAPI

from app import main
from app.observability import JsonFormatter
from app.worker import WorkerHealth


class FakeDatabase:
    available = True
    opened = False
    closed = False

    async def open(self):
        self.opened = True

    async def close(self):
        self.closed = True

    async def execute(self, _query):
        if not self.available:
            raise OSError("database password must not reach health output")

    @asynccontextmanager
    async def transaction(self):
        yield self


@pytest.mark.asyncio
async def test_api_lifespan_only_starts_services_and_database(monkeypatch):
    database = FakeDatabase()
    settings = SimpleNamespace()
    monkeypatch.setattr(main, "get_settings", lambda: settings)
    monkeypatch.setattr(main, "Database", lambda _: database)
    for factory in ("ProvisioningService", "FirmwareService", "LocationService", "AdminService"):
        monkeypatch.setattr(main, factory, lambda _: object())

    class Billing:
        async def bootstrap_catalog(self, db):
            assert db is database

    monkeypatch.setattr(main, "BillingService", lambda _: Billing())
    app = FastAPI()
    async with main.lifespan(app):
        assert database.opened
        assert not database.closed
        assert not hasattr(app.state, "findmy_auth")
        assert not hasattr(app.state, "location_sync_worker")
        assert not hasattr(app.state, "notification_worker")
        assert not hasattr(app.state, "premium_retention_worker")
    assert database.closed


@pytest.mark.asyncio
async def test_worker_readiness_covers_database_task_failure_and_shutdown():
    database = FakeDatabase()
    stop = asyncio.Event()
    health = WorkerHealth(database, stop)
    work = asyncio.create_task(stop.wait())
    health.tasks = [work]
    assert await health.status("/ready") == (200, {"status": "ok"})
    database.available = False
    assert await health.status("/ready") == (503, {"status": "unavailable"})
    assert await health.status("/health") == (200, {"status": "ok"})
    work.cancel()
    await asyncio.gather(work, return_exceptions=True)
    assert await health.status("/health") == (503, {"status": "unavailable"})
    stop.set()
    assert await health.status("/ready") == (503, {"status": "unavailable"})


@pytest.mark.asyncio
async def test_worker_health_http_response_is_bounded_safe_json():
    stop = asyncio.Event()
    health = WorkerHealth(FakeDatabase(), stop)
    task = asyncio.create_task(stop.wait())
    health.tasks = [task]
    server = await asyncio.start_server(health.handle, "127.0.0.1", 0, limit=4096)
    try:
        port = server.sockets[0].getsockname()[1]
        reader, writer = await asyncio.open_connection("127.0.0.1", port)
        writer.write(b"GET /ready HTTP/1.1\r\nHost: localhost\r\n\r\n")
        await writer.drain()
        response = await asyncio.wait_for(reader.read(), timeout=2)
        assert response.startswith(b"HTTP/1.1 200")
        assert json.loads(response.split(b"\r\n\r\n", 1)[1]) == {"status": "ok"}
        writer.close()
        await writer.wait_closed()
    finally:
        server.close()
        await server.wait_closed()
        stop.set()
        await task


def test_json_logging_does_not_serialize_arbitrary_record_fields():
    record = logging.LogRecord("pinqeva.test", logging.INFO, "", 0, "refresh_finished count=%s", (2,), None)
    record.token = "must-not-be-serialized"
    payload = json.loads(JsonFormatter().format(record))
    assert payload["event"] == "refresh_finished count=2"
    assert "must-not-be-serialized" not in json.dumps(payload)
