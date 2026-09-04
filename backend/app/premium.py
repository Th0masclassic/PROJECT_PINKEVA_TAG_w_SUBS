from __future__ import annotations

import asyncio
import hashlib
import logging
import secrets
from datetime import UTC, datetime, timedelta
from uuid import UUID

from fastapi import APIRouter, Request, Response, status
from psycopg import AsyncConnection

from .auth import AuthenticatedPrincipal
from .crypto import b64url_decode_exact, b64url_encode
from .database import Database
from .models import (
    DeviceCompanionObservationCreate,
    DeviceCompanionResetResponse,
    DeviceCompanionStatusResponse,
    DeviceLocationHistoryPoint,
    DeviceProtectionProfileResponse,
    DeviceProtectionProfileUpdate,
    DeviceRecoveryReportResponse,
    DeviceRecoveryShareCreate,
    DeviceRecoveryShareCreateResponse,
    DeviceRecoveryShareListResponse,
    DeviceRecoveryShareSummary,
    DeviceReplacementClaimCreate,
    DeviceReplacementClaimListResponse,
    DeviceReplacementClaimSummary,
    DeviceReplacementEligibilityResponse,
    DeviceSafeZoneCreate,
    DeviceSafeZoneListResponse,
    DeviceSafeZoneResponse,
    DeviceSafeZoneUpdate,
    LocationHistoryDeleteResponse,
    PremiumFeatureAccessResponse,
    PremiumTrackerOverviewResponse,
    RecoveryShareResolveRequest,
    SharedTrackerResponse,
)


logger = logging.getLogger("pinqeva.premium")


class PremiumError(RuntimeError):
    def __init__(self, code: str, status_code: int) -> None:
        super().__init__(code)
        self.code = code
        self.status_code = status_code


