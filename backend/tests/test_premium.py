from __future__ import annotations

import hashlib
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from typing import AsyncIterator
from uuid import UUID, uuid4

import pytest

from app.crypto import b64url_decode_exact
from app.models import (
    DeviceCompanionObservationCreate,
    DeviceProtectionProfileUpdate,
    DeviceRecoveryShareCreate,
    DeviceReplacementClaimCreate,
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
    *,
    device_id: UUID,
    subscription_id: UUID | None,
    subscription_status: str | None = None,
    plan_months: int | None = None,
) -> dict:
    now = datetime.now(UTC)
    return {
        "device_id": device_id,
        "serial_number": "PKV-AABBCCDDEEFF",
        "tracker_name": "Keys",
        "firmware_version": "0.3.0",
        "last_latitude": 38.72,
        "last_longitude": -9.14,
        "last_location_at": now,
        "active_subscription_id": subscription_id,
        "active_subscription_status": (
            subscription_status or "active" if subscription_id else None
        ),
        "active_plan_code": "semiannual_plus" if subscription_id else None,
        "active_plan_months": plan_months or (6 if subscription_id else None),
        "active_period_start": now - timedelta(days=1) if subscription_id else None,
        "active_period_end": now + timedelta(days=180) if subscription_id else None,
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
                    "enabled": True,
                    "last_tracker_inside": None,
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
    assert result.last_tracker_inside is None
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
async def test_enabling_separation_and_vehicle_modes_updates_one_cloud_profile() -> None:
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
                    "separation_alerts": False,
                    "separation_threshold_meters": 500,
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
                    "separation_alerts": True,
                    "separation_threshold_meters": 750,
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
            separation_alerts=True,
            separation_threshold_meters=750,
            vehicle_mode=True,
            movement_alerts=True,
            movement_threshold_meters=750,
        ),
    )

    assert result.separation_alerts is True
    assert result.separation_threshold_meters == 750
    assert result.vehicle_mode is True
    assert result.movement_alerts is True
    update_parameters = connection.executed[3][1]
    assert update_parameters[5:7] == (38.72, -9.14)


@pytest.mark.asyncio
async def test_protection_update_rejects_null_boolean_without_querying() -> None:
    connection = _Connection([])

    with pytest.raises(PremiumError) as error:
        await PremiumService().update_protection_profile(
            _Database(connection),
            user_id=uuid4(),
            device_id=uuid4(),
            request=DeviceProtectionProfileUpdate(separation_alerts=None),
        )

    assert error.value.code == "INVALID_PREMIUM_REQUEST"
    assert connection.executed == []


@pytest.mark.asyncio
async def test_main_phone_observation_is_bound_and_stored_for_one_device() -> None:
    device_id = uuid4()
    installation_id = uuid4()
    now = datetime.now(UTC)
    connection = _Connection(
        [
            _Cursor(row=_device(device_id=device_id, subscription_id=uuid4())),
            _Cursor(row={"installation_id": installation_id}),
            _Cursor(row={"id": uuid4()}),
            _Cursor(
                row={
                    "installation_id": installation_id,
                    "platform": "ios",
                    "sampled_at": now,
                    "phone_accuracy_meters": 8.0,
                    "tag_proximity": "nearby",
                    "tag_observed_at": now,
                    "tag_rssi_dbm": -54,
                }
            ),
        ]
    )

    result = await PremiumService().report_companion_observation(
        _Database(connection),
        user_id=uuid4(),
        device_id=device_id,
        request=DeviceCompanionObservationCreate(
            installation_id=installation_id,
            platform="ios",
            phone_latitude=38.72,
            phone_longitude=-9.14,
            phone_accuracy_meters=8,
            sampled_at=now,
            tag_proximity="nearby",
            tag_observed_at=now,
            tag_rssi_dbm=-54,
        ),
    )

    assert result.configured is True
    assert result.observation_accepted is True
    assert result.tag_proximity == "nearby"
    assert "INSERT INTO public.device_primary_companion" in connection.executed[1][0]
    assert "INSERT INTO public.device_companion_observation" in connection.executed[2][0]


