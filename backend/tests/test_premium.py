from __future__ import annotations

import hashlib
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from typing import AsyncIterator
from uuid import UUID, uuid4

import pytest

from app.crypto import b64url_decode_exact
from app.models import (
    DeviceProtectionProfileUpdate,
    DeviceRecoveryShareCreate,
    DeviceSafeZoneCreate,
    DeviceSafeZoneUpdate,
)
from app.premium import PremiumError, PremiumRetentionWorker, PremiumService


class _Cursor:
    def __init__(
        self, row: dict | None = None, rows: list[dict] | None = None
    ) -> None:
        self.row = row
        self.rows = rows if rows is not None else ([] if row is None else [row])

    async def fetchone(self) -> dict | None:
        return self.row

    async def fetchall(self) -> list[dict]:
        return self.rows


class _Connection:
    def __init__(self, responses: list[_Cursor]) -> None:
        self.responses = list(responses)
        self.executed: list[tuple[str, tuple[object, ...]]] = []

    async def execute(
        self, query: str, parameters: tuple[object, ...] = ()
    ) -> _Cursor:
        self.executed.append((query, parameters))
        if not self.responses:
            raise AssertionError(f"Unexpected SQL: {query}")
        return self.responses.pop(0)


class _Database:
    def __init__(self, connection: _Connection) -> None:
        self.connection = connection

    @asynccontextmanager
    async def transaction(self) -> AsyncIterator[_Connection]:
        yield self.connection


def _device(
    *, device_id: UUID, subscription_id: UUID | None
) -> dict:
    return {
        "device_id": device_id,
        "serial_number": "PKV-AABBCCDDEEFF",
        "tracker_name": "Keys",
        "firmware_version": "0.3.0",
        "last_latitude": 38.72,
        "last_longitude": -9.14,
        "last_location_at": datetime.now(UTC),
        "active_subscription_id": subscription_id,
    }


@pytest.mark.asyncio
async def test_feature_access_is_cloud_side_and_does_not_suspend_the_tag() -> None:
    device_id = uuid4()
    connection = _Connection(
        [_Cursor(row=_device(device_id=device_id, subscription_id=None))]
    )

    result = await PremiumService().feature_access(
        _Database(connection), user_id=uuid4(), device_id=device_id
    )

    assert result.subscription_active is False
    assert result.tier == "none"
    assert result.cloud_location_reports is False
    assert result.location_history_days == 0
    assert result.safe_zones is False
    assert "device_entitlement_sync" not in connection.executed[0][0]


@pytest.mark.asyncio
async def test_safe_zone_requires_an_active_subscription() -> None:
    device_id = uuid4()
    connection = _Connection(
        [_Cursor(row=_device(device_id=device_id, subscription_id=None))]
    )

    with pytest.raises(PremiumError) as error:
        await PremiumService().create_safe_zone(
            _Database(connection),
            user_id=uuid4(),
            device_id=device_id,
            request=DeviceSafeZoneCreate(
                name="Home",
                latitude=38.72,
                longitude=-9.14,
                radius_meters=250,
            ),
        )

    assert error.value.code == "PREMIUM_SUBSCRIPTION_REQUIRED"
    assert error.value.status_code == 402
    assert len(connection.executed) == 1


@pytest.mark.asyncio
async def test_safe_zone_creation_returns_alert_configuration() -> None:
    device_id = uuid4()
    now = datetime.now(UTC)
    zone_id = uuid4()
    connection = _Connection(
        [
            _Cursor(row=_device(device_id=device_id, subscription_id=uuid4())),
            _Cursor(row={"zone_count": 0}),
            _Cursor(
                row={
                    "id": zone_id,
                    "device_id": device_id,
                    "name": "Home",
                    "latitude": 38.72,
                    "longitude": -9.14,
                    "radius_meters": 250,
                    "notify_on_enter": True,
                    "notify_on_exit": True,
                    "enabled": True,
                    "last_inside": None,
                    "last_evaluated_at": None,
                    "created_at": now,
                    "updated_at": now,
                }
            ),
        ]
    )

    result = await PremiumService().create_safe_zone(
        _Database(connection),
        user_id=uuid4(),
        device_id=device_id,
        request=DeviceSafeZoneCreate(
            name="  Home  ",
            latitude=38.72,
            longitude=-9.14,
            radius_meters=250,
        ),
    )

    assert result.id == zone_id
    assert result.name == "Home"
    assert result.notify_on_enter is True
    assert result.notify_on_exit is True
    assert "INSERT INTO public.device_safe_zone" in connection.executed[2][0]


@pytest.mark.asyncio
async def test_safe_zone_update_rejects_explicit_null_without_querying() -> None:
    connection = _Connection([])

    with pytest.raises(PremiumError) as error:
        await PremiumService().update_safe_zone(
            _Database(connection),
            user_id=uuid4(),
            device_id=uuid4(),
            safe_zone_id=uuid4(),
            request=DeviceSafeZoneUpdate(enabled=None),
        )

    assert error.value.code == "INVALID_PREMIUM_REQUEST"
    assert connection.executed == []


