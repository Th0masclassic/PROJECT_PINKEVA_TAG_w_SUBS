from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, Mapping
from uuid import uuid4

import pytest

from app.notifications import (
    ExpoPushGateway,
    NotificationJob,
    NotificationWorker,
    PushResult,
    RetryablePushError,
    notification_copy,
)


class Response:
    def __init__(self, status_code: int, payload: Any) -> None:
        self.status_code = status_code
        self.payload = payload

    def json(self) -> Any:
        return self.payload


def job(*, attempt_count: int = 1) -> NotificationJob:
    return NotificationJob(
        id=uuid4(),
        user_id=uuid4(),
        device_id=uuid4(),
        kind="renewal_1_day",
        period_end=datetime(2026, 9, 26, tzinfo=UTC),
        cancel_at_period_end=False,
        device_name="Wallet",
        title=None,
        body=None,
        attempt_count=attempt_count,
    )


class CapturingWorker(NotificationWorker):
    def __init__(self, tokens: list[str], gateway: Any) -> None:
        self.tokens = tokens
        self.gateway = gateway
        self.finishes: list[dict[str, Any]] = []

    async def _tokens(self, notification: NotificationJob) -> list[str]:
        return self.tokens

    async def _premium_access_active(self, notification: NotificationJob) -> bool:
        return True

    async def _finish(
        self, notification: NotificationJob, **values: Any
    ) -> None:
        self.finishes.append(values)


def test_notification_copy_covers_renewal_end_and_expiry() -> None:
    assert notification_copy(
        "renewal_7_days", device_name="Keys", cancel_at_period_end=False
    ) == (
        "Subscription renews in one week",
        "Keys is scheduled to renew automatically in one week.",
    )
    assert notification_copy(
        "renewal_1_day", device_name="Keys", cancel_at_period_end=True
    ) == (
        "Subscription ends tomorrow",
        "Pinkeva cloud services for Keys will pause tomorrow unless you resume its subscription.",
    )
    assert "Cloud location" in notification_copy(
        "expired", device_name="Keys", cancel_at_period_end=True
    )[1]


@pytest.mark.asyncio
async def test_expo_gateway_disables_only_unregistered_destination(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    first = "ExpoPushToken[first_token]"
    stale = "ExpoPushToken[stale_token]"
    captured: dict[str, Any] = {}

    def post(url: str, **kwargs: Any) -> Response:
        captured.update(url=url, **kwargs)
        return Response(
            200,
            {
                "data": [
                    {"status": "ok", "id": "ticket-1"},
                    {
                        "status": "error",
                        "details": {"error": "DeviceNotRegistered"},
                    },
                ]
            },
        )

    monkeypatch.setattr("app.notifications.requests.post", post)
    result = await ExpoPushGateway("push-access-token").send(
        [first, stale],
        title="Renewal",
        body="Update the tag",
        data={"route": "subscription"},
    )

    assert result == PushResult(disabled_tokens=(stale,))
    assert captured["headers"]["Authorization"] == "Bearer push-access-token"
    assert [message["to"] for message in captured["json"]] == [first, stale]
    assert captured["json"][0]["data"] == {"route": "subscription"}
    assert captured["json"][0]["channelId"] == "pinkeva-notifications"


@pytest.mark.asyncio
async def test_expo_gateway_retries_rate_limit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "app.notifications.requests.post",
        lambda *args, **kwargs: Response(429, {}),
    )
    with pytest.raises(RetryablePushError):
        await ExpoPushGateway().send(
            ["ExpoPushToken[token]"], title="A", body="B", data={}
        )


