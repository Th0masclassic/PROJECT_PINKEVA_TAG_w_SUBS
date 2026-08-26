from __future__ import annotations

import asyncio
import logging
import os
import socket
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Mapping
from uuid import UUID, uuid4

import requests
from psycopg import AsyncConnection

from .database import Database
from .models import (
    MobilePushTokenRegistration,
    MobilePushTokenResponse,
    UserNotificationListResponse,
    UserNotificationReadResponse,
    UserNotificationSummary,
)


logger = logging.getLogger("pinqeva.notifications")
EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send"


class NotificationError(RuntimeError):
    def __init__(self, code: str, status_code: int) -> None:
        super().__init__(code)
        self.code = code
        self.status_code = status_code


class RetryablePushError(RuntimeError):
    pass


class PermanentPushError(RuntimeError):
    pass


@dataclass(frozen=True)
class NotificationJob:
    id: UUID
    user_id: UUID
    device_id: UUID
    kind: str
    period_end: datetime
    cancel_at_period_end: bool
    device_name: str
    attempt_count: int


@dataclass(frozen=True)
class PushResult:
    disabled_tokens: tuple[str, ...] = ()


def notification_copy(
    kind: str,
    *,
    device_name: str,
    cancel_at_period_end: bool,
) -> tuple[str, str]:
    name = " ".join(device_name.split())[:80] or "Your Pinkeva tag"
    if kind == "renewal_7_days":
        if cancel_at_period_end:
            return (
                "Subscription ends in one week",
                f"{name} will stop tracking in one week unless you resume its subscription.",
            )
        return (
            "Subscription renews in one week",
            f"{name} is scheduled to renew automatically in one week.",
        )
    if kind == "renewal_1_day":
        if cancel_at_period_end:
            return (
                "Subscription ends tomorrow",
                f"{name} will stop tracking tomorrow unless you resume its subscription.",
            )
        return (
            "Subscription renews tomorrow",
            f"{name} is scheduled to renew automatically tomorrow.",
        )
    if kind == "expired":
        return (
            "Subscription expired",
            f"{name} has stopped its Find My broadcast. Renew and update the tag to resume tracking.",
        )
    if kind == "tag_sync_required":
        return (
            "Renewal ready — update your tag",
            f"Hold the button on {name} for 5 seconds, then open its subscription to install the new date.",
        )
    raise ValueError("Unsupported notification kind")


class NotificationService:
    async def register_push_token(
        self,
        connection: AsyncConnection,
        *,
        user_id: UUID,
        registration: MobilePushTokenRegistration,
    ) -> MobilePushTokenResponse:
        # A physical Expo destination belongs to the currently signed-in
        # account only. Disable an old account binding before upserting this
        # installation so sign-out/sign-in cannot duplicate private notices.
        await connection.execute(
            """
            UPDATE public.mobile_push_token
               SET enabled = false, updated_at = now()
             WHERE expo_push_token = %s
               AND (user_id <> %s OR installation_id <> %s)
               AND enabled = true
            """,
            (
                registration.expo_push_token,
                user_id,
                registration.installation_id,
            ),
        )
        await connection.execute(
            """
            INSERT INTO public.mobile_push_token (
                user_id, installation_id, expo_push_token, platform
            ) VALUES (%s, %s, %s, %s)
            ON CONFLICT (user_id, installation_id) DO UPDATE SET
                expo_push_token = EXCLUDED.expo_push_token,
                platform = EXCLUDED.platform,
                enabled = true,
                last_error_code = NULL,
                updated_at = now()
            """,
            (
                user_id,
                registration.installation_id,
                registration.expo_push_token,
                registration.platform,
            ),
        )
        await connection.execute(
            """
            UPDATE public.user_notification
               SET push_status = 'pending',
                   next_attempt_at = now(),
                   last_error_code = NULL,
                   updated_at = now()
             WHERE user_id = %s
               AND push_status = 'no_tokens'
               AND created_at >= now() - interval '30 days'
            """,
            (user_id,),
        )
        return MobilePushTokenResponse(
            installation_id=registration.installation_id,
            status="active",
        )

    async def remove_push_token(
        self,
        connection: AsyncConnection,
        *,
        user_id: UUID,
        installation_id: UUID,
    ) -> MobilePushTokenResponse:
        await connection.execute(
            """
            UPDATE public.mobile_push_token
               SET enabled = false, updated_at = now()
             WHERE user_id = %s AND installation_id = %s
            """,
            (user_id, installation_id),
        )
        return MobilePushTokenResponse(
            installation_id=installation_id,
            status="removed",
        )

    async def list_notifications(
        self,
        connection: AsyncConnection,
        *,
        user_id: UUID,
        limit: int,
    ) -> UserNotificationListResponse:
        query = await connection.execute(
            """
            SELECT notification.id, notification.device_id,
                   notification.kind, notification.period_end,
                   notification.created_at, notification.read_at,
                   subscription.cancel_at_period_end,
                   COALESCE(NULLIF(BTRIM(device.name), ''),
                            device.serial_number) AS device_name
              FROM public.user_notification notification
              JOIN public.subscription subscription
                ON subscription.id = notification.subscription_id
              JOIN public.device device
                ON device.id = notification.device_id
             WHERE notification.user_id = %s
             ORDER BY notification.created_at DESC, notification.id DESC
             LIMIT %s
            """,
            (user_id, limit),
        )
        rows = await query.fetchall()
        notifications: list[UserNotificationSummary] = []
        for row in rows:
            title, body = notification_copy(
                row["kind"],
                device_name=row["device_name"],
                cancel_at_period_end=bool(row["cancel_at_period_end"]),
            )
            notifications.append(
                UserNotificationSummary(
                    id=row["id"],
                    device_id=row["device_id"],
                    kind=row["kind"],
                    period_end=row["period_end"],
                    title=title,
                    body=body,
                    created_at=row["created_at"],
                    read_at=row["read_at"],
                )
            )
        return UserNotificationListResponse(notifications=notifications)

    async def mark_read(
        self,
        connection: AsyncConnection,
        *,
        user_id: UUID,
        notification_id: UUID,
    ) -> UserNotificationReadResponse:
        query = await connection.execute(
            """
            UPDATE public.user_notification
               SET read_at = COALESCE(read_at, now()), updated_at = now()
             WHERE id = %s AND user_id = %s
         RETURNING id
            """,
            (notification_id, user_id),
        )
        row = await query.fetchone()
        if row is None:
            raise NotificationError("NOTIFICATION_NOT_FOUND", 404)
        return UserNotificationReadResponse(id=row["id"], status="read")


