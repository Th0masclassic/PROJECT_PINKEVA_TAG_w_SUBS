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
        kind="tag_sync_required",
        period_end=datetime(2026, 9, 26, tzinfo=UTC),
        cancel_at_period_end=False,
        device_name="Wallet",
        attempt_count=attempt_count,
    )


class CapturingWorker(NotificationWorker):
    def __init__(self, tokens: list[str], gateway: Any) -> None:
        self.tokens = tokens
        self.gateway = gateway
        self.finishes: list[dict[str, Any]] = []

    async def _tokens(self, notification: NotificationJob) -> list[str]:
        return self.tokens

    async def _finish(
        self, notification: NotificationJob, **values: Any
    ) -> None:
        self.finishes.append(values)


def test_notification_copy_covers_renewal_end_expiry_and_tag_update() -> None:
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
        "Keys will stop tracking tomorrow unless you resume its subscription.",
    )
    assert "stopped" in notification_copy(
        "expired", device_name="Keys", cancel_at_period_end=True
    )[1]
    assert "5 seconds" in notification_copy(
        "tag_sync_required", device_name="Keys", cancel_at_period_end=False
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
    assert captured["json"][0]["channelId"] == "subscription-renewals"


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