@pytest.mark.asyncio
async def test_worker_records_no_token_and_exponential_retry() -> None:
    no_token_worker = CapturingWorker([], object())
    await no_token_worker.process(job())
    assert no_token_worker.finishes == [{"status": "no_tokens"}]

    class TemporaryGateway:
        async def send(
            self,
            tokens: list[str],
            *,
            title: str,
            body: str,
            data: Mapping[str, str],
        ) -> PushResult:
            raise RetryablePushError("PUSH_NETWORK")

    retry_worker = CapturingWorker(
        ["ExpoPushToken[token]"], TemporaryGateway()
    )
    await retry_worker.process(job(attempt_count=3))
    assert retry_worker.finishes == [
        {
            "status": "retry",
            "error_code": "PUSH_NETWORK",
            "retry_seconds": 120,
        }
    ]

    exhausted_worker = CapturingWorker(
        ["ExpoPushToken[token]"], TemporaryGateway()
    )
    await exhausted_worker.process(job(attempt_count=8))
    assert exhausted_worker.finishes == [
        {"status": "failed", "error_code": "PUSH_RETRY_EXHAUSTED"}
    ]


@pytest.mark.asyncio
async def test_worker_delivers_admin_message_to_the_notification_inbox_route() -> None:
    captured: dict[str, Any] = {}

    class Gateway:
        async def send(
            self,
            tokens: list[str],
            *,
            title: str,
            body: str,
            data: Mapping[str, str],
        ) -> PushResult:
            captured.update(tokens=tokens, title=title, body=body, data=dict(data))
            return PushResult()

    worker = CapturingWorker(["ExpoPushToken[token]"], Gateway())
    await worker.process(
        NotificationJob(
            id=uuid4(),
            user_id=uuid4(),
            device_id=None,
            kind="admin_message",
            period_end=None,
            cancel_at_period_end=False,
            device_name="Your Pinkeva tag",
            title="A helpful update",
            body="Please open Pinkeva when you have a moment.",
            attempt_count=1,
        )
    )

    assert captured == {
        "tokens": ["ExpoPushToken[token]"],
        "title": "A helpful update",
        "body": "Please open Pinkeva when you have a moment.",
        "data": {"kind": "admin_message", "route": "notifications"},
    }
    assert worker.finishes == [{"status": "sent", "disabled_tokens": ()}]


@pytest.mark.asyncio
async def test_worker_routes_premium_tracker_alerts_to_the_tracker() -> None:
    captured: dict[str, Any] = {}
    device_id = uuid4()

    class Gateway:
        async def send(
            self,
            tokens: list[str],
            *,
            title: str,
            body: str,
            data: Mapping[str, str],
        ) -> PushResult:
            captured.update(tokens=tokens, title=title, body=body, data=dict(data))
            return PushResult()

    worker = CapturingWorker(["ExpoPushToken[token]"], Gateway())
    await worker.process(
        NotificationJob(
            id=uuid4(),
            user_id=uuid4(),
            device_id=device_id,
            kind="separation_detected",
            period_end=None,
            cancel_at_period_end=False,
            device_name="Keys",
            title="Left Home",
            body="Keys left Home.",
            attempt_count=1,
        )
    )

    assert captured["title"] == "Left Home"
    assert captured["body"] == "Keys left Home."
    assert captured["data"] == {
        "kind": "separation_detected",
        "route": "tracker",
        "deviceId": str(device_id),
    }


@pytest.mark.asyncio
async def test_worker_skips_queued_premium_alert_after_subscription_expiry() -> None:
    class ExpiredWorker(CapturingWorker):
        async def _premium_access_active(
            self, notification: NotificationJob
        ) -> bool:
            return False

    worker = ExpiredWorker(["ExpoPushToken[token]"], object())
    await worker.process(
        NotificationJob(
            id=uuid4(),
            user_id=uuid4(),
            device_id=uuid4(),
            kind="separation_detected",
            period_end=None,
            cancel_at_period_end=False,
            device_name="Keys",
            title="Tracker separated",
            body="Keys may have been left behind.",
            attempt_count=1,
            subscription_id=uuid4(),
        )
    )

    assert worker.finishes == [
        {"status": "skipped", "error_code": "SUBSCRIPTION_ENDED"}
    ]
