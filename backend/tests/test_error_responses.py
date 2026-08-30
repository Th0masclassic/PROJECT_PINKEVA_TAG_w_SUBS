import json
from contextlib import asynccontextmanager
from typing import AsyncIterator

import pytest
from fastapi import Request
from fastapi.exceptions import RequestValidationError

from app.main import (
    _read_limited_body,
    app,
    provisioning_error_handler,
    readiness,
    unexpected_error_handler,
    validation_error_handler,
)
from app.billing import BillingError
from app.service import ProvisioningError


def request_with_id() -> Request:
    request = Request(
        {
            "type": "http",
            "method": "POST",
            "path": "/v1/devices/claim",
            "headers": [],
        }
    )
    request.state.request_id = "safe-correlation-id"
    return request


def test_subscription_routes_are_account_scoped_only() -> None:
    paths = {
        route.path for route in app.routes if hasattr(route, "path")
    }

    assert {
        "/v1/subscription",
        "/v1/subscription/checkout",
        "/v1/subscription/portal",
    } <= paths
    assert "/v1/devices/{device_id}/subscription" not in paths
    assert "/v1/devices/{device_id}/subscription/checkout" not in paths
    assert "/v1/devices/{device_id}/subscription/portal" not in paths


class ReadinessConnection:
    def __init__(self, error: Exception | None = None) -> None:
        self.error = error
        self.queries: list[str] = []

    async def execute(self, query: str) -> None:
        self.queries.append(query)
        if self.error is not None:
            raise self.error


class ReadinessDatabase:
    def __init__(self, connection: ReadinessConnection) -> None:
        self.connection = connection

    @asynccontextmanager
    async def transaction(self) -> AsyncIterator[ReadinessConnection]:
        yield self.connection


@pytest.mark.asyncio
async def test_validation_response_never_echoes_input() -> None:
    secret = "private-token-that-must-not-be-returned"
    error = RequestValidationError(
        [
            {
                "type": "string_too_short",
                "loc": ("body", "claim_completion_token_base64url"),
                "msg": "Value is too short",
                "input": secret,
            }
        ],
        body={"claim_completion_token_base64url": secret},
    )

    response = await validation_error_handler(request_with_id(), error)
    payload = json.loads(response.body)

    assert response.status_code == 422
    assert payload["error"]["code"] == "INVALID_REQUEST"
    assert payload["error"]["request_id"] == "safe-correlation-id"
    assert secret.encode() not in response.body


@pytest.mark.asyncio
async def test_domain_response_uses_safe_message_not_internal_message() -> None:
    internal = "operator recovery row 44 contains a mismatched private key"
    error = ProvisioningError("RECOVERY_REQUIRED", internal, 409)

    response = await provisioning_error_handler(request_with_id(), error)

    assert response.status_code == 409
    assert internal.encode() not in response.body
    assert b"This tag needs support" in response.body


@pytest.mark.asyncio
async def test_unexpected_response_hides_exception_detail() -> None:
    internal = "postgresql://admin:password@private-host/database"

    response = await unexpected_error_handler(
        request_with_id(), RuntimeError(internal)
    )

    assert response.status_code == 500
    assert internal.encode() not in response.body
    assert b"INTERNAL_ERROR" in response.body


@pytest.mark.asyncio
async def test_readiness_checks_the_database(monkeypatch: pytest.MonkeyPatch) -> None:
    connection = ReadinessConnection()
    monkeypatch.setattr(
        app.state, "database", ReadinessDatabase(connection), raising=False
    )

    response = await readiness(request_with_id())

    assert response == {"status": "ready"}
    assert connection.queries == ["SELECT 1"]


@pytest.mark.asyncio
async def test_readiness_failure_is_sanitized(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    internal = "postgresql://admin:secret@private-database.example/postgres"
    connection = ReadinessConnection(RuntimeError(internal))
    monkeypatch.setattr(
        app.state, "database", ReadinessDatabase(connection), raising=False
    )
    caplog.set_level("WARNING", logger="pinqeva.api")

    response = await readiness(request_with_id())
    payload = json.loads(response.body)

    assert response.status_code == 503
    assert payload["error"] == {
        "code": "SERVICE_UNAVAILABLE",
        "message": "The service is temporarily unavailable. Please try again.",
        "request_id": "safe-correlation-id",
    }
    assert response.headers["X-Request-ID"] == "safe-correlation-id"
    assert internal.encode() not in response.body
    assert internal not in caplog.text


@pytest.mark.asyncio
async def test_webhook_body_limit_is_enforced_while_streaming() -> None:
    messages = iter(
        [
            {"type": "http.request", "body": b"1234", "more_body": True},
            {"type": "http.request", "body": b"5678", "more_body": True},
            {"type": "http.request", "body": b"never-read", "more_body": False},
        ]
    )
    receive_count = 0

    async def receive():
        nonlocal receive_count
        receive_count += 1
        return next(messages)

    request = Request(
        {
            "type": "http",
            "method": "POST",
            "path": "/v1/billing/stripe/webhook",
            "headers": [],
        },
        receive,
    )

    with pytest.raises(BillingError) as error:
        await _read_limited_body(request, 5)

    assert error.value.code == "INVALID_WEBHOOK"
    assert receive_count == 2