class ExpoPushGateway:
    def __init__(self, access_token: str = "") -> None:
        self.access_token = access_token

    async def send(
        self,
        tokens: list[str],
        *,
        title: str,
        body: str,
        data: Mapping[str, str],
    ) -> PushResult:
        if not tokens:
            return PushResult()
        messages = [
            {
                "to": token,
                "sound": "default",
                "title": title,
                "body": body,
                "data": dict(data),
                "priority": "high",
                "channelId": "subscription-renewals",
            }
            for token in tokens
        ]
        headers = {
            "Accept": "application/json",
            "Content-Type": "application/json",
            "Accept-Encoding": "gzip, deflate",
        }
        if self.access_token:
            headers["Authorization"] = f"Bearer {self.access_token}"
        try:
            response = await asyncio.to_thread(
                requests.post,
                EXPO_PUSH_URL,
                headers=headers,
                json=messages,
                timeout=15,
            )
        except (requests.Timeout, requests.ConnectionError, OSError):
            raise RetryablePushError("PUSH_NETWORK") from None
        if response.status_code == 429 or response.status_code >= 500:
            raise RetryablePushError("PUSH_TEMPORARY")
        if not 200 <= response.status_code < 300:
            raise PermanentPushError("PUSH_REJECTED")
        try:
            payload = response.json()
        except ValueError:
            raise RetryablePushError("PUSH_INVALID_RESPONSE") from None
        tickets = payload.get("data") if isinstance(payload, Mapping) else None
        if not isinstance(tickets, list) or len(tickets) != len(tokens):
            raise RetryablePushError("PUSH_INVALID_RESPONSE")

        disabled: list[str] = []
        for token, ticket in zip(tokens, tickets, strict=True):
            if not isinstance(ticket, Mapping):
                raise RetryablePushError("PUSH_INVALID_RESPONSE")
            if ticket.get("status") == "ok":
                continue
            details = ticket.get("details")
            provider_error = (
                details.get("error") if isinstance(details, Mapping) else None
            )
            if provider_error == "DeviceNotRegistered":
                disabled.append(token)
                continue
            raise PermanentPushError("PUSH_PROVIDER_REJECTED")
        return PushResult(disabled_tokens=tuple(disabled))