class PremiumService:
    async def _owned_device(
        self,
        connection: AsyncConnection,
        *,
        user_id: UUID,
        device_id: UUID,
        require_subscription: bool,
        lock: bool = False,
    ) -> dict:
        lock_clause = "FOR UPDATE OF device" if lock else ""
        query = await connection.execute(
            f"""
            SELECT device.id AS device_id, device.serial_number,
                   COALESCE(NULLIF(BTRIM(device.name), ''),
                            device.serial_number) AS tracker_name,
                   device.firmware_version, device.last_latitude,
                   device.last_longitude, device.last_location_at,
                   active_subscription.id AS active_subscription_id,
                   active_subscription.status AS active_subscription_status,
                   active_subscription.plan_code AS active_plan_code,
                   active_subscription.duration_months AS active_plan_months,
                   active_subscription.starts_at AS active_period_start,
                   active_subscription.current_period_end AS active_period_end
              FROM public.device device
              JOIN public.ownership ownership
                ON ownership.device_id = device.id
               AND ownership.user_id = %s
               AND ownership.ended_at IS NULL
         LEFT JOIN LATERAL (
                    SELECT subscription.id, subscription.status,
                           subscription.plan_code, subscription.starts_at,
                           subscription.current_period_end,
                           plan.duration_months
                      FROM public.subscription subscription
                      JOIN public.plan plan ON plan.code = subscription.plan_code
                     WHERE subscription.user_id = ownership.user_id
                       AND subscription.status IN ('active', 'trialing')
                       AND subscription.starts_at <= now()
                       AND subscription.current_period_end > now()
                     ORDER BY subscription.current_period_end DESC,
                              subscription.created_at DESC
                     LIMIT 1
                   ) active_subscription ON true
             WHERE device.id = %s
             {lock_clause}
            """,
            (user_id, device_id),
        )
        row = await query.fetchone()
        if row is None:
            raise PremiumError("TRACKER_NOT_FOUND", 404)
        if require_subscription and row["active_subscription_id"] is None:
            raise PremiumError("PREMIUM_SUBSCRIPTION_REQUIRED", 402)
        return dict(row)

    @staticmethod
    def _feature_response(device: dict) -> PremiumFeatureAccessResponse:
        active = device["active_subscription_id"] is not None
        replacement = (
            active
            and device.get("active_subscription_status") == "active"
            and int(device.get("active_plan_months") or 0) >= 6
        )
        return PremiumFeatureAccessResponse(
            device_id=device["device_id"],
            subscription_active=active,
            tier="premium" if active else "none",
            cloud_location_reports=active,
            location_history_days=30 if active else 0,
            smart_alerts=active,
            safe_zones=active,
            companion_separation_alerts=active,
            trusted_sharing=active,
            recovery_report=active,
            vehicle_mode=active,
            replacement_benefit=replacement,
        )

    async def feature_access(
        self, database: Database, *, user_id: UUID, device_id: UUID
    ) -> PremiumFeatureAccessResponse:
        async with database.transaction() as connection:
            device = await self._owned_device(
                connection,
                user_id=user_id,
                device_id=device_id,
                require_subscription=False,
            )
        return self._feature_response(device)

    @staticmethod
    def _safe_zone_response(row: dict) -> DeviceSafeZoneResponse:
        return DeviceSafeZoneResponse(
            id=row["id"],
            device_id=row["device_id"],
            name=row["name"],
            latitude=float(row["latitude"]),
            longitude=float(row["longitude"]),
            radius_meters=int(row["radius_meters"]),
            enabled=bool(row["enabled"]),
            last_tracker_inside=row.get("last_tracker_inside"),
            last_evaluated_at=row.get("last_evaluated_at"),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )

    async def create_safe_zone(
        self,
        database: Database,
        *,
        user_id: UUID,
        device_id: UUID,
        request: DeviceSafeZoneCreate,
    ) -> DeviceSafeZoneResponse:
        async with database.transaction() as connection:
            await self._owned_device(
                connection,
                user_id=user_id,
                device_id=device_id,
                require_subscription=True,
                lock=True,
            )
            count_query = await connection.execute(
                """
                SELECT count(*) AS zone_count
                  FROM public.device_safe_zone
                 WHERE user_id = %s AND device_id = %s
                """,
                (user_id, device_id),
            )
            count_row = await count_query.fetchone()
            if count_row is not None and int(count_row["zone_count"]) >= 20:
                raise PremiumError("SAFE_ZONE_LIMIT_REACHED", 409)
            query = await connection.execute(
                """
                INSERT INTO public.device_safe_zone (
                    user_id, device_id, name, latitude, longitude, radius_meters
                ) VALUES (%s, %s, %s, %s, %s, %s)
                RETURNING id, device_id, name, latitude, longitude,
                          radius_meters, enabled, last_tracker_inside,
                          last_evaluated_at,
                          created_at, updated_at
                """,
                (
                    user_id,
                    device_id,
                    request.name,
                    request.latitude,
                    request.longitude,
                    request.radius_meters,
                ),
            )
            row = await query.fetchone()
        if row is None:
            raise RuntimeError("Safe-zone insert returned no row")
        return self._safe_zone_response(dict(row))

    async def list_safe_zones(
        self, database: Database, *, user_id: UUID, device_id: UUID
    ) -> DeviceSafeZoneListResponse:
        async with database.transaction() as connection:
            await self._owned_device(
                connection,
                user_id=user_id,
                device_id=device_id,
                require_subscription=False,
            )
            query = await connection.execute(
                """
                SELECT id, device_id, name, latitude, longitude,
                       radius_meters, enabled, last_tracker_inside,
                       last_evaluated_at,
                       created_at, updated_at
                  FROM public.device_safe_zone
                 WHERE user_id = %s AND device_id = %s
                 ORDER BY created_at, id
                """,
                (user_id, device_id),
            )
            rows = await query.fetchall()
        return DeviceSafeZoneListResponse(
            safe_zones=[self._safe_zone_response(dict(row)) for row in rows]
        )

    async def update_safe_zone(
        self,
        database: Database,
        *,
        user_id: UUID,
        device_id: UUID,
        safe_zone_id: UUID,
        request: DeviceSafeZoneUpdate,
    ) -> DeviceSafeZoneResponse:
        fields = request.model_fields_set
        if not fields:
            raise PremiumError("INVALID_PREMIUM_REQUEST", 422)
        if any(getattr(request, field) is None for field in fields):
            raise PremiumError("INVALID_PREMIUM_REQUEST", 422)
        evaluation_reset = bool(
            {"latitude", "longitude", "radius_meters"}.intersection(fields)
        ) or "enabled" in fields
        async with database.transaction() as connection:
            await self._owned_device(
                connection,
                user_id=user_id,
                device_id=device_id,
                require_subscription=True,
            )
            query = await connection.execute(
                """
                UPDATE public.device_safe_zone
                   SET name = CASE WHEN %s THEN %s ELSE name END,
                       latitude = CASE WHEN %s THEN %s ELSE latitude END,
                       longitude = CASE WHEN %s THEN %s ELSE longitude END,
                       radius_meters = CASE WHEN %s THEN %s ELSE radius_meters END,
                       enabled = CASE WHEN %s THEN %s ELSE enabled END,
                       last_tracker_inside = CASE
                         WHEN %s THEN NULL ELSE last_tracker_inside END,
                       last_evaluated_at = CASE
                         WHEN %s THEN NULL ELSE last_evaluated_at END,
                       updated_at = now()
                 WHERE id = %s AND user_id = %s AND device_id = %s
                RETURNING id, device_id, name, latitude, longitude,
                          radius_meters, enabled, last_tracker_inside,
                          last_evaluated_at,
                          created_at, updated_at
                """,
                (
                    "name" in fields,
                    request.name,
                    "latitude" in fields,
                    request.latitude,
                    "longitude" in fields,
                    request.longitude,
                    "radius_meters" in fields,
                    request.radius_meters,
                    "enabled" in fields,
                    request.enabled,
                    evaluation_reset,
                    evaluation_reset,
                    safe_zone_id,
                    user_id,
                    device_id,
                ),
            )
            row = await query.fetchone()
        if row is None:
            raise PremiumError("SAFE_ZONE_NOT_FOUND", 404)
        return self._safe_zone_response(dict(row))

    async def delete_safe_zone(
        self,
        database: Database,
        *,
        user_id: UUID,
        device_id: UUID,
        safe_zone_id: UUID,
    ) -> None:
        async with database.transaction() as connection:
            await self._owned_device(
                connection,
                user_id=user_id,
                device_id=device_id,
                require_subscription=False,
            )
            query = await connection.execute(
                """
                DELETE FROM public.device_safe_zone
                 WHERE id = %s AND user_id = %s AND device_id = %s
             RETURNING id
                """,
                (safe_zone_id, user_id, device_id),
            )
            if await query.fetchone() is None:
                raise PremiumError("SAFE_ZONE_NOT_FOUND", 404)

    @staticmethod
    def _profile_response(row: dict) -> DeviceProtectionProfileResponse:
        return DeviceProtectionProfileResponse(
            device_id=row["device_id"],
            separation_alerts=bool(row["separation_alerts"]),
            separation_threshold_meters=int(
                row["separation_threshold_meters"]
            ),
            vehicle_mode=bool(row["vehicle_mode"]),
            movement_alerts=bool(row["movement_alerts"]),
            movement_threshold_meters=int(row["movement_threshold_meters"]),
            updated_at=row["updated_at"],
        )

    async def _profile_row(
        self, connection: AsyncConnection, *, user_id: UUID, device_id: UUID
    ) -> dict:
        await connection.execute(
            """
            INSERT INTO public.device_protection_profile (user_id, device_id)
            VALUES (%s, %s)
            ON CONFLICT (user_id, device_id) DO NOTHING
            """,
            (user_id, device_id),
        )
        query = await connection.execute(
            """
            SELECT device_id, separation_alerts,
                   separation_threshold_meters, vehicle_mode,
                   movement_alerts, movement_threshold_meters,
                   movement_anchor_latitude, movement_anchor_longitude,
                   updated_at
              FROM public.device_protection_profile
             WHERE user_id = %s AND device_id = %s
             FOR UPDATE
            """,
            (user_id, device_id),
        )
        row = await query.fetchone()
        if row is None:
            raise RuntimeError("Protection-profile insert returned no row")
        return dict(row)

    async def get_protection_profile(
        self, database: Database, *, user_id: UUID, device_id: UUID
    ) -> DeviceProtectionProfileResponse:
        async with database.transaction() as connection:
            await self._owned_device(
                connection,
                user_id=user_id,
                device_id=device_id,
                require_subscription=False,
            )
            row = await self._profile_row(
                connection, user_id=user_id, device_id=device_id
            )
        return self._profile_response(row)

    async def update_protection_profile(
        self,
        database: Database,
        *,
        user_id: UUID,
        device_id: UUID,
        request: DeviceProtectionProfileUpdate,
    ) -> DeviceProtectionProfileResponse:
        fields = request.model_fields_set
        if not fields:
            raise PremiumError("INVALID_PREMIUM_REQUEST", 422)
        if any(getattr(request, field) is None for field in fields):
            raise PremiumError("INVALID_PREMIUM_REQUEST", 422)
        async with database.transaction() as connection:
            device = await self._owned_device(
                connection,
                user_id=user_id,
                device_id=device_id,
                require_subscription=True,
                lock=True,
            )
            current = await self._profile_row(
                connection, user_id=user_id, device_id=device_id
            )
            separation_alerts = (
                request.separation_alerts
                if "separation_alerts" in fields
                else current["separation_alerts"]
            )
            separation_threshold = (
                request.separation_threshold_meters
                if "separation_threshold_meters" in fields
                else current["separation_threshold_meters"]
            )
            vehicle_mode = (
                request.vehicle_mode
                if "vehicle_mode" in fields
                else current["vehicle_mode"]
            )
            movement_alerts = (
                request.movement_alerts
                if "movement_alerts" in fields
                else current["movement_alerts"]
            )
            threshold = (
                request.movement_threshold_meters
                if "movement_threshold_meters" in fields
                else current["movement_threshold_meters"]
            )
            anchor_latitude = current["movement_anchor_latitude"]
            anchor_longitude = current["movement_anchor_longitude"]
            if movement_alerts and (
                not current["movement_alerts"]
                or "movement_threshold_meters" in fields
            ):
                anchor_latitude = device["last_latitude"]
                anchor_longitude = device["last_longitude"]
            elif not movement_alerts:
                anchor_latitude = None
                anchor_longitude = None
            query = await connection.execute(
                """
                UPDATE public.device_protection_profile
                   SET separation_alerts = %s,
                       separation_threshold_meters = %s,
                       vehicle_mode = %s,
                       movement_alerts = %s, movement_threshold_meters = %s,
                       movement_anchor_latitude = %s,
                       movement_anchor_longitude = %s,
                       updated_at = now()
                 WHERE user_id = %s AND device_id = %s
                RETURNING device_id, separation_alerts,
                          separation_threshold_meters, vehicle_mode,
                          movement_alerts,
                          movement_threshold_meters, updated_at
                """,
                (
                    separation_alerts,
                    separation_threshold,
                    vehicle_mode,
                    movement_alerts,
                    threshold,
                    anchor_latitude,
                    anchor_longitude,
                    user_id,
                    device_id,
                ),
            )
            row = await query.fetchone()
        if row is None:
            raise RuntimeError("Protection-profile update returned no row")
        return self._profile_response(dict(row))

    @staticmethod
    def _utc_timestamp(value: datetime) -> datetime:
        if value.tzinfo is None:
            raise PremiumError("INVALID_COMPANION_OBSERVATION", 422)
        return value.astimezone(UTC)

    async def _companion_status(
        self,
        connection: AsyncConnection,
        *,
        device: dict,
        user_id: UUID,
        observation_accepted: bool | None = None,
    ) -> DeviceCompanionStatusResponse:
        query = await connection.execute(
            """
            SELECT companion.installation_id, companion.platform,
                   observation.sampled_at, observation.phone_accuracy_meters,
                   observation.tag_proximity, observation.tag_observed_at,
                   observation.tag_rssi_dbm
              FROM public.device_primary_companion companion
         LEFT JOIN LATERAL (
                    SELECT sampled_at, phone_accuracy_meters, tag_proximity,
                           tag_observed_at, tag_rssi_dbm
                      FROM public.device_companion_observation observation
                     WHERE observation.user_id = companion.user_id
                       AND observation.device_id = companion.device_id
                       AND observation.installation_id = companion.installation_id
                     ORDER BY observation.sampled_at DESC,
                              observation.created_at DESC
                     LIMIT 1
                   ) observation ON true
             WHERE companion.user_id = %s AND companion.device_id = %s
            """,
            (user_id, device["device_id"]),
        )
        row = await query.fetchone()
        if row is None:
            return DeviceCompanionStatusResponse(
                device_id=device["device_id"],
                subscription_active=device["active_subscription_id"] is not None,
                configured=False,
                observation_accepted=observation_accepted,
            )
        return DeviceCompanionStatusResponse(
            device_id=device["device_id"],
            subscription_active=device["active_subscription_id"] is not None,
            configured=True,
            installation_id=row["installation_id"],
            platform=row["platform"],
            observation_accepted=observation_accepted,
            last_observation_at=row.get("sampled_at"),
            phone_accuracy_meters=(
                float(row["phone_accuracy_meters"])
                if row.get("phone_accuracy_meters") is not None
                else None
            ),
            tag_proximity=row.get("tag_proximity"),
            tag_observed_at=row.get("tag_observed_at"),
            tag_rssi_dbm=row.get("tag_rssi_dbm"),
        )

    async def report_companion_observation(
        self,
        database: Database,
        *,
        user_id: UUID,
        device_id: UUID,
        request: DeviceCompanionObservationCreate,
    ) -> DeviceCompanionStatusResponse:
        now = datetime.now(UTC)
        sampled_at = self._utc_timestamp(request.sampled_at)
        if sampled_at < now - timedelta(hours=24) or sampled_at > now + timedelta(
            minutes=5
        ):
            raise PremiumError("INVALID_COMPANION_OBSERVATION", 422)
        tag_observed_at = None
        if request.tag_observed_at is not None:
            tag_observed_at = self._utc_timestamp(request.tag_observed_at)
            if (
                tag_observed_at > sampled_at + timedelta(minutes=5)
                or tag_observed_at < sampled_at - timedelta(minutes=5)
            ):
                raise PremiumError("INVALID_COMPANION_OBSERVATION", 422)

        async with database.transaction() as connection:
            device = await self._owned_device(
                connection,
                user_id=user_id,
                device_id=device_id,
                require_subscription=True,
                lock=True,
            )
            primary_query = await connection.execute(
                """
                INSERT INTO public.device_primary_companion (
                    user_id, device_id, installation_id, platform
                ) VALUES (%s, %s, %s, %s)
                ON CONFLICT (user_id, device_id) DO UPDATE
                   SET platform = EXCLUDED.platform, updated_at = now()
                 WHERE device_primary_companion.installation_id =
                       EXCLUDED.installation_id
                RETURNING installation_id
                """,
                (user_id, device_id, request.installation_id, request.platform),
            )
            if await primary_query.fetchone() is None:
                raise PremiumError("MAIN_DEVICE_MISMATCH", 409)
            observation_query = await connection.execute(
                """
                INSERT INTO public.device_companion_observation (
                    user_id, device_id, installation_id, platform,
                    phone_latitude, phone_longitude, phone_accuracy_meters,
                    sampled_at, tag_proximity, tag_observed_at,
                    tag_rssi_dbm, scan_duration_seconds
                ) VALUES (
                    %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s
                )
                ON CONFLICT (user_id, device_id, installation_id, sampled_at)
                DO NOTHING
                RETURNING id
                """,
                (
                    user_id,
                    device_id,
                    request.installation_id,
                    request.platform,
                    request.phone_latitude,
                    request.phone_longitude,
                    request.phone_accuracy_meters,
                    sampled_at,
                    request.tag_proximity,
                    tag_observed_at,
                    request.tag_rssi_dbm,
                    request.scan_duration_seconds,
                ),
            )
            accepted = await observation_query.fetchone() is not None
            return await self._companion_status(
                connection,
                device=device,
                user_id=user_id,
                observation_accepted=accepted,
            )

    async def get_companion_status(
        self, database: Database, *, user_id: UUID, device_id: UUID
    ) -> DeviceCompanionStatusResponse:
        async with database.transaction() as connection:
            device = await self._owned_device(
                connection,
                user_id=user_id,
                device_id=device_id,
                require_subscription=False,
            )
            return await self._companion_status(
                connection, device=device, user_id=user_id
            )

    async def reset_companion(
        self, database: Database, *, user_id: UUID, device_id: UUID
    ) -> DeviceCompanionResetResponse:
        async with database.transaction() as connection:
            await self._owned_device(
                connection,
                user_id=user_id,
                device_id=device_id,
                require_subscription=False,
                lock=True,
            )
            await connection.execute(
                """
                DELETE FROM public.device_primary_companion
                 WHERE user_id = %s AND device_id = %s
                """,
                (user_id, device_id),
            )
        return DeviceCompanionResetResponse(device_id=device_id)

    @staticmethod
    def _share_summary(row: dict) -> DeviceRecoveryShareSummary:
        return DeviceRecoveryShareSummary(
            id=row["id"],
            device_id=row["device_id"],
            label=row["label"],
            access_level=row["access_level"],
            expires_at=row["expires_at"],
            revoked_at=row.get("revoked_at"),
            last_accessed_at=row.get("last_accessed_at"),
            created_at=row["created_at"],
        )

    async def create_recovery_share(
        self,
        database: Database,
        *,
        user_id: UUID,
        device_id: UUID,
        request: DeviceRecoveryShareCreate,
    ) -> DeviceRecoveryShareCreateResponse:
        token_bytes = secrets.token_bytes(32)
        token = b64url_encode(token_bytes)
        token_hash = hashlib.sha256(token_bytes).digest()
        expires_at = datetime.now(UTC) + timedelta(hours=request.expires_in_hours)
        try:
            async with database.transaction() as connection:
                await self._owned_device(
                    connection,
                    user_id=user_id,
                    device_id=device_id,
                    require_subscription=True,
                    lock=True,
                )
                count_query = await connection.execute(
                    """
                    SELECT count(*) AS share_count
                      FROM public.device_recovery_share
                     WHERE user_id = %s AND device_id = %s
                       AND revoked_at IS NULL AND expires_at > now()
                    """,
                    (user_id, device_id),
                )
                count_row = await count_query.fetchone()
                if count_row is not None and int(count_row["share_count"]) >= 20:
                    raise PremiumError("RECOVERY_SHARE_LIMIT_REACHED", 409)
                query = await connection.execute(
                    """
                    INSERT INTO public.device_recovery_share (
                        user_id, device_id, token_sha256, label,
                        access_level, expires_at
                    ) VALUES (%s, %s, %s, %s, %s, %s)
                    RETURNING id, device_id, label, access_level, expires_at,
                              revoked_at, last_accessed_at, created_at
                    """,
                    (
                        user_id,
                        device_id,
                        token_hash,
                        request.label,
                        request.access_level,
                        expires_at,
                    ),
                )
                row = await query.fetchone()
        finally:
            token_bytes = b"\x00" * len(token_bytes)
        if row is None:
            raise RuntimeError("Recovery-share insert returned no row")
        summary = self._share_summary(dict(row))
        return DeviceRecoveryShareCreateResponse(
            **summary.model_dump(),
            share_token=token,
            # A web client keeps the capability in the URL fragment, which is
            # not sent in HTTP access logs or Referrer headers, then resolves
            # it through the POST body below.
            share_path=f"/recovery#token={token}",
        )

    async def list_recovery_shares(
        self, database: Database, *, user_id: UUID, device_id: UUID
    ) -> DeviceRecoveryShareListResponse:
        async with database.transaction() as connection:
            await self._owned_device(
                connection,
                user_id=user_id,
                device_id=device_id,
                require_subscription=False,
            )
            query = await connection.execute(
                """
                SELECT id, device_id, label, access_level, expires_at,
                       revoked_at, last_accessed_at, created_at
                  FROM public.device_recovery_share
                 WHERE user_id = %s AND device_id = %s
                 ORDER BY created_at DESC, id DESC
                 LIMIT 100
                """,
                (user_id, device_id),
            )
            rows = await query.fetchall()
        return DeviceRecoveryShareListResponse(
            shares=[self._share_summary(dict(row)) for row in rows]
        )

    async def revoke_recovery_share(
        self,
        database: Database,
        *,
        user_id: UUID,
        device_id: UUID,
        share_id: UUID,
    ) -> DeviceRecoveryShareSummary:
        async with database.transaction() as connection:
            await self._owned_device(
                connection,
                user_id=user_id,
                device_id=device_id,
                require_subscription=False,
            )
            query = await connection.execute(
                """
                UPDATE public.device_recovery_share
                   SET revoked_at = COALESCE(revoked_at, now()),
                       updated_at = now()
                 WHERE id = %s AND user_id = %s AND device_id = %s
                RETURNING id, device_id, label, access_level, expires_at,
                          revoked_at, last_accessed_at, created_at
                """,
                (share_id, user_id, device_id),
            )
            row = await query.fetchone()
        if row is None:
            raise PremiumError("RECOVERY_SHARE_NOT_FOUND", 404)
        return self._share_summary(dict(row))

    async def shared_tracker(
        self, database: Database, *, token: str
    ) -> SharedTrackerResponse:
        try:
            token_bytes = b64url_decode_exact(token, 32)
        except ValueError:
            raise PremiumError("RECOVERY_SHARE_NOT_FOUND", 404) from None
        token_hash = hashlib.sha256(token_bytes).digest()
        async with database.transaction() as connection:
            query = await connection.execute(
                """
                SELECT share.id, share.device_id, share.user_id,
                       share.access_level, share.expires_at,
                       COALESCE(NULLIF(BTRIM(device.name), ''),
                                device.serial_number) AS tracker_name
                  FROM public.device_recovery_share share
                  JOIN public.device device ON device.id = share.device_id
                  JOIN public.profiles owner
                    ON owner.id = share.user_id
                   AND owner.account_status = 'active'
                 WHERE share.token_sha256 = %s
                   AND share.revoked_at IS NULL
                   AND share.expires_at > now()
                   AND EXISTS (
                     SELECT 1 FROM public.ownership ownership
                      WHERE ownership.device_id = share.device_id
                        AND ownership.user_id = share.user_id
                        AND ownership.ended_at IS NULL
                   )
                   AND EXISTS (
                     SELECT 1 FROM public.subscription subscription
                      WHERE subscription.user_id = share.user_id
                        AND subscription.status IN ('active', 'trialing')
                        AND subscription.starts_at <= now()
                        AND subscription.current_period_end > now()
                   )
                 FOR UPDATE OF share
                """,
                (token_hash,),
            )
            share = await query.fetchone()
            if share is None:
                raise PremiumError("RECOVERY_SHARE_NOT_FOUND", 404)
            await connection.execute(
                """
                UPDATE public.device_recovery_share
                   SET last_accessed_at = now(), updated_at = now()
                 WHERE id = %s
                """,
                (share["id"],),
            )
            limit = 2_000 if share["access_level"] == "history" else 1
            history_query = await connection.execute(
                """
                SELECT latitude, longitude, recorded_at
                  FROM public.device_location_report
                 WHERE device_id = %s AND user_id = %s
                   AND recorded_at >= now() - interval '30 days'
                 ORDER BY recorded_at DESC, id DESC
                 LIMIT %s
                """,
                (share["device_id"], share["user_id"], limit),
            )
            rows = await history_query.fetchall()
        points = [
            DeviceLocationHistoryPoint(
                latitude=float(row["latitude"]),
                longitude=float(row["longitude"]),
                recorded_at=row["recorded_at"],
            )
            for row in rows
        ]
        return SharedTrackerResponse(
            tracker_name=share["tracker_name"],
            access_level=share["access_level"],
            expires_at=share["expires_at"],
            latest_location=points[0] if points else None,
            locations=points if share["access_level"] == "history" else [],
        )

    @staticmethod
    def _replacement_claim_summary(row: dict) -> DeviceReplacementClaimSummary:
        return DeviceReplacementClaimSummary(
            id=row["id"],
            device_id=row["device_id"],
            subscription_id=row["subscription_id"],
            reason=row["reason"],
            incident_at=row["incident_at"],
            status=row["status"],
            notes=row.get("notes"),
            benefit_period_start=row["benefit_period_start"],
            benefit_period_end=row["benefit_period_end"],
            replacement_price_minor=0,
            replacement_device_id=row.get("replacement_device_id"),
            replacement_serial_number=row.get("replacement_serial_number"),
            provisioning_request_id=row.get("provisioning_request_id"),
            submitted_at=row["submitted_at"],
            reviewed_at=row.get("reviewed_at"),
            fulfilled_at=row.get("fulfilled_at"),
        )

    async def _replacement_eligibility(
        self,
        connection: AsyncConnection,
        *,
        device: dict,
        user_id: UUID,
    ) -> DeviceReplacementEligibilityResponse:
        device_id = device["device_id"]
        subscription_id = device.get("active_subscription_id")
        plan_months = device.get("active_plan_months")
        period_start = device.get("active_period_start")
        period_end = device.get("active_period_end")
        if subscription_id is None:
            return DeviceReplacementEligibilityResponse(
                device_id=device_id,
                eligible=False,
                reason="subscription_required",
            )
        if device.get("active_subscription_status") != "active":
            return DeviceReplacementEligibilityResponse(
                device_id=device_id,
                eligible=False,
                reason="paid_subscription_required",
                current_plan_months=plan_months,
                benefit_period_start=period_start,
                benefit_period_end=period_end,
            )
        if int(plan_months or 0) < 6:
            return DeviceReplacementEligibilityResponse(
                device_id=device_id,
                eligible=False,
                reason="plan_not_eligible",
                current_plan_months=plan_months,
                benefit_period_start=period_start,
                benefit_period_end=period_end,
            )
        existing_query = await connection.execute(
            """
            SELECT id, status
              FROM public.device_replacement_claim
             WHERE user_id = %s AND device_id = %s
               AND subscription_id = %s AND benefit_period_start = %s
             LIMIT 1
            """,
            (user_id, device_id, subscription_id, period_start),
        )
        existing = await existing_query.fetchone()
        if existing is not None:
            return DeviceReplacementEligibilityResponse(
                device_id=device_id,
                eligible=False,
                reason="already_claimed",
                current_plan_months=plan_months,
                benefit_period_start=period_start,
                benefit_period_end=period_end,
                existing_claim_id=existing["id"],
                existing_claim_status=existing["status"],
            )
        return DeviceReplacementEligibilityResponse(
            device_id=device_id,
            eligible=True,
            reason="eligible",
            current_plan_months=plan_months,
            benefit_period_start=period_start,
            benefit_period_end=period_end,
        )

    async def replacement_eligibility(
        self, database: Database, *, user_id: UUID, device_id: UUID
    ) -> DeviceReplacementEligibilityResponse:
        async with database.transaction() as connection:
            device = await self._owned_device(
                connection,
                user_id=user_id,
                device_id=device_id,
                require_subscription=False,
            )
            return await self._replacement_eligibility(
                connection, device=device, user_id=user_id
            )

    async def create_replacement_claim(
        self,
        database: Database,
        *,
        user_id: UUID,
        device_id: UUID,
        request: DeviceReplacementClaimCreate,
    ) -> DeviceReplacementClaimSummary:
        incident_at = self._utc_timestamp(request.incident_at)
        now = datetime.now(UTC)
        if incident_at > now + timedelta(minutes=5):
            raise PremiumError("INVALID_PREMIUM_REQUEST", 422)
        async with database.transaction() as connection:
            device = await self._owned_device(
                connection,
                user_id=user_id,
                device_id=device_id,
                require_subscription=False,
                lock=True,
            )
            eligibility = await self._replacement_eligibility(
                connection, device=device, user_id=user_id
            )
            if not eligibility.eligible:
                status_code = (
                    402
                    if eligibility.reason
                    in {"subscription_required", "paid_subscription_required"}
                    else 409
                )
                raise PremiumError("REPLACEMENT_NOT_ELIGIBLE", status_code)
            if (
                eligibility.benefit_period_start is None
                or eligibility.benefit_period_end is None
                or incident_at < eligibility.benefit_period_start
            ):
                raise PremiumError("REPLACEMENT_NOT_ELIGIBLE", 409)
            query = await connection.execute(
                """
                INSERT INTO public.device_replacement_claim (
                    user_id, device_id, subscription_id, reason, incident_at,
                    notes, benefit_period_start, benefit_period_end
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (subscription_id, benefit_period_start) DO NOTHING
                RETURNING id, device_id, subscription_id, reason, incident_at,
                          status, notes, benefit_period_start,
                          benefit_period_end, submitted_at, reviewed_at,
                          fulfilled_at
                """,
                (
                    user_id,
                    device_id,
                    device["active_subscription_id"],
                    request.reason,
                    incident_at,
                    request.notes,
                    eligibility.benefit_period_start,
                    eligibility.benefit_period_end,
                ),
            )
            row = await query.fetchone()
        if row is None:
            raise PremiumError("REPLACEMENT_ALREADY_CLAIMED", 409)
        return self._replacement_claim_summary(dict(row))

    async def list_replacement_claims(
        self, database: Database, *, user_id: UUID, device_id: UUID
    ) -> DeviceReplacementClaimListResponse:
        async with database.transaction() as connection:
            await self._owned_device(
                connection,
                user_id=user_id,
                device_id=device_id,
                require_subscription=False,
            )
            query = await connection.execute(
                """
                SELECT claim.id, claim.device_id, claim.subscription_id,
                       claim.reason, claim.incident_at, claim.status,
                       claim.notes, claim.benefit_period_start,
                       claim.benefit_period_end, claim.replacement_device_id,
                       replacement.serial_number AS replacement_serial_number,
                       provisioning.id AS provisioning_request_id,
                       claim.submitted_at, claim.reviewed_at, claim.fulfilled_at
                  FROM public.device_replacement_claim claim
             LEFT JOIN public.device replacement
                    ON replacement.id = claim.replacement_device_id
             LEFT JOIN public.provisioning_request provisioning
                    ON provisioning.replacement_claim_id = claim.id
                 WHERE claim.user_id = %s AND claim.device_id = %s
                 ORDER BY claim.submitted_at DESC, claim.id DESC
                 LIMIT 100
                """,
                (user_id, device_id),
            )
            rows = await query.fetchall()
        return DeviceReplacementClaimListResponse(
            claims=[self._replacement_claim_summary(dict(row)) for row in rows]
        )

    async def recovery_report(
        self, database: Database, *, user_id: UUID, device_id: UUID
    ) -> DeviceRecoveryReportResponse:
        async with database.transaction() as connection:
            device = await self._owned_device(
                connection,
                user_id=user_id,
                device_id=device_id,
                require_subscription=True,
            )
            eligibility = await self._replacement_eligibility(
                connection, device=device, user_id=user_id
            )
            query = await connection.execute(
                """
                SELECT count(*) AS location_count,
                       (SELECT count(*) FROM public.device_safe_zone zone
                         WHERE zone.user_id = %s AND zone.device_id = %s
                           AND zone.enabled = true) AS safe_zone_count,
                       (SELECT count(*) FROM public.device_recovery_share share
                         WHERE share.user_id = %s AND share.device_id = %s
                           AND share.revoked_at IS NULL
                           AND share.expires_at > now()) AS active_share_count,
                       (SELECT count(*) FROM public.user_notification notice
                         WHERE notice.user_id = %s AND notice.device_id = %s
                           AND notice.kind IN (
                             'separation_detected', 'movement_detected'
                           )
                           AND notice.created_at >= now() - interval '30 days'
                       ) AS recent_alert_count,
                       EXISTS (
                         SELECT 1 FROM public.device_primary_companion companion
                          WHERE companion.user_id = %s
                            AND companion.device_id = %s
                       ) AS companion_configured,
                       (SELECT max(observation.sampled_at)
                          FROM public.device_companion_observation observation
                         WHERE observation.user_id = %s
                           AND observation.device_id = %s
                       ) AS companion_last_observation
                  FROM public.device_location_report report
                 WHERE report.user_id = %s AND report.device_id = %s
                   AND report.recorded_at >= now() - interval '30 days'
                """,
                (
                    user_id,
                    device_id,
                    user_id,
                    device_id,
                    user_id,
                    device_id,
                    user_id,
                    device_id,
                    user_id,
                    device_id,
                    user_id,
                    device_id,
                ),
            )
            counts = await query.fetchone()
            latest_query = await connection.execute(
                """
                SELECT latitude, longitude, recorded_at
                  FROM public.device_location_report
                 WHERE user_id = %s AND device_id = %s
                 ORDER BY recorded_at DESC, id DESC
                 LIMIT 1
                """,
                (user_id, device_id),
            )
            latest = await latest_query.fetchone()
        last_location = (
            DeviceLocationHistoryPoint(
                latitude=float(latest["latitude"]),
                longitude=float(latest["longitude"]),
                recorded_at=latest["recorded_at"],
            )
            if latest is not None
            else None
        )
        companion_last = counts.get("companion_last_observation") if counts else None
        if not counts or not bool(counts.get("companion_configured")):
            companion_status = "not_configured"
        elif (
            companion_last is not None
            and companion_last >= datetime.now(UTC) - timedelta(minutes=15)
        ):
            companion_status = "ready"
        else:
            companion_status = "stale"
        return DeviceRecoveryReportResponse(
            device_id=device_id,
            tracker_name=device["tracker_name"],
            serial_number=device["serial_number"],
            generated_at=datetime.now(UTC),
            subscription_period_end=device["active_period_end"],
            last_location=last_location,
            location_count_30d=int(counts["location_count"]) if counts else 0,
            safe_zone_count=int(counts["safe_zone_count"]) if counts else 0,
            active_share_count=int(counts["active_share_count"]) if counts else 0,
            recent_alert_count_30d=(
                int(counts["recent_alert_count"]) if counts else 0
            ),
            companion_status=companion_status,
            replacement_eligible=eligibility.eligible,
            replacement_claim_status=eligibility.existing_claim_status,
        )

    async def overview(
        self, database: Database, *, user_id: UUID, device_id: UUID
    ) -> PremiumTrackerOverviewResponse:
        async with database.transaction() as connection:
            device = await self._owned_device(
                connection,
                user_id=user_id,
                device_id=device_id,
                require_subscription=True,
            )
            profile = await self._profile_row(
                connection, user_id=user_id, device_id=device_id
            )
            eligibility = await self._replacement_eligibility(
                connection, device=device, user_id=user_id
            )
            query = await connection.execute(
                """
                SELECT (SELECT count(*) FROM public.device_safe_zone zone
                         WHERE zone.user_id = %s AND zone.device_id = %s
                           AND zone.enabled = true) AS safe_zone_count,
                       (SELECT count(*) FROM public.device_recovery_share share
                         WHERE share.user_id = %s AND share.device_id = %s
                           AND share.revoked_at IS NULL
                           AND share.expires_at > now()) AS active_share_count,
                       EXISTS (
                         SELECT 1 FROM public.device_primary_companion companion
                          WHERE companion.user_id = %s
                            AND companion.device_id = %s
                       ) AS companion_configured,
                       (SELECT max(observation.sampled_at)
                          FROM public.device_companion_observation observation
                         WHERE observation.user_id = %s
                           AND observation.device_id = %s
                       ) AS companion_last_observation
                """,
                (
                    user_id,
                    device_id,
                    user_id,
                    device_id,
                    user_id,
                    device_id,
                    user_id,
                    device_id,
                ),
            )
            counts = await query.fetchone()
        last_location_at = device["last_location_at"]
        if last_location_at is None:
            location_status = "never"
        else:
            if last_location_at.tzinfo is None:
                last_location_at = last_location_at.replace(tzinfo=UTC)
            location_status = (
                "current"
                if last_location_at >= datetime.now(UTC) - timedelta(hours=24)
                else "stale"
            )
        companion_last = counts.get("companion_last_observation") if counts else None
        if not counts or not bool(counts.get("companion_configured")):
            companion_status = "not_configured"
        elif (
            companion_last is not None
            and companion_last >= datetime.now(UTC) - timedelta(minutes=15)
        ):
            companion_status = "ready"
        else:
            companion_status = "stale"
        return PremiumTrackerOverviewResponse(
            device_id=device_id,
            tracker_name=device["tracker_name"],
            subscription_active=True,
            location_status=location_status,
            last_location_at=last_location_at,
            firmware_version=device["firmware_version"],
            separation_alerts=bool(profile["separation_alerts"]),
            vehicle_mode=bool(profile["vehicle_mode"]),
            movement_alerts=bool(profile["movement_alerts"]),
            safe_zone_count=int(counts["safe_zone_count"]) if counts else 0,
            active_share_count=int(counts["active_share_count"]) if counts else 0,
            companion_status=companion_status,
            replacement_eligible=eligibility.eligible,
        )

    async def delete_location_history(
        self, database: Database, *, user_id: UUID, device_id: UUID
    ) -> LocationHistoryDeleteResponse:
        async with database.transaction() as connection:
            await self._owned_device(
                connection,
                user_id=user_id,
                device_id=device_id,
                require_subscription=False,
                lock=True,
            )
            query = await connection.execute(
                """
                DELETE FROM public.device_location_report
                 WHERE user_id = %s AND device_id = %s
             RETURNING id
                """,
                (user_id, device_id),
            )
            deleted = len(await query.fetchall())
        return LocationHistoryDeleteResponse(
            device_id=device_id, deleted_reports=deleted
        )