@pytest.mark.asyncio
async def test_different_phone_must_reset_the_main_device_first() -> None:
    device_id = uuid4()
    now = datetime.now(UTC)
    connection = _Connection(
        [
            _Cursor(row=_device(device_id=device_id, subscription_id=uuid4())),
            _Cursor(),
        ]
    )

    with pytest.raises(PremiumError) as error:
        await PremiumService().report_companion_observation(
            _Database(connection),
            user_id=uuid4(),
            device_id=device_id,
            request=DeviceCompanionObservationCreate(
                installation_id=uuid4(),
                platform="android",
                phone_latitude=38.72,
                phone_longitude=-9.14,
                phone_accuracy_meters=12,
                sampled_at=now,
            ),
        )

    assert error.value.code == "MAIN_DEVICE_MISMATCH"
    assert len(connection.executed) == 2


@pytest.mark.asyncio
async def test_expired_subscription_rejects_new_phone_observations() -> None:
    device_id = uuid4()
    connection = _Connection(
        [_Cursor(row=_device(device_id=device_id, subscription_id=None))]
    )

    with pytest.raises(PremiumError) as error:
        await PremiumService().report_companion_observation(
            _Database(connection),
            user_id=uuid4(),
            device_id=device_id,
            request=DeviceCompanionObservationCreate(
                installation_id=uuid4(),
                platform="ios",
                phone_latitude=38.72,
                phone_longitude=-9.14,
                phone_accuracy_meters=10,
                sampled_at=datetime.now(UTC),
            ),
        )

    assert error.value.code == "PREMIUM_SUBSCRIPTION_REQUIRED"
    assert len(connection.executed) == 1


@pytest.mark.asyncio
async def test_six_month_paid_plan_has_one_replacement_benefit_per_term() -> None:
    device_id = uuid4()
    subscription_id = uuid4()
    connection = _Connection(
        [
            _Cursor(
                row=_device(
                    device_id=device_id,
                    subscription_id=subscription_id,
                    plan_months=6,
                )
            ),
            _Cursor(),
        ]
    )

    result = await PremiumService().replacement_eligibility(
        _Database(connection), user_id=uuid4(), device_id=device_id
    )

    assert result.eligible is True
    assert result.reason == "eligible"
    assert result.current_plan_months == 6


@pytest.mark.asyncio
async def test_monthly_plan_has_no_free_replacement_benefit() -> None:
    device_id = uuid4()
    connection = _Connection(
        [
            _Cursor(
                row=_device(
                    device_id=device_id,
                    subscription_id=uuid4(),
                    plan_months=1,
                )
            )
        ]
    )

    result = await PremiumService().replacement_eligibility(
        _Database(connection), user_id=uuid4(), device_id=device_id
    )

    assert result.eligible is False
    assert result.reason == "plan_not_eligible"
    assert len(connection.executed) == 1


@pytest.mark.asyncio
async def test_replacement_claim_is_zero_price_and_requires_review() -> None:
    device_id = uuid4()
    subscription_id = uuid4()
    claim_id = uuid4()
    user_id = uuid4()
    now = datetime.now(UTC)
    device = _device(
        device_id=device_id,
        subscription_id=subscription_id,
        plan_months=12,
    )
    connection = _Connection(
        [
            _Cursor(row=device),
            _Cursor(),
            _Cursor(
                row={
                    "id": claim_id,
                    "device_id": device_id,
                    "subscription_id": subscription_id,
                    "reason": "stolen",
                    "incident_at": now,
                    "status": "submitted",
                    "notes": "Police report available",
                    "benefit_period_start": device["active_period_start"],
                    "benefit_period_end": device["active_period_end"],
                    "submitted_at": now,
                    "reviewed_at": None,
                    "fulfilled_at": None,
                }
            ),
        ]
    )

    result = await PremiumService().create_replacement_claim(
        _Database(connection),
        user_id=user_id,
        device_id=device_id,
        request=DeviceReplacementClaimCreate(
            reason="stolen",
            incident_at=now,
            notes="Police report available",
        ),
    )

    assert result.id == claim_id
    assert result.status == "submitted"
    assert result.replacement_price_minor == 0
    assert "ON CONFLICT (subscription_id, benefit_period_start)" in connection.executed[2][0]


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
    connection = _Connection(
        [
            _Cursor(
                row={
                    "deleted_location_count": 3,
                    "deleted_observation_count": 2,
                }
            )
        ]
    )

    deleted = await PremiumRetentionWorker(_Database(connection)).prune_once()

    assert deleted == 5
    assert "recorded_at < now() - interval '30 days'" in connection.executed[0][0]
    assert "sampled_at < now() - interval '24 hours'" in connection.executed[0][0]
