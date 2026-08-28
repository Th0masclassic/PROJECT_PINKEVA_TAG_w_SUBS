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
    DeviceLocationHistoryPoint,
    DeviceProtectionProfileResponse,
    DeviceProtectionProfileUpdate,
    DeviceRecoveryReportResponse,
    DeviceRecoveryShareCreate,
    DeviceRecoveryShareCreateResponse,
    DeviceRecoveryShareListResponse,
    DeviceRecoveryShareSummary,
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
                   active_subscription.id AS active_subscription_id
              FROM public.device device
              JOIN public.ownership ownership
                ON ownership.device_id = device.id
               AND ownership.user_id = %s
               AND ownership.ended_at IS NULL
         LEFT JOIN LATERAL (
                    SELECT subscription.id
                      FROM public.subscription subscription
                     WHERE subscription.device_id = device.id
                       AND subscription.user_id = ownership.user_id
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
        return PremiumFeatureAccessResponse(
            device_id=device["device_id"],
            subscription_active=active,
            tier="premium" if active else "none",
            cloud_location_reports=active,
            location_history_days=30 if active else 0,
            smart_alerts=active,
            safe_zones=active,
            lost_mode=active,
            trusted_sharing=active,
            recovery_report=active,
            vehicle_mode=active,
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
            notify_on_enter=bool(row["notify_on_enter"]),
            notify_on_exit=bool(row["notify_on_exit"]),
            enabled=bool(row["enabled"]),
            last_inside=row.get("last_inside"),
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
                    user_id, device_id, name, latitude, longitude,
                    radius_meters, notify_on_enter, notify_on_exit
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                RETURNING id, device_id, name, latitude, longitude,
                          radius_meters, notify_on_enter, notify_on_exit,
                          enabled, last_inside, last_evaluated_at,
                          created_at, updated_at
                """,
                (
                    user_id,
                    device_id,
                    request.name,
                    request.latitude,
                    request.longitude,
                    request.radius_meters,
                    request.notify_on_enter,
                    request.notify_on_exit,
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
                       radius_meters, notify_on_enter, notify_on_exit,
                       enabled, last_inside, last_evaluated_at,
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
                       notify_on_enter = CASE
                         WHEN %s THEN %s ELSE notify_on_enter END,
                       notify_on_exit = CASE
                         WHEN %s THEN %s ELSE notify_on_exit END,
                       enabled = CASE WHEN %s THEN %s ELSE enabled END,
                       last_inside = CASE WHEN %s THEN NULL ELSE last_inside END,
                       last_evaluated_at = CASE
                         WHEN %s THEN NULL ELSE last_evaluated_at END,
                       updated_at = now()
                 WHERE id = %s AND user_id = %s AND device_id = %s
                RETURNING id, device_id, name, latitude, longitude,
                          radius_meters, notify_on_enter, notify_on_exit,
                          enabled, last_inside, last_evaluated_at,
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
                    "notify_on_enter" in fields,
                    request.notify_on_enter,
                    "notify_on_exit" in fields,
                    request.notify_on_exit,
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
            lost_mode=bool(row["lost_mode"]),
            lost_since=row.get("lost_since"),
            recovery_message=row.get("recovery_message"),
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
            SELECT device_id, lost_mode, lost_since, recovery_message,
                   vehicle_mode, movement_alerts, movement_threshold_meters,
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
        required_fields = fields.difference({"recovery_message"})
        if any(getattr(request, field) is None for field in required_fields):
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
            lost_mode = (
                request.lost_mode if "lost_mode" in fields else current["lost_mode"]
            )
            lost_since = current["lost_since"]
            if lost_mode and not current["lost_mode"]:
                lost_since = datetime.now(UTC)
            elif not lost_mode:
                lost_since = None
            recovery_message = (
                request.recovery_message
                if "recovery_message" in fields
                else current["recovery_message"]
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
                   SET lost_mode = %s, lost_since = %s,
                       recovery_message = %s, vehicle_mode = %s,
                       movement_alerts = %s, movement_threshold_meters = %s,
                       movement_anchor_latitude = %s,
                       movement_anchor_longitude = %s,
                       updated_at = now()
                 WHERE user_id = %s AND device_id = %s
                RETURNING device_id, lost_mode, lost_since, recovery_message,
                          vehicle_mode, movement_alerts,
                          movement_threshold_meters, updated_at
                """,
                (
                    lost_mode,
                    lost_since,
                    recovery_message,
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
                                device.serial_number) AS tracker_name,
                       COALESCE(profile.lost_mode, false) AS lost_mode,
                       profile.recovery_message
                  FROM public.device_recovery_share share
                  JOIN public.device device ON device.id = share.device_id
                  JOIN public.profiles owner
                    ON owner.id = share.user_id
                   AND owner.account_status = 'active'
             LEFT JOIN public.device_protection_profile profile
                    ON profile.device_id = share.device_id
                   AND profile.user_id = share.user_id
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
                      WHERE subscription.device_id = share.device_id
                        AND subscription.user_id = share.user_id
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
            lost_mode=bool(share["lost_mode"]),
            recovery_message=share["recovery_message"],
            access_level=share["access_level"],
            expires_at=share["expires_at"],
            latest_location=points[0] if points else None,
            locations=points if share["access_level"] == "history" else [],
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
            profile = await self._profile_row(
                connection, user_id=user_id, device_id=device_id
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
                           AND share.expires_at > now()) AS active_share_count
                  FROM public.device_location_report report
                 WHERE report.user_id = %s AND report.device_id = %s
                   AND report.recorded_at >= now() - interval '30 days'
                """,
                (user_id, device_id, user_id, device_id, user_id, device_id),
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
        return DeviceRecoveryReportResponse(
            device_id=device_id,
            tracker_name=device["tracker_name"],
            serial_number=device["serial_number"],
            generated_at=datetime.now(UTC),
            lost_mode=bool(profile["lost_mode"]),
            lost_since=profile["lost_since"],
            recovery_message=profile["recovery_message"],
            last_location=last_location,
            location_count_30d=int(counts["location_count"]) if counts else 0,
            safe_zone_count=int(counts["safe_zone_count"]) if counts else 0,
            active_share_count=int(counts["active_share_count"]) if counts else 0,
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
            query = await connection.execute(
                """
                SELECT (SELECT count(*) FROM public.device_safe_zone zone
                         WHERE zone.user_id = %s AND zone.device_id = %s
                           AND zone.enabled = true) AS safe_zone_count,
                       (SELECT count(*) FROM public.device_recovery_share share
                         WHERE share.user_id = %s AND share.device_id = %s
                           AND share.revoked_at IS NULL
                           AND share.expires_at > now()) AS active_share_count
                """,
                (user_id, device_id, user_id, device_id),
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
        return PremiumTrackerOverviewResponse(
            device_id=device_id,
            tracker_name=device["tracker_name"],
            subscription_active=True,
            location_status=location_status,
            last_location_at=last_location_at,
            firmware_version=device["firmware_version"],
            lost_mode=bool(profile["lost_mode"]),
            vehicle_mode=bool(profile["vehicle_mode"]),
            movement_alerts=bool(profile["movement_alerts"]),
            safe_zone_count=int(counts["safe_zone_count"]) if counts else 0,
            active_share_count=int(counts["active_share_count"]) if counts else 0,
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
                WITH deleted AS (
                    DELETE FROM public.device_location_report
                     WHERE recorded_at < now() - interval '30 days'
                    RETURNING 1
                )
                SELECT count(*)::int AS deleted_count FROM deleted
                """
            )
            row = await query.fetchone()
        return int(row["deleted_count"]) if row is not None else 0

    async def run(self, stop: asyncio.Event) -> None:
        while not stop.is_set():
            try:
                deleted = await self.prune_once()
                if deleted:
                    logger.info(
                        "premium_location_retention_pruned deleted_count=%s",
                        deleted,
                    )
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