class PremiumRetentionWorker:
    def __init__(self, database: Database, *, interval_seconds: int = 3_600) -> None:
        self.database = database
        self.interval_seconds = interval_seconds

    async def prune_once(self) -> int:
        async with self.database.transaction() as connection:
            query = await connection.execute(
                """
                WITH old_locations AS (
                    SELECT id FROM public.device_location_report
                     WHERE recorded_at < now() - interval '30 days'
                     ORDER BY recorded_at, id
                     LIMIT 1000 FOR UPDATE SKIP LOCKED
                ), old_observations AS (
                    SELECT id FROM public.device_companion_observation
                     WHERE sampled_at < now() - interval '24 hours'
                     ORDER BY sampled_at, id
                     LIMIT 1000 FOR UPDATE SKIP LOCKED
                ), deleted_locations AS (
                    DELETE FROM public.device_location_report
                     WHERE id IN (SELECT id FROM old_locations)
                    RETURNING 1
                ), deleted_observations AS (
                    DELETE FROM public.device_companion_observation
                     WHERE id IN (SELECT id FROM old_observations)
                    RETURNING 1
                )
                SELECT
                  (SELECT count(*) FROM deleted_locations)::int
                    AS deleted_location_count,
                  (SELECT count(*) FROM deleted_observations)::int
                    AS deleted_observation_count
                """
            )
            row = await query.fetchone()
        if row is None:
            return 0
        return int(row["deleted_location_count"]) + int(
            row["deleted_observation_count"]
        )

    async def run(self, stop: asyncio.Event) -> None:
        while not stop.is_set():
            try:
                deleted = await self.prune_once()
                if deleted:
                    logger.info(
                        "premium_location_retention_pruned deleted_count=%s",
                        deleted,
                    )
                if deleted >= 1000:
                    await asyncio.sleep(0)
                    continue
            except Exception as exc:  # pragma: no cover - production resilience
                logger.error(
                    "premium_location_retention_failed error_type=%s",
                    type(exc).__name__,
                )
            try:
                await asyncio.wait_for(
                    stop.wait(), timeout=self.interval_seconds
                )
            except TimeoutError:
                continue