class NotificationWorker:
    def __init__(
        self,
        database: Database,
        gateway: ExpoPushGateway,
        *,
        poll_interval_seconds: int,
        worker_id: str | None = None,
    ) -> None:
        self.database = database
        self.gateway = gateway
        self.poll_interval_seconds = poll_interval_seconds
        generated = f"{socket.gethostname()[:48]}:{os.getpid()}:{uuid4().hex[:12]}"
        self.worker_id = (worker_id or generated)[:128]

    async def schedule_due(self) -> int:
        async with self.database.transaction() as connection:
            await connection.execute(
                """
                UPDATE public.user_notification notification
                   SET push_status = 'skipped',
                       lease_owner = NULL,
                       lease_expires_at = NULL,
                       updated_at = now()
                 WHERE notification.kind = 'tag_sync_required'
                   AND notification.push_status IN (
                       'pending', 'retry', 'processing'
                   )
                   AND EXISTS (
                     SELECT 1
                       FROM public.device_entitlement_sync sync
                      WHERE sync.subscription_id =
                            notification.subscription_id
                        AND sync.device_id = notification.device_id
                        AND sync.entitlement_expires_at =
                            notification.period_end
                        AND sync.status = 'installed'
                   )
                """
            )
            inserted = 0
            schedules = (
                (
                    "renewal_7_days",
                    "subscription.current_period_end > now() + interval '1 day' "
                    "AND subscription.current_period_end <= now() + interval '7 days'",
                    "subscription.current_period_end - interval '7 days'",
                    "subscription.status IN ('active', 'trialing')",
                ),
                (
                    "renewal_1_day",
                    "subscription.current_period_end > now() "
                    "AND subscription.current_period_end <= now() + interval '1 day'",
                    "subscription.current_period_end - interval '1 day'",
                    "subscription.status IN ('active', 'trialing')",
                ),
                (
                    "expired",
                    "subscription.current_period_end <= now()",
                    "subscription.current_period_end",
                    "subscription.status IN ("
                    "'active', 'trialing', 'past_due', 'unpaid', 'paused', "
                    "'cancelled', 'ended', 'incomplete_expired'"
                    ")",
                ),
            )
            for kind, timing, due_expression, status_filter in schedules:
                query = await connection.execute(
                    f"""
                    INSERT INTO public.user_notification (
                        user_id, device_id, subscription_id, kind,
                        period_end, due_at
                    )
                    SELECT subscription.user_id, subscription.device_id,
                           subscription.id, %s,
                           subscription.current_period_end,
                           {due_expression}
                      FROM public.subscription subscription
                     WHERE {status_filter}
                       AND {timing}
                    ON CONFLICT (subscription_id, kind, period_end) DO NOTHING
                    RETURNING id
                    """,
                    (kind,),
                )
                inserted += len(await query.fetchall())

            sync_query = await connection.execute(
                """
                INSERT INTO public.user_notification (
                    user_id, device_id, subscription_id, kind,
                    period_end, due_at
                )
                SELECT sync.user_id, sync.device_id, sync.subscription_id,
                       'tag_sync_required', sync.entitlement_expires_at,
                       sync.created_at + interval '10 minutes'
                  FROM public.device_entitlement_sync sync
                  JOIN public.subscription subscription
                    ON subscription.id = sync.subscription_id
                   AND subscription.device_id = sync.device_id
                   AND subscription.current_period_end =
                       sync.entitlement_expires_at
                 WHERE sync.status <> 'installed'
                   AND sync.created_at <= now() - interval '10 minutes'
                   AND subscription.status IN ('active', 'trialing')
                ON CONFLICT (subscription_id, kind, period_end) DO NOTHING
                RETURNING id
                """
            )
            inserted += len(await sync_query.fetchall())
            return inserted

    async def claim_due(self, batch_size: int = 25) -> list[NotificationJob]:
        async with self.database.transaction() as connection:
            query = await connection.execute(
                """
                WITH due AS (
                    SELECT notification.id
                      FROM public.user_notification notification
                     WHERE (
                         notification.push_status IN ('pending', 'retry')
                         AND notification.next_attempt_at <= now()
                         AND notification.due_at <= now()
                     ) OR (
                         notification.push_status = 'processing'
                         AND notification.lease_expires_at <= now()
                     )
                     ORDER BY notification.due_at, notification.id
                     FOR UPDATE OF notification SKIP LOCKED
                     LIMIT %s
                )
                UPDATE public.user_notification notification
                   SET push_status = 'processing',
                       attempt_count = notification.attempt_count + 1,
                       lease_owner = %s,
                       lease_expires_at = now() + interval '2 minutes',
                       updated_at = now()
                  FROM due, public.subscription subscription,
                       public.device device
                 WHERE notification.id = due.id
                   AND subscription.id = notification.subscription_id
                   AND device.id = notification.device_id
                RETURNING notification.id, notification.user_id,
                          notification.device_id, notification.kind,
                          notification.period_end,
                          subscription.cancel_at_period_end,
                          COALESCE(NULLIF(BTRIM(device.name), ''),
                                   device.serial_number) AS device_name,
                          notification.attempt_count
                """,
                (batch_size, self.worker_id),
            )
            rows = await query.fetchall()
        return [
            NotificationJob(
                id=row["id"],
                user_id=row["user_id"],
                device_id=row["device_id"],
                kind=row["kind"],
                period_end=row["period_end"],
                cancel_at_period_end=bool(row["cancel_at_period_end"]),
                device_name=row["device_name"],
                attempt_count=int(row["attempt_count"]),
            )
            for row in rows
        ]

    async def _tokens(self, job: NotificationJob) -> list[str]:
        async with self.database.transaction() as connection:
            query = await connection.execute(
                """
                SELECT expo_push_token
                  FROM public.mobile_push_token
                 WHERE user_id = %s AND enabled = true
                 ORDER BY created_at
                 LIMIT 100
                """,
                (job.user_id,),
            )
            return [row["expo_push_token"] for row in await query.fetchall()]

    async def _finish(
        self,
        job: NotificationJob,
        *,
        status: str,
        error_code: str | None = None,
        retry_seconds: int | None = None,
        disabled_tokens: tuple[str, ...] = (),
    ) -> None:
        async with self.database.transaction() as connection:
            if disabled_tokens:
                await connection.execute(
                    """
                    UPDATE public.mobile_push_token
                       SET enabled = false,
                           last_error_code = 'DEVICE_NOT_REGISTERED',
                           updated_at = now()
                     WHERE expo_push_token = ANY(%s)
                    """,
                    (list(disabled_tokens),),
                )
            await connection.execute(
                """
                UPDATE public.user_notification
                   SET push_status = %s,
                       next_attempt_at = CASE
                         WHEN %s IS NULL THEN next_attempt_at
                         ELSE now() + (%s * interval '1 second')
                       END,
                       lease_owner = NULL,
                       lease_expires_at = NULL,
                       last_error_code = %s,
                       pushed_at = CASE WHEN %s = 'sent' THEN now()
                                        ELSE pushed_at END,
                       updated_at = now()
                 WHERE id = %s
                   AND push_status = 'processing'
                   AND lease_owner = %s
                """,
                (
                    status,
                    retry_seconds,
                    retry_seconds,
                    error_code,
                    status,
                    job.id,
                    self.worker_id,
                ),
            )

    async def process(self, job: NotificationJob) -> None:
        tokens = await self._tokens(job)
        if not tokens:
            await self._finish(job, status="no_tokens")
            return
        title, body = notification_copy(
            job.kind,
            device_name=job.device_name,
            cancel_at_period_end=job.cancel_at_period_end,
        )
        try:
            result = await self.gateway.send(
                tokens,
                title=title,
                body=body,
                data={
                    "kind": job.kind,
                    "deviceId": str(job.device_id),
                    "periodEnd": job.period_end.isoformat(),
                    "route": "subscription",
                },
            )
        except RetryablePushError as exc:
            if job.attempt_count >= 8:
                await self._finish(
                    job, status="failed", error_code="PUSH_RETRY_EXHAUSTED"
                )
                return
            delay = min(3600, 30 * (2 ** max(0, job.attempt_count - 1)))
            await self._finish(
                job,
                status="retry",
                error_code=str(exc),
                retry_seconds=delay,
            )
            return
        except PermanentPushError as exc:
            await self._finish(job, status="failed", error_code=str(exc))
            return
        await self._finish(
            job,
            status="sent",
            disabled_tokens=result.disabled_tokens,
        )

    async def run_once(self) -> int:
        scheduled = await self.schedule_due()
        jobs = await self.claim_due()
        for job in jobs:
            await self.process(job)
        return scheduled + len(jobs)

    async def run(self, stop_event: asyncio.Event) -> None:
        logger.info("renewal_notification_worker_started")
        try:
            while not stop_event.is_set():
                try:
                    processed = await self.run_once()
                except Exception as exc:
                    logger.error(
                        "renewal_notification_cycle_failed type=%s",
                        type(exc).__name__,
                    )
                    processed = 0
                if processed:
                    continue
                try:
                    await asyncio.wait_for(
                        stop_event.wait(), timeout=self.poll_interval_seconds
                    )
                except TimeoutError:
                    pass
        finally:
            logger.info("renewal_notification_worker_stopped")