@pytest.mark.asyncio
async def test_recovery_share_returns_plaintext_once_and_stores_only_its_hash() -> None:
    device_id = uuid4()
    share_id = uuid4()
    now = datetime.now(UTC)
    user_id = uuid4()
    connection = _Connection(
        [
            _Cursor(row=_device(device_id=device_id, subscription_id=uuid4())),
            _Cursor(row={"share_count": 0}),
            _Cursor(
                row={
                    "id": share_id,
                    "device_id": device_id,
                    "label": "Partner",
                    "access_level": "history",
                    "expires_at": now + timedelta(hours=24),
                    "revoked_at": None,
                    "last_accessed_at": None,
                    "created_at": now,
                }
            ),
        ]
    )

    result = await PremiumService().create_recovery_share(
        _Database(connection),
        user_id=user_id,
        device_id=device_id,
        request=DeviceRecoveryShareCreate(
            label="Partner", access_level="history", expires_in_hours=24
        ),
    )

    token_bytes = b64url_decode_exact(result.share_token, 32)
    insert_parameters = connection.executed[2][1]
    assert insert_parameters[2] == hashlib.sha256(token_bytes).digest()
    assert result.share_token not in repr(connection.executed)
    assert result.share_path.endswith(result.share_token)


@pytest.mark.asyncio
async def test_enabling_lost_and_vehicle_modes_updates_one_cloud_profile() -> None:
    device_id = uuid4()
    user_id = uuid4()
    now = datetime.now(UTC)
    connection = _Connection(
        [
            _Cursor(row=_device(device_id=device_id, subscription_id=uuid4())),
            _Cursor(),
            _Cursor(
                row={
                    "device_id": device_id,
                    "lost_mode": False,
                    "lost_since": None,
                    "recovery_message": None,
                    "vehicle_mode": False,
                    "movement_alerts": False,
                    "movement_threshold_meters": 500,
                    "movement_anchor_latitude": None,
                    "movement_anchor_longitude": None,
                    "updated_at": now,
                }
            ),
            _Cursor(
                row={
                    "device_id": device_id,
                    "lost_mode": True,
                    "lost_since": now,
                    "recovery_message": "Call me",
                    "vehicle_mode": True,
                    "movement_alerts": True,
                    "movement_threshold_meters": 750,
                    "updated_at": now,
                }
            ),
        ]
    )

    result = await PremiumService().update_protection_profile(
        _Database(connection),
        user_id=user_id,
        device_id=device_id,
        request=DeviceProtectionProfileUpdate(
            lost_mode=True,
            recovery_message="Call me",
            vehicle_mode=True,
            movement_alerts=True,
            movement_threshold_meters=750,
        ),
    )

    assert result.lost_mode is True
    assert result.lost_since is not None
    assert result.vehicle_mode is True
    assert result.movement_alerts is True
    update_parameters = connection.executed[3][1]
    assert update_parameters[6:8] == (38.72, -9.14)


@pytest.mark.asyncio
async def test_protection_update_allows_clearing_only_the_message() -> None:
    device_id = uuid4()
    now = datetime.now(UTC)
    connection = _Connection(
        [
            _Cursor(row=_device(device_id=device_id, subscription_id=uuid4())),
            _Cursor(),
            _Cursor(
                row={
                    "device_id": device_id,
                    "lost_mode": True,
                    "lost_since": now,
                    "recovery_message": "Old message",
                    "vehicle_mode": False,
                    "movement_alerts": False,
                    "movement_threshold_meters": 500,
                    "movement_anchor_latitude": None,
                    "movement_anchor_longitude": None,
                    "updated_at": now,
                }
            ),
            _Cursor(
                row={
                    "device_id": device_id,
                    "lost_mode": True,
                    "lost_since": now,
                    "recovery_message": None,
                    "vehicle_mode": False,
                    "movement_alerts": False,
                    "movement_threshold_meters": 500,
                    "updated_at": now,
                }
            ),
        ]
    )

    result = await PremiumService().update_protection_profile(
        _Database(connection),
        user_id=uuid4(),
        device_id=device_id,
        request=DeviceProtectionProfileUpdate(recovery_message=None),
    )

    assert result.recovery_message is None


@pytest.mark.asyncio
async def test_protection_update_rejects_null_boolean_without_querying() -> None:
    connection = _Connection([])

    with pytest.raises(PremiumError) as error:
        await PremiumService().update_protection_profile(
            _Database(connection),
            user_id=uuid4(),
            device_id=uuid4(),
            request=DeviceProtectionProfileUpdate(lost_mode=None),
        )

    assert error.value.code == "INVALID_PREMIUM_REQUEST"
    assert connection.executed == []


@pytest.mark.asyncio
async def test_expired_or_malformed_recovery_token_has_one_safe_error() -> None:
    connection = _Connection([])
    with pytest.raises(PremiumError) as error:
        await PremiumService().shared_tracker(
            _Database(connection), token="not-a-recovery-token"
        )
    assert error.value.code == "RECOVERY_SHARE_NOT_FOUND"
    assert error.value.status_code == 404
    assert connection.executed == []


@pytest.mark.asyncio
async def test_retention_worker_deletes_reports_older_than_thirty_days() -> None:
    connection = _Connection([_Cursor(row={"deleted_count": 3})])

    deleted = await PremiumRetentionWorker(_Database(connection)).prune_once()

    assert deleted == 3
    assert "recorded_at < now() - interval '30 days'" in connection.executed[0][0]
