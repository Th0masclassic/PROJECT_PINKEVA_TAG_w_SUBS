from __future__ import annotations

import logging
from typing import Any
from uuid import UUID

from .config import Settings
from .database import Database


logger = logging.getLogger("pinqeva.location_queue")


async def consume_rate_limit(connection: Any, *, scope: str, limit: int) -> bool:
    """Atomic fixed-minute budget shared by every API and worker instance."""
    cursor = await connection.execute(
        """
        INSERT INTO public.location_rate_limit (
          scope, window_started_at, request_count
        ) VALUES (%s, date_trunc('minute', now()), 1)
        ON CONFLICT (scope) DO UPDATE
           SET window_started_at = EXCLUDED.window_started_at,
               request_count = CASE
                 WHEN location_rate_limit.window_started_at < EXCLUDED.window_started_at
                 THEN 1 ELSE location_rate_limit.request_count + 1 END
         WHERE location_rate_limit.window_started_at < EXCLUDED.window_started_at
            OR location_rate_limit.request_count < %s
        RETURNING scope
        """,
        (scope, limit),
    )
    return await cursor.fetchone() is not None


class LocationQueue:
    def __init__(self, database: Database, settings: Settings) -> None:
        self.database = database
        self.settings = settings

    async def request_refresh(
        self, *, user_id: UUID, device_id: UUID, session_id: UUID
    ) -> bool:
        """Request or join one durable refresh; clients cannot supply entitlement.

        A denied budget or outstanding failure backoff never accelerates a job.
        Device then queue row is the common lock order, also used by ingestion.
        """
        async with self.database.transaction() as connection:
            cursor = await connection.execute(
                """
                SELECT device.id FROM public.device device
                  JOIN public.ownership ownership ON ownership.device_id = device.id
                   AND ownership.user_id = %s AND ownership.ended_at IS NULL
                  JOIN public.profiles profile ON profile.id = ownership.user_id
                   AND profile.account_status = 'active'
                  JOIN public.provisioning_session session
                    ON session.id = device.provisioning_session_id
                   AND session.id = %s AND session.device_id = device.id
                   AND session.user_id = ownership.user_id AND session.status = 'claimed'
                 WHERE device.id = %s
                   AND public.pinqeva_active_subscription_id(ownership.user_id) IS NOT NULL
                 FOR UPDATE OF device
                """,
                (user_id, session_id, device_id),
            )
            if await cursor.fetchone() is None:
                return False
            await connection.execute(
                """
                INSERT INTO public.device_location_sync_state
                  (device_id, user_id, provisioning_session_id, next_attempt_at)
                VALUES (%s, %s, %s, now())
                ON CONFLICT (device_id) DO NOTHING
                """,
                (device_id, user_id, session_id),
            )
            cursor = await connection.execute(
                """
                SELECT *,
                  last_success_at > now() - make_interval(secs => %s) AS fresh,
                  lease_owner IS NOT NULL AND lease_expires_at > now() AS leased,
                  last_error_code IS NOT NULL AND next_attempt_at > now() AS backing_off
                FROM public.device_location_sync_state
                WHERE device_id = %s AND user_id = %s AND provisioning_session_id = %s
                FOR UPDATE
                """,
                (self.settings.premium_location_freshness_seconds,
                 device_id, user_id, session_id),
            )
            state = await cursor.fetchone()
            if state is None or state["fresh"] or state["backing_off"]:
                return False
            if state["leased"] or (state["priority"] == 10 and state["requested_at"]):
                logger.info("location_refresh_coalesced device=%s", device_id)
                return True
            if not await consume_rate_limit(
                connection, scope=f"premium:{user_id}",
                limit=self.settings.location_premium_user_limit_per_minute,
            ):
                logger.info("location_refresh_rate_limited device=%s", device_id)
                return False
            await connection.execute(
                """
                UPDATE public.device_location_sync_state
                   SET priority = 10, reason = 'premium_request', requested_at = now(),
                       last_accessed_at = now(), next_attempt_at = now(), updated_at = now()
                 WHERE device_id = %s AND user_id = %s AND provisioning_session_id = %s
                """,
                (device_id, user_id, session_id),
            )
        logger.info("location_refresh_requested device=%s reason=premium_request", device_id)
        return True

    async def snapshot(
        self, *, user_id: UUID, device_id: UUID, session_id: UUID
    ) -> dict | None:
        async with self.database.transaction() as connection:
            # Throttling this activity marker avoids a write on every poll.
            await connection.execute(
                """
                UPDATE public.device_location_sync_state SET last_accessed_at = now()
                 WHERE device_id = %s AND user_id = %s AND provisioning_session_id = %s
                   AND last_accessed_at < now() - interval '5 minutes'
                """,
                (device_id, user_id, session_id),
            )
            cursor = await connection.execute(
                """
                SELECT last_success_at, last_error_code, lease_owner, lease_expires_at,
                       next_attempt_at, requested_at, last_attempt_at, failed_at,
                       priority, reason, attempt_count,
                       ((lease_owner IS NOT NULL AND lease_expires_at > now())
                        OR (priority = 10 AND requested_at IS NOT NULL
                            AND next_attempt_at <= now())) AS refreshing
                  FROM public.device_location_sync_state
                 WHERE device_id = %s AND user_id = %s AND provisioning_session_id = %s
                """,
                (device_id, user_id, session_id),
            )
            row = await cursor.fetchone()
        return dict(row) if row is not None else None
