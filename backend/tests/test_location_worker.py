from __future__ import annotations

from contextlib import asynccontextmanager
from datetime import UTC, datetime
from typing import AsyncIterator
from uuid import UUID, uuid4

import pytest

from app.location import LocationError
from app.location_worker import LocationSyncJob, LocationSyncWorker
from app.models import DeviceLocationReportResponse


class _Cursor:
    def __init__(self, rows: list[dict] | None = None) -> None:
        self.rows = rows or []

    async def fetchall(self) -> list[dict]:
        return self.rows


class _Connection:
    def __init__(self, claimed_rows: list[dict] | None = None) -> None:
        self.claimed_rows = claimed_rows or []
        self.executed: list[tuple[str, tuple[object, ...]]] = []

    async def execute(
        self, query: str, parameters: tuple[object, ...] = ()
    ) -> _Cursor:
        self.executed.append((query, parameters))
        if "WITH due AS" in query:
            rows = self.claimed_rows
            self.claimed_rows = []
            return _Cursor(rows)
        return _Cursor()


class _Database:
    def __init__(self, connection: _Connection) -> None:
        self.connection = connection

    @asynccontextmanager
    async def transaction(self) -> AsyncIterator[_Connection]:
        yield self.connection


class _SuccessfulLocation:
    def __init__(self, reported_at: datetime) -> None:
        self.reported_at = reported_at
        self.calls: list[tuple[UUID, UUID]] = []

    async def request_report(
        self, _database: object, *, user_id: UUID, device_id: UUID
    ) -> DeviceLocationReportResponse:
        self.calls.append((user_id, device_id))
        return DeviceLocationReportResponse(
            device_id=device_id,
            serial_number="PKV-AABBCCDDEEFF",
            report_status="updated",
            latitude=38.72,
            longitude=-9.14,
            last_location_at=self.reported_at,
            last_place="38.72000, -9.14000",
            confidence=3,
            status_code=1,
        )


def _job_row() -> dict:
    return {
        "device_id": uuid4(),
        "user_id": uuid4(),
        "provisioning_session_id": uuid4(),
        "consecutive_failures": 0,
    }


@pytest.mark.asyncio
async def test_worker_collects_only_account_entitled_claimed_bindings() -> None:
    row = _job_row()
    connection = _Connection([row])
    database = _Database(connection)
    reported_at = datetime(2026, 8, 29, 12, 0, tzinfo=UTC)
    location = _SuccessfulLocation(reported_at)
    worker = LocationSyncWorker(
        database,  # type: ignore[arg-type]
        location,  # type: ignore[arg-type]
        enabled_networks=frozenset({"apple"}),
        interval_seconds=900,
    )

    processed = await worker.sync_once()

    assert processed == 1
    assert location.calls == [(row["user_id"], row["device_id"])]
    reconciliation_sql = "\n".join(query for query, _ in connection.executed[:2])
    assert "pinqeva_active_subscription_id" in reconciliation_sql
    assert "session.status = 'claimed'" in reconciliation_sql
    assert "subscription.device_id" not in reconciliation_sql
    success_query, success_parameters = connection.executed[-1]
    assert "last_success_at = now()" in success_query
    assert success_parameters[0] == 900
    assert success_parameters[1:4] == (reported_at, reported_at, reported_at)


@pytest.mark.asyncio
async def test_worker_drops_lease_when_account_subscription_has_ended() -> None:
    row = _job_row()
    job = LocationSyncJob(**row)
    connection = _Connection()
    database = _Database(connection)

    class _ExpiredLocation:
        async def request_report(self, *_args: object, **_kwargs: object) -> None:
            raise LocationError(
                "PREMIUM_SUBSCRIPTION_REQUIRED",
                "subscription ended",
                402,
            )

    worker = LocationSyncWorker(
        database,  # type: ignore[arg-type]
        _ExpiredLocation(),  # type: ignore[arg-type]
        enabled_networks=frozenset({"apple"}),
    )
    await worker.process(job)

    assert len(connection.executed) == 1
    query, parameters = connection.executed[0]
    assert query.lstrip().startswith(
        "DELETE FROM public.device_location_sync_state"
    )
    assert parameters[:3] == (
        job.device_id,
        job.user_id,
        job.provisioning_session_id,
    )


@pytest.mark.asyncio
async def test_worker_retries_temporary_provider_failure_without_error_details() -> None:
    row = _job_row()
    job = LocationSyncJob(**row)
    connection = _Connection()
    database = _Database(connection)

    class _UnavailableLocation:
        async def request_report(self, *_args: object, **_kwargs: object) -> None:
            raise LocationError("LOCATION_UNAVAILABLE", "private detail", 503)

    worker = LocationSyncWorker(
        database,  # type: ignore[arg-type]
        _UnavailableLocation(),  # type: ignore[arg-type]
        enabled_networks=frozenset({"apple"}),
        interval_seconds=900,
    )
    await worker.process(job)

    query, parameters = connection.executed[0]
    assert "consecutive_failures = %s" in query
    assert parameters[:3] == (30, 1, "LOCATION_UNAVAILABLE")
    assert "private detail" not in repr(connection.executed)