router = APIRouter(prefix="/v1", tags=["premium"])


@router.get(
    "/devices/{device_id}/premium/features",
    response_model=PremiumFeatureAccessResponse,
)
async def premium_feature_access(
    device_id: UUID, request: Request, principal: AuthenticatedPrincipal
) -> PremiumFeatureAccessResponse:
    return await request.app.state.premium.feature_access(
        request.app.state.database,
        user_id=principal.user_id,
        device_id=device_id,
    )


@router.get(
    "/devices/{device_id}/premium/overview",
    response_model=PremiumTrackerOverviewResponse,
)
async def premium_tracker_overview(
    device_id: UUID, request: Request, principal: AuthenticatedPrincipal
) -> PremiumTrackerOverviewResponse:
    return await request.app.state.premium.overview(
        request.app.state.database,
        user_id=principal.user_id,
        device_id=device_id,
    )


@router.post(
    "/devices/{device_id}/safe-zones",
    response_model=DeviceSafeZoneResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_safe_zone(
    device_id: UUID,
    body: DeviceSafeZoneCreate,
    request: Request,
    principal: AuthenticatedPrincipal,
) -> DeviceSafeZoneResponse:
    return await request.app.state.premium.create_safe_zone(
        request.app.state.database,
        user_id=principal.user_id,
        device_id=device_id,
        request=body,
    )


@router.get(
    "/devices/{device_id}/safe-zones",
    response_model=DeviceSafeZoneListResponse,
)
async def list_safe_zones(
    device_id: UUID, request: Request, principal: AuthenticatedPrincipal
) -> DeviceSafeZoneListResponse:
    return await request.app.state.premium.list_safe_zones(
        request.app.state.database,
        user_id=principal.user_id,
        device_id=device_id,
    )


@router.patch(
    "/devices/{device_id}/safe-zones/{safe_zone_id}",
    response_model=DeviceSafeZoneResponse,
)
async def update_safe_zone(
    device_id: UUID,
    safe_zone_id: UUID,
    body: DeviceSafeZoneUpdate,
    request: Request,
    principal: AuthenticatedPrincipal,
) -> DeviceSafeZoneResponse:
    return await request.app.state.premium.update_safe_zone(
        request.app.state.database,
        user_id=principal.user_id,
        device_id=device_id,
        safe_zone_id=safe_zone_id,
        request=body,
    )


@router.delete(
    "/devices/{device_id}/safe-zones/{safe_zone_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_safe_zone(
    device_id: UUID,
    safe_zone_id: UUID,
    request: Request,
    principal: AuthenticatedPrincipal,
) -> None:
    await request.app.state.premium.delete_safe_zone(
        request.app.state.database,
        user_id=principal.user_id,
        device_id=device_id,
        safe_zone_id=safe_zone_id,
    )


@router.get(
    "/devices/{device_id}/protection",
    response_model=DeviceProtectionProfileResponse,
)
async def get_protection_profile(
    device_id: UUID, request: Request, principal: AuthenticatedPrincipal
) -> DeviceProtectionProfileResponse:
    return await request.app.state.premium.get_protection_profile(
        request.app.state.database,
        user_id=principal.user_id,
        device_id=device_id,
    )


@router.patch(
    "/devices/{device_id}/protection",
    response_model=DeviceProtectionProfileResponse,
)
async def update_protection_profile(
    device_id: UUID,
    body: DeviceProtectionProfileUpdate,
    request: Request,
    principal: AuthenticatedPrincipal,
) -> DeviceProtectionProfileResponse:
    return await request.app.state.premium.update_protection_profile(
        request.app.state.database,
        user_id=principal.user_id,
        device_id=device_id,
        request=body,
    )


@router.post(
    "/devices/{device_id}/companion/observations",
    response_model=DeviceCompanionStatusResponse,
)
async def report_companion_observation(
    device_id: UUID,
    body: DeviceCompanionObservationCreate,
    request: Request,
    principal: AuthenticatedPrincipal,
) -> DeviceCompanionStatusResponse:
    return await request.app.state.premium.report_companion_observation(
        request.app.state.database,
        user_id=principal.user_id,
        device_id=device_id,
        request=body,
    )


@router.get(
    "/devices/{device_id}/companion",
    response_model=DeviceCompanionStatusResponse,
)
async def get_companion_status(
    device_id: UUID, request: Request, principal: AuthenticatedPrincipal
) -> DeviceCompanionStatusResponse:
    return await request.app.state.premium.get_companion_status(
        request.app.state.database,
        user_id=principal.user_id,
        device_id=device_id,
    )


@router.delete(
    "/devices/{device_id}/companion",
    response_model=DeviceCompanionResetResponse,
)
async def reset_companion(
    device_id: UUID, request: Request, principal: AuthenticatedPrincipal
) -> DeviceCompanionResetResponse:
    return await request.app.state.premium.reset_companion(
        request.app.state.database,
        user_id=principal.user_id,
        device_id=device_id,
    )


@router.get(
    "/devices/{device_id}/recovery-report",
    response_model=DeviceRecoveryReportResponse,
)
async def recovery_report(
    device_id: UUID, request: Request, principal: AuthenticatedPrincipal
) -> DeviceRecoveryReportResponse:
    return await request.app.state.premium.recovery_report(
        request.app.state.database,
        user_id=principal.user_id,
        device_id=device_id,
    )


@router.get(
    "/devices/{device_id}/replacement-eligibility",
    response_model=DeviceReplacementEligibilityResponse,
)
async def replacement_eligibility(
    device_id: UUID, request: Request, principal: AuthenticatedPrincipal
) -> DeviceReplacementEligibilityResponse:
    return await request.app.state.premium.replacement_eligibility(
        request.app.state.database,
        user_id=principal.user_id,
        device_id=device_id,
    )


@router.post(
    "/devices/{device_id}/replacement-claims",
    response_model=DeviceReplacementClaimSummary,
    status_code=status.HTTP_201_CREATED,
)
async def create_replacement_claim(
    device_id: UUID,
    body: DeviceReplacementClaimCreate,
    request: Request,
    principal: AuthenticatedPrincipal,
) -> DeviceReplacementClaimSummary:
    return await request.app.state.premium.create_replacement_claim(
        request.app.state.database,
        user_id=principal.user_id,
        device_id=device_id,
        request=body,
    )


@router.get(
    "/devices/{device_id}/replacement-claims",
    response_model=DeviceReplacementClaimListResponse,
)
async def list_replacement_claims(
    device_id: UUID, request: Request, principal: AuthenticatedPrincipal
) -> DeviceReplacementClaimListResponse:
    return await request.app.state.premium.list_replacement_claims(
        request.app.state.database,
        user_id=principal.user_id,
        device_id=device_id,
    )


@router.post(
    "/devices/{device_id}/recovery-shares",
    response_model=DeviceRecoveryShareCreateResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_recovery_share(
    device_id: UUID,
    body: DeviceRecoveryShareCreate,
    request: Request,
    principal: AuthenticatedPrincipal,
) -> DeviceRecoveryShareCreateResponse:
    return await request.app.state.premium.create_recovery_share(
        request.app.state.database,
        user_id=principal.user_id,
        device_id=device_id,
        request=body,
    )


@router.get(
    "/devices/{device_id}/recovery-shares",
    response_model=DeviceRecoveryShareListResponse,
)
async def list_recovery_shares(
    device_id: UUID, request: Request, principal: AuthenticatedPrincipal
) -> DeviceRecoveryShareListResponse:
    return await request.app.state.premium.list_recovery_shares(
        request.app.state.database,
        user_id=principal.user_id,
        device_id=device_id,
    )


@router.delete(
    "/devices/{device_id}/recovery-shares/{share_id}",
    response_model=DeviceRecoveryShareSummary,
)
async def revoke_recovery_share(
    device_id: UUID,
    share_id: UUID,
    request: Request,
    principal: AuthenticatedPrincipal,
) -> DeviceRecoveryShareSummary:
    return await request.app.state.premium.revoke_recovery_share(
        request.app.state.database,
        user_id=principal.user_id,
        device_id=device_id,
        share_id=share_id,
    )


@router.post(
    "/recovery-shares/resolve",
    response_model=SharedTrackerResponse,
)
async def shared_tracker(
    request: Request,
    body: RecoveryShareResolveRequest,
    response: Response,
) -> SharedTrackerResponse:
    response.headers["Cache-Control"] = "no-store"
    response.headers["Pragma"] = "no-cache"
    response.headers["Referrer-Policy"] = "no-referrer"
    return await request.app.state.premium.shared_tracker(
        request.app.state.database, token=body.token
    )


@router.delete(
    "/devices/{device_id}/location/history",
    response_model=LocationHistoryDeleteResponse,
)
async def delete_location_history(
    device_id: UUID, request: Request, principal: AuthenticatedPrincipal
) -> LocationHistoryDeleteResponse:
    return await request.app.state.premium.delete_location_history(
        request.app.state.database,
        user_id=principal.user_id,
        device_id=device_id,
    )
