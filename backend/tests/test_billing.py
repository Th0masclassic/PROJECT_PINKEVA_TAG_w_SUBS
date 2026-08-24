from __future__ import annotations

import hashlib
import os
import uuid
from copy import deepcopy
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from typing import Any, AsyncIterator

import pytest
from psycopg.errors import UniqueViolation
from pydantic import ValidationError

from app.billing import (
    BillingError,
    BillingEventDeferred,
    BillingService,
    CheckoutPreparation,
    PortalPreparation,
    StripeGateway,
    _safe_stripe_url,
)
from app.config import Settings
from app.models import SubscriptionPortalRequest


class Cursor:
    def __init__(self, result: Any = None) -> None:
        self.result = result

    async def fetchone(self) -> Any:
        if isinstance(self.result, list):
            return self.result[0] if self.result else None
        return self.result

    async def fetchall(self) -> list[Any]:
        if isinstance(self.result, list):
            return self.result
        return [] if self.result is None else [self.result]


class ScriptedConnection:
    def __init__(self, steps: list[tuple[str, Any]]) -> None:
        self.steps = list(steps)
        self.executions: list[tuple[str, tuple[Any, ...]]] = []

    async def execute(self, query: str, parameters: tuple[Any, ...] = ()) -> Cursor:
        normalized = " ".join(query.split())
        self.executions.append((normalized, parameters))
        if not self.steps:
            raise AssertionError(f"Unexpected query: {normalized}")
        expected, result = self.steps.pop(0)
        assert expected in normalized
        if isinstance(result, Exception):
            raise result
        return Cursor(result)


class FakeDatabase:
    def __init__(self, connection: ScriptedConnection) -> None:
        self.connection = connection

    @asynccontextmanager
    async def transaction(self) -> AsyncIterator[ScriptedConnection]:
        yield self.connection


class FakeGateway:
    def __init__(self) -> None:
        self.customer_calls: list[uuid.UUID] = []
        self.checkout_calls: list[tuple[CheckoutPreparation, str]] = []
        self.portal_calls: list[PortalPreparation] = []
        self.event: dict[str, Any] | None = None
        self.checkout_error: Exception | None = None
        self.construct_calls: list[tuple[bytes, str]] = []
        self.retrieve_checkout_calls: list[str] = []
        self.expire_checkout_calls: list[str] = []
        self.cancel_calls: list[str] = []
        self.authoritative_checkout: dict[str, Any] | None = None
        self.authoritative_subscription: dict[str, Any] | None = None
        self.authoritative_invoice: dict[str, Any] | None = None

    async def create_customer(self, user_id: uuid.UUID) -> dict[str, Any]:
        self.customer_calls.append(user_id)
        return {"id": "cus_12345678"}

    async def create_checkout_session(
        self, preparation: CheckoutPreparation, customer_id: str
    ) -> dict[str, Any]:
        self.checkout_calls.append((preparation, customer_id))
        if self.checkout_error is not None:
            raise self.checkout_error
        result = {
            "id": "cs_test_12345678",
            "customer": customer_id,
            "url": "https://checkout.stripe.com/c/pay/test_session",
            "expires_at": int(preparation.expires_at.timestamp()),
            "status": "open",
            "mode": "subscription",
            "client_reference_id": str(preparation.reservation_id),
            "metadata": {
                "user_id": str(preparation.user_id),
                "device_id": str(preparation.device_id),
                "plan_code": preparation.plan_code,
                "checkout_id": str(preparation.reservation_id),
            },
            "line_items": {
                "data": [
                    {
                        "quantity": 1,
                        "price": {
                            "id": preparation.price_id,
                            "product": {
                                "id": preparation.product_id,
                                "active": True,
                            },
                        },
                    }
                ]
            },
            "success_url": "https://app.pinkeva.com/billing/success",
            "cancel_url": "https://app.pinkeva.com/billing/cancelled",
            "subscription": None,
        }
        self.authoritative_checkout = result
        return result

    async def retrieve_checkout_session(self, session_id: str) -> dict[str, Any]:
        self.retrieve_checkout_calls.append(session_id)
        assert self.authoritative_checkout is not None
        return self.authoritative_checkout

    async def expire_checkout_session(self, session_id: str) -> dict[str, Any]:
        self.expire_checkout_calls.append(session_id)
        assert self.authoritative_checkout is not None
        self.authoritative_checkout = {
            **self.authoritative_checkout,
            "status": "expired",
            "url": None,
        }
        return self.authoritative_checkout

    async def retrieve_price(self, price_id: str) -> dict[str, Any]:
        if price_id == "price_MONTH1234567":
            product_id = "prod_MONTH1234567"
            interval = "month"
            amount = 299
        elif price_id == "price_YEAR12345678":
            product_id = "prod_YEAR12345678"
            interval = "year"
            amount = 2999
        else:
            raise AssertionError(f"unexpected Price: {price_id}")
        return {
            "id": price_id,
            "active": True,
            "type": "recurring",
            "billing_scheme": "per_unit",
            "unit_amount": amount,
            "currency": "eur",
            "recurring": {
                "interval": interval,
                "interval_count": 1,
                "usage_type": "licensed",
            },
            "product": {"id": product_id, "active": True},
        }

    async def retrieve_subscription(self, subscription_id: str) -> dict[str, Any]:
        assert self.authoritative_subscription is not None
        return self.authoritative_subscription

    async def cancel_subscription(self, subscription_id: str) -> dict[str, Any]:
        self.cancel_calls.append(subscription_id)
        assert self.authoritative_subscription is not None
        self.authoritative_subscription = {
            **self.authoritative_subscription,
            "status": "canceled",
        }
        return self.authoritative_subscription

    async def retrieve_invoice(self, invoice_id: str) -> dict[str, Any]:
        assert self.authoritative_invoice is not None
        return self.authoritative_invoice

    async def create_portal_session(
        self, preparation: PortalPreparation
    ) -> dict[str, Any]:
        self.portal_calls.append(preparation)
        return {"url": "https://billing.stripe.com/p/session/test_session"}

    def construct_event(self, payload: bytes, signature: str) -> dict[str, Any]:
        self.construct_calls.append((payload, signature))
        assert self.event is not None
        return self.event


@pytest.fixture
def settings() -> Settings:
    return Settings(
        database_url="postgresql://unused",
        supabase_jwks_url="https://example.invalid/jwks.json",
        supabase_jwt_issuer="https://example.invalid/auth/v1",
        supabase_jwt_audience="authenticated",
        supabase_jwt_algorithms=("ES256",),
        key_encryption_key=os.urandom(32),
        bootstrap_key_encryption_key=os.urandom(32),
        claim_token_key=os.urandom(32),
        session_ttl_seconds=600,
        claim_ttl_seconds=86_400,
        stripe_secret_key="sk_test_12345678901234567890",
        stripe_webhook_secret="whsec_12345678901234567890",
        stripe_price_map=(
            (
                "monthly_basic",
                "price_MONTH1234567",
                "prod_MONTH1234567",
            ),
            ("yearly_pro", "price_YEAR12345678", "prod_YEAR12345678"),
        ),
        stripe_checkout_success_url="https://app.pinkeva.com/billing/success",
        stripe_checkout_cancel_url="https://app.pinkeva.com/billing/cancelled",
        stripe_portal_return_url="https://app.pinkeva.com/billing/manage/complete",
        stripe_portal_configuration_id="bpc_12345678",
    )


def checkout_steps(customer_id: str = "cus_12345678") -> list[tuple[str, Any]]:
    return [
        ("SELECT p.stripe_customer_id", {"stripe_customer_id": customer_id}),
        ("SELECT 1 FROM public.subscription", None),
        ("SELECT b.id, b.user_id", None),
        (
            "SELECT code, duration_months",
            {
                "code": "monthly_basic",
                "duration_months": 1,
                "price_cents": 299,
                "currency": "EUR",
                "active": True,
                "provider_product_id": "prod_MONTH1234567",
            },
        ),
        ("INSERT INTO public.billing_checkout_session", None),
        ("SELECT 1 FROM public.ownership", {"?column?": 1}),
    ]


def checkout_preparation(
    *,
    reservation_id: uuid.UUID,
    user_id: uuid.UUID,
    device_id: uuid.UUID,
    expires_at: datetime,
    provider_session_id: str | None,
    existing: bool,
) -> CheckoutPreparation:
    return CheckoutPreparation(
        reservation_id=reservation_id,
        user_id=user_id,
        device_id=device_id,
        plan_code="monthly_basic",
        price_id="price_MONTH1234567",
        product_id="prod_MONTH1234567",
        amount_minor=299,
        currency="EUR",
        duration_months=1,
        customer_id="cus_12345678",
        expires_at=expires_at,
        provider_session_id=provider_session_id,
        existing=existing,
    )


def subscription_object(
    *,
    user_id: uuid.UUID,
    device_id: uuid.UUID,
    checkout_id: uuid.UUID,
    status: str = "active",
) -> dict[str, Any]:
    now = 1_800_000_000
    return {
        "id": "sub_12345678",
        "customer": "cus_12345678",
        "status": status,
        "cancel_at_period_end": False,
        "metadata": {
            "user_id": str(user_id),
            "device_id": str(device_id),
            "plan_code": "monthly_basic",
            "checkout_id": str(checkout_id),
        },
        "items": {
            "data": [
                {
                    "quantity": 1,
                    "price": {
                        "id": "price_MONTH1234567",
                        "active": True,
                        "type": "recurring",
                        "billing_scheme": "per_unit",
                        "unit_amount": 299,
                        "currency": "eur",
                        "recurring": {
                            "interval": "month",
                            "interval_count": 1,
                            "usage_type": "licensed",
                        },
                        "product": {
                            "id": "prod_MONTH1234567",
                            "active": True,
                        },
                    },
                    "current_period_start": now,
                    "current_period_end": now + 2_592_000,
                }
            ]
        },
    }


@pytest.mark.asyncio
async def test_subscription_status_is_per_tag_and_lists_only_configured_plans(
    settings: Settings,
) -> None:
    device_id = uuid.uuid4()
    connection = ScriptedConnection(
        [
            ("SELECT 1 FROM public.ownership", {"?column?": 1}),
            (
                "SELECT code, name, duration_months",
                [
                    {
                        "code": "monthly_basic",
                        "name": "Monthly",
                        "duration_months": 1,
                        "price_cents": 299,
                        "currency": "EUR",
                        "provider_product_id": "prod_MONTH1234567",
                    },
                    {
                        "code": "not_configured",
                        "name": "Hidden",
                        "duration_months": 1,
                        "price_cents": 1,
                        "currency": "EUR",
                        "provider_product_id": None,
                    },
                ],
            ),
            ("SELECT s.status, s.plan_code", None),
            ("SELECT 1 FROM public.ownership", {"?column?": 1}),
        ]
    )

    response = await BillingService(settings, FakeGateway()).get_device_subscription(
        FakeDatabase(connection),
        user_id=uuid.uuid4(),
        device_id=device_id,
    )

    assert response.device_id == device_id
    assert response.status == "none"
    assert response.plan_code is None
    assert [plan.code for plan in response.available_plans] == ["monthly_basic"]
    assert response.available_plans[0].billing_interval == "month"


@pytest.mark.asyncio
async def test_existing_subscription_uses_its_historical_stripe_price(
    settings: Settings,
) -> None:
    class HistoricalGateway(FakeGateway):
        async def retrieve_price(self, price_id: str) -> dict[str, Any]:
            if price_id == "price_NEWPRICE1234":
                return {
                    **await super().retrieve_price("price_MONTH1234567"),
                    "id": price_id,
                    "unit_amount": 499,
                }
            return await super().retrieve_price(price_id)

    user_id = uuid.uuid4()
    device_id = uuid.uuid4()
    started_at = datetime.now(UTC) - timedelta(days=10)
    period_end = started_at + timedelta(days=30)
    connection = ScriptedConnection(
        [
            ("SELECT 1 FROM public.ownership", {"?column?": 1}),
            (
                "SELECT code, name, duration_months",
                [
                    {
                        "code": "monthly_basic",
                        "name": "Monthly",
                        "duration_months": 1,
                        "price_cents": 499,
                        "currency": "EUR",
                        "provider_price_id": "price_NEWPRICE1234",
                        "provider_product_id": "prod_MONTH1234567",
                    }
                ],
            ),
            (
                "SELECT s.status, s.plan_code",
                {
                    "status": "active",
                    "plan_code": "monthly_basic",
                    "starts_at": started_at,
                    "current_period_end": period_end,
                    "cancel_at_period_end": False,
                    "plan_name": "Monthly",
                    "duration_months": 1,
                    "price_cents": 299,
                    "currency": "EUR",
                    "provider_price_id": "price_MONTH1234567",
                    "provider_product_id": "prod_MONTH1234567",
                    "plan_active": True,
                },
            ),
            ("SELECT 1 FROM public.ownership", {"?column?": 1}),
        ]
    )

    response = await BillingService(
        settings, HistoricalGateway()
    ).get_device_subscription(
        FakeDatabase(connection), user_id=user_id, device_id=device_id
    )

    assert response.amount_minor == 299
    assert response.available_plans[0].amount_minor == 499
    assert "LEFT JOIN public.plan_price_history" in connection.executions[2][0]


@pytest.mark.parametrize(
    "mismatch",
    [
        "amount",
        "currency",
        "recurrence",
        "price_active",
        "product",
        "product_active",
    ],
)
@pytest.mark.asyncio
async def test_plan_catalog_mismatch_fails_closed(
    settings: Settings, mismatch: str
) -> None:
    gateway = FakeGateway()
    price = deepcopy(await gateway.retrieve_price("price_MONTH1234567"))
    if mismatch == "amount":
        price["unit_amount"] = 999
    elif mismatch == "currency":
        price["currency"] = "usd"
    elif mismatch == "recurrence":
        price["recurring"]["interval"] = "year"
    elif mismatch == "price_active":
        price["active"] = False
    elif mismatch == "product":
        price["product"]["id"] = "prod_WRONG12345678"
    else:
        price["product"]["active"] = False

    async def mismatched_price(_: str) -> dict[str, Any]:
        return price

    gateway.retrieve_price = mismatched_price  # type: ignore[method-assign]
    plan = {
        "code": "monthly_basic",
        "duration_months": 1,
        "price_cents": 299,
        "currency": "EUR",
        "provider_product_id": "prod_MONTH1234567",
    }

    with pytest.raises(BillingError) as error:
        await BillingService(settings, gateway)._validate_plan_catalog(plan)

    assert error.value.code == "BILLING_UNAVAILABLE"


@pytest.mark.asyncio
async def test_unsupported_plan_duration_fails_closed(settings: Settings) -> None:
    plan = {
        "code": "monthly_basic",
        "duration_months": 3,
        "price_cents": 299,
        "currency": "EUR",
        "provider_product_id": "prod_MONTH1234567",
    }

    with pytest.raises(BillingError):
        await BillingService(settings, FakeGateway())._validate_plan_catalog(plan)


@pytest.mark.asyncio
async def test_checkout_uses_server_price_and_existing_customer(
    settings: Settings,
) -> None:
    user_id = uuid.uuid4()
    device_id = uuid.uuid4()
    connection = ScriptedConnection(
        checkout_steps()
        + [
            ("SELECT 1 FROM public.ownership", {"?column?": 1}),
            ("UPDATE public.billing_checkout_session", {"id": uuid.uuid4()}),
        ]
    )
    gateway = FakeGateway()

    response = await BillingService(settings, gateway).create_checkout(
        FakeDatabase(connection),
        user_id=user_id,
        device_id=device_id,
        plan_code="monthly_basic",
    )

    assert response.url.startswith("https://checkout.stripe.com/")
    assert gateway.customer_calls == []
    preparation, customer_id = gateway.checkout_calls[0]
    assert preparation.user_id == user_id
    assert preparation.device_id == device_id
    assert preparation.price_id == "price_MONTH1234567"
    assert customer_id == "cus_12345678"
    assert connection.steps == []


@pytest.mark.asyncio
async def test_checkout_creates_one_idempotent_account_customer(
    settings: Settings,
) -> None:
    user_id = uuid.uuid4()
    connection = ScriptedConnection(
            checkout_steps(customer_id=None)
            + [
                ("UPDATE public.profiles", {"stripe_customer_id": "cus_12345678"}),
                ("SELECT 1 FROM public.ownership", {"?column?": 1}),
                ("UPDATE public.billing_checkout_session", {"id": uuid.uuid4()}),
        ]
    )
    gateway = FakeGateway()

    await BillingService(settings, gateway).create_checkout(
        FakeDatabase(connection),
        user_id=user_id,
        device_id=uuid.uuid4(),
        plan_code="monthly_basic",
    )

    assert gateway.customer_calls == [user_id]
    assert gateway.checkout_calls[0][1] == "cus_12345678"


@pytest.mark.asyncio
async def test_concurrent_checkout_is_rejected_before_stripe(
    settings: Settings,
) -> None:
    steps = checkout_steps()
    steps[4] = (
        "INSERT INTO public.billing_checkout_session",
        UniqueViolation("duplicate pending checkout"),
    )
    steps = steps[:5]
    gateway = FakeGateway()

    with pytest.raises(BillingError) as error:
        await BillingService(settings, gateway).create_checkout(
            FakeDatabase(ScriptedConnection(steps)),
            user_id=uuid.uuid4(),
            device_id=uuid.uuid4(),
            plan_code="monthly_basic",
        )

    assert error.value.code == "CHECKOUT_IN_PROGRESS"
    assert gateway.checkout_calls == []


@pytest.mark.asyncio
async def test_post_stripe_database_failure_retains_duplicate_guard(
    settings: Settings,
) -> None:
    connection = ScriptedConnection(
        checkout_steps()
        + [
            ("SELECT 1 FROM public.ownership", {"?column?": 1}),
            (
                "UPDATE public.billing_checkout_session",
                RuntimeError("database temporarily unavailable"),
            )
        ]
    )
    gateway = FakeGateway()

    with pytest.raises(BillingError) as error:
        await BillingService(settings, gateway).create_checkout(
            FakeDatabase(connection),
            user_id=uuid.uuid4(),
            device_id=uuid.uuid4(),
            plan_code="monthly_basic",
        )

    assert error.value.code == "BILLING_UNAVAILABLE"
    assert len(gateway.checkout_calls) == 1
    assert not any("status = 'failed'" in query for query, _ in connection.executions)


@pytest.mark.asyncio
async def test_ambiguous_stripe_timeout_retains_duplicate_guard(
    settings: Settings,
) -> None:
    connection = ScriptedConnection(checkout_steps())
    gateway = FakeGateway()
    gateway.checkout_error = TimeoutError("response lost after request")

    with pytest.raises(BillingError) as error:
        await BillingService(settings, gateway).create_checkout(
            FakeDatabase(connection),
            user_id=uuid.uuid4(),
            device_id=uuid.uuid4(),
            plan_code="monthly_basic",
        )

    assert error.value.code == "BILLING_UNAVAILABLE"
    assert len(gateway.checkout_calls) == 1
    assert not any("status = 'failed'" in query for query, _ in connection.executions)


@pytest.mark.asyncio
async def test_locally_old_checkout_is_reused_when_stripe_says_open(
    settings: Settings,
) -> None:
    user_id = uuid.uuid4()
    device_id = uuid.uuid4()
    reservation_id = uuid.uuid4()
    local_expiry = datetime.now(UTC) - timedelta(minutes=10)
    preparation = checkout_preparation(
        reservation_id=reservation_id,
        user_id=user_id,
        device_id=device_id,
        expires_at=local_expiry,
        provider_session_id="cs_test_12345678",
        existing=True,
    )
    gateway = FakeGateway()
    remote = await gateway.create_checkout_session(preparation, "cus_12345678")
    remote["expires_at"] = int((datetime.now(UTC) + timedelta(minutes=20)).timestamp())
    gateway.authoritative_checkout = remote
    gateway.checkout_calls.clear()
    connection = ScriptedConnection(
        [
            ("SELECT p.stripe_customer_id", {"stripe_customer_id": "cus_12345678"}),
            ("SELECT 1 FROM public.subscription", None),
            (
                "SELECT b.id, b.user_id",
                {
                    "id": reservation_id,
                    "user_id": user_id,
                    "device_id": device_id,
                    "plan_code": "monthly_basic",
                    "provider_session_id": "cs_test_12345678",
                    "provider_customer_id": "cus_12345678",
                    "profile_customer_id": "cus_12345678",
                    "expires_at": local_expiry,
                },
            ),
            (
                "SELECT code, duration_months",
                {
                    "code": "monthly_basic",
                    "duration_months": 1,
                    "price_cents": 299,
                    "currency": "EUR",
                    "active": True,
                    "provider_product_id": "prod_MONTH1234567",
                },
            ),
            ("SELECT 1 FROM public.ownership", {"?column?": 1}),
            ("SELECT 1 FROM public.ownership", {"?column?": 1}),
            ("UPDATE public.billing_checkout_session", {"id": reservation_id}),
        ]
    )

    response = await BillingService(settings, gateway).create_checkout(
        FakeDatabase(connection),
        user_id=user_id,
        device_id=device_id,
        plan_code="monthly_basic",
    )

    assert response.url.startswith("https://checkout.stripe.com/")
    assert gateway.retrieve_checkout_calls == ["cs_test_12345678"]
    assert gateway.checkout_calls == []
    assert not any("expires_at <=" in query for query, _ in connection.executions)


@pytest.mark.asyncio
async def test_only_stripe_expiration_releases_checkout_reservation(
    settings: Settings,
) -> None:
    user_id = uuid.uuid4()
    device_id = uuid.uuid4()
    old_reservation_id = uuid.uuid4()
    old_preparation = checkout_preparation(
        reservation_id=old_reservation_id,
        user_id=user_id,
        device_id=device_id,
        expires_at=datetime.now(UTC) - timedelta(minutes=10),
        provider_session_id="cs_test_12345678",
        existing=True,
    )
    gateway = FakeGateway()
    remote = await gateway.create_checkout_session(
        old_preparation, "cus_12345678"
    )
    remote.update(status="expired", url=None)
    gateway.authoritative_checkout = remote
    gateway.checkout_calls.clear()
    plan = {
        "code": "monthly_basic",
        "duration_months": 1,
        "price_cents": 299,
        "currency": "EUR",
        "active": True,
        "provider_product_id": "prod_MONTH1234567",
    }
    existing = {
        "id": old_reservation_id,
        "user_id": user_id,
        "device_id": device_id,
        "plan_code": "monthly_basic",
        "provider_session_id": "cs_test_12345678",
        "provider_customer_id": "cus_12345678",
        "profile_customer_id": "cus_12345678",
        "expires_at": old_preparation.expires_at,
    }
    connection = ScriptedConnection(
        [
            ("SELECT p.stripe_customer_id", {"stripe_customer_id": "cus_12345678"}),
            ("SELECT 1 FROM public.subscription", None),
            ("SELECT b.id, b.user_id", existing),
            ("SELECT code, duration_months", plan),
            ("SELECT 1 FROM public.ownership", {"?column?": 1}),
            ("UPDATE public.billing_checkout_session", {"id": old_reservation_id}),
            ("SELECT p.stripe_customer_id", {"stripe_customer_id": "cus_12345678"}),
            ("SELECT 1 FROM public.subscription", None),
            ("SELECT b.id, b.user_id", None),
            ("SELECT code, duration_months", plan),
            ("INSERT INTO public.billing_checkout_session", None),
            ("SELECT 1 FROM public.ownership", {"?column?": 1}),
            ("SELECT 1 FROM public.ownership", {"?column?": 1}),
            ("UPDATE public.billing_checkout_session", {"id": uuid.uuid4()}),
        ]
    )

    response = await BillingService(settings, gateway).create_checkout(
        FakeDatabase(connection),
        user_id=user_id,
        device_id=device_id,
        plan_code="monthly_basic",
    )

    assert response.url.startswith("https://checkout.stripe.com/")
    assert gateway.retrieve_checkout_calls == ["cs_test_12345678"]
    assert len(gateway.checkout_calls) == 1
    assert not any("expires_at <=" in query for query, _ in connection.executions)


@pytest.mark.asyncio
async def test_ownership_lost_after_checkout_creation_expires_remote_session(
    settings: Settings,
) -> None:
    connection = ScriptedConnection(
        checkout_steps()
        + [
            ("SELECT 1 FROM public.ownership", None),
            ("UPDATE public.billing_checkout_session", {"id": uuid.uuid4()}),
            ("UPDATE public.billing_checkout_session", {"id": uuid.uuid4()}),
            ("SELECT p.stripe_customer_id", None),
        ]
    )
    gateway = FakeGateway()

    with pytest.raises(BillingError) as error:
        await BillingService(settings, gateway).create_checkout(
            FakeDatabase(connection),
            user_id=uuid.uuid4(),
            device_id=uuid.uuid4(),
            plan_code="monthly_basic",
        )

    assert error.value.code == "TAG_UNAVAILABLE"
    assert gateway.expire_checkout_calls == ["cs_test_12345678"]


@pytest.mark.parametrize("action", ["update", "cancel"])
@pytest.mark.asyncio
async def test_portal_is_scoped_to_exact_tag_subscription(
    settings: Settings, action: str
) -> None:
    connection = ScriptedConnection(
        [
            (
                "SELECT p.stripe_customer_id, s.provider_subscription_id",
                {
                    "stripe_customer_id": "cus_12345678",
                    "provider_subscription_id": "sub_12345678",
                },
            ),
            ("SELECT 1 FROM public.ownership", {"?column?": 1}),
        ]
    )
    gateway = FakeGateway()

    response = await BillingService(settings, gateway).create_portal(
        FakeDatabase(connection),
        user_id=uuid.uuid4(),
        device_id=uuid.uuid4(),
        action=action,
    )

    assert response.url.startswith("https://billing.stripe.com/")
    assert gateway.portal_calls == [
        PortalPreparation(
            customer_id="cus_12345678",
            subscription_id="sub_12345678",
            action=action,
        )
    ]


def test_portal_action_is_strict() -> None:
    assert SubscriptionPortalRequest().action == "update"
    with pytest.raises(ValidationError):
        SubscriptionPortalRequest(action="homepage")


@pytest.mark.parametrize(
    "url",
    [
        "https://checkout.stripe.com:444/c/pay/test",
        "https://checkout.stripe.com:not-a-port/c/pay/test",
        "https://user@checkout.stripe.com/c/pay/test",
    ],
)
def test_safe_stripe_url_rejects_unsafe_authority(url: str) -> None:
    with pytest.raises(BillingError) as error:
        _safe_stripe_url(url, "checkout.stripe.com")

    assert error.value.code == "BILLING_UNAVAILABLE"


def test_safe_stripe_url_allows_default_https_port() -> None:
    url = "https://checkout.stripe.com:443/c/pay/test"

    assert _safe_stripe_url(url, "checkout.stripe.com") == url


@pytest.mark.parametrize(
    ("action", "flow_type"),
    [("update", "subscription_update"), ("cancel", "subscription_cancel")],
)
@pytest.mark.asyncio
async def test_gateway_never_opens_unscoped_portal(
    monkeypatch: pytest.MonkeyPatch,
    settings: Settings,
    action: str,
    flow_type: str,
) -> None:
    captured: dict[str, Any] = {}

    def fake_create(**kwargs: Any) -> dict[str, Any]:
        captured.update(kwargs)
        return {"url": "https://billing.stripe.com/p/session/test"}

    monkeypatch.setattr("stripe.billing_portal.Session.create", fake_create)
    preparation = PortalPreparation(
        customer_id="cus_12345678",
        subscription_id="sub_12345678",
        action=action,
    )

    await StripeGateway(settings).create_portal_session(preparation)

    assert captured["flow_data"]["type"] == flow_type
    assert captured["flow_data"][flow_type] == {
        "subscription": "sub_12345678"
    }
    assert captured["flow_data"]["after_completion"]["type"] == "redirect"


@pytest.mark.asyncio
async def test_gateway_checkout_uses_only_fixed_server_values(
    monkeypatch: pytest.MonkeyPatch, settings: Settings
) -> None:
    captured: dict[str, Any] = {}

    def fake_create(**kwargs: Any) -> dict[str, Any]:
        captured.update(kwargs)
        return {"id": "cs_test_12345678"}

    monkeypatch.setattr("stripe.checkout.Session.create", fake_create)
    preparation = CheckoutPreparation(
        reservation_id=uuid.uuid4(),
        user_id=uuid.uuid4(),
        device_id=uuid.uuid4(),
        plan_code="monthly_basic",
        price_id="price_MONTH1234567",
        product_id="prod_MONTH1234567",
        amount_minor=299,
        currency="EUR",
        duration_months=1,
        customer_id="cus_12345678",
        expires_at=datetime.now(UTC) + timedelta(minutes=45),
        provider_session_id=None,
        existing=False,
    )

    await StripeGateway(settings).create_checkout_session(
        preparation, "cus_12345678"
    )

    assert captured["line_items"] == [
        {"price": "price_MONTH1234567", "quantity": 1}
    ]
    assert captured["success_url"] == settings.stripe_checkout_success_url
    assert captured["cancel_url"] == settings.stripe_checkout_cancel_url
    assert captured["subscription_data"]["metadata"] == captured["metadata"]
    assert captured["metadata"] == {
        "user_id": str(preparation.user_id),
        "device_id": str(preparation.device_id),
        "plan_code": "monthly_basic",
        "checkout_id": str(preparation.reservation_id),
    }


@pytest.mark.asyncio
async def test_gateway_customer_creation_has_stable_idempotency_key(
    monkeypatch: pytest.MonkeyPatch, settings: Settings
) -> None:
    captured: dict[str, Any] = {}

    def fake_create(**kwargs: Any) -> dict[str, Any]:
        captured.update(kwargs)
        return {"id": "cus_12345678"}

    monkeypatch.setattr("stripe.Customer.create", fake_create)
    user_id = uuid.uuid4()

    await StripeGateway(settings).create_customer(user_id)

    assert captured["idempotency_key"] == f"pinqeva-customer-{user_id}"
    assert captured["metadata"] == {"user_id": str(user_id)}


@pytest.mark.asyncio
async def test_gateway_former_owner_cancellation_is_immediate_without_invoice(
    monkeypatch: pytest.MonkeyPatch, settings: Settings
) -> None:
    captured: dict[str, Any] = {}

    def fake_cancel(subscription_id: str, **kwargs: Any) -> dict[str, Any]:
        captured["subscription_id"] = subscription_id
        captured.update(kwargs)
        return {"id": subscription_id, "status": "canceled"}

    monkeypatch.setattr("stripe.Subscription.cancel", fake_cancel)

    await StripeGateway(settings).cancel_subscription("sub_12345678")

    assert captured["subscription_id"] == "sub_12345678"
    assert captured["invoice_now"] is False
    assert captured["prorate"] is False
    assert captured["idempotency_key"] == "pinqeva-former-owner-sub_12345678"


def webhook_event(event_id: str = "evt_12345678") -> dict[str, Any]:
    return {
        "id": event_id,
        "type": "product.updated",
        "created": 1_800_000_000,
        "livemode": False,
        "data": {"object": {"id": "prod_12345678"}},
    }


@pytest.mark.asyncio
async def test_webhook_verifies_raw_body_and_stores_only_allowlisted_summary(
    settings: Settings,
) -> None:
    secret_value = "customer@example.com card_very_private"
    payload = f'{{"private":"{secret_value}"}}'.encode()
    connection = ScriptedConnection(
        [
            ("INSERT INTO public.payment_event", {"event_id": "evt_12345678"}),
            ("UPDATE public.payment_event", None),
        ]
    )
    gateway = FakeGateway()
    gateway.event = webhook_event()

    response = await BillingService(settings, gateway).receive_webhook(
        FakeDatabase(connection), payload=payload, signature="signed-header"
    )

    assert response.received is True
    assert gateway.construct_calls == [(payload, "signed-header")]
    insert_parameters = connection.executions[0][1]
    assert insert_parameters[1] == hashlib.sha256(payload).hexdigest()
    stored_summary = insert_parameters[2].obj
    assert stored_summary == {
        "type": "product.updated",
        "object_id": "prod_12345678",
        "created": 1_800_000_000,
        "livemode": False,
    }
    assert secret_value not in repr(stored_summary)


@pytest.mark.asyncio
async def test_webhook_replay_is_idempotent(settings: Settings) -> None:
    payload = b"same signed event"
    digest = hashlib.sha256(payload).hexdigest()
    connection = ScriptedConnection(
        [
            ("INSERT INTO public.payment_event", None),
            (
                "SELECT payload_sha256, status",
                {"payload_sha256": digest, "status": "processed"},
            ),
        ]
    )
    gateway = FakeGateway()
    gateway.event = webhook_event()

    response = await BillingService(settings, gateway).receive_webhook(
        FakeDatabase(connection), payload=payload, signature="signed-header"
    )

    assert response.duplicate is True
    assert len(connection.executions) == 2


@pytest.mark.asyncio
async def test_same_event_id_with_different_payload_is_rejected(
    settings: Settings,
) -> None:
    connection = ScriptedConnection(
        [
            ("INSERT INTO public.payment_event", None),
            (
                "SELECT payload_sha256, status",
                {"payload_sha256": "0" * 64, "status": "processed"},
            ),
        ]
    )
    gateway = FakeGateway()
    gateway.event = webhook_event()

    with pytest.raises(BillingError) as error:
        await BillingService(settings, gateway).receive_webhook(
            FakeDatabase(connection),
            payload=b"different signed event",
            signature="signed-header",
        )

    assert error.value.code == "INVALID_WEBHOOK"


@pytest.mark.asyncio
async def test_recognized_webhook_ahead_of_checkout_binding_is_deferred(
    settings: Settings,
) -> None:
    user_id = uuid.uuid4()
    device_id = uuid.uuid4()
    checkout_id = uuid.uuid4()
    gateway = FakeGateway()
    gateway.event = {
        "id": "evt_early123456",
        "type": "customer.subscription.created",
        "created": 1_800_000_000,
        "livemode": False,
        "data": {"object": {"id": "sub_12345678"}},
    }
    gateway.authoritative_subscription = subscription_object(
        user_id=user_id,
        device_id=device_id,
        checkout_id=checkout_id,
    )
    connection = ScriptedConnection(
        [
            ("INSERT INTO public.payment_event", {"event_id": "evt_early123456"}),
            (
                "SELECT id, user_id, device_id, plan_code",
                {
                    "id": checkout_id,
                    "user_id": user_id,
                    "device_id": device_id,
                    "plan_code": "monthly_basic",
                    "provider_session_id": None,
                    "provider_customer_id": None,
                    "provider_subscription_id": None,
                    "status": "creating",
                },
            ),
        ]
    )

    with pytest.raises(BillingError) as error:
        await BillingService(settings, gateway).receive_webhook(
            FakeDatabase(connection),
            payload=b"signed early event",
            signature="signed-header",
        )

    assert error.value.code == "BILLING_EVENT_DEFERRED"
    assert len(connection.executions) == 2


@pytest.mark.asyncio
async def test_same_second_webhook_uses_authoritative_current_object(
    settings: Settings,
) -> None:
    gateway = FakeGateway()
    gateway.authoritative_subscription = {
        "id": "sub_12345678",
        "status": "canceled",
    }
    stale_event_object = {
        "id": "sub_12345678",
        "status": "active",
    }

    reconciled = await BillingService(
        settings, gateway
    )._authoritative_event_object(
        "customer.subscription.updated", stale_event_object
    )

    assert reconciled["status"] == "canceled"


@pytest.mark.asyncio
async def test_invoice_event_is_deferred_until_subscription_event_arrives(
    settings: Settings,
) -> None:
    service = BillingService(settings, FakeGateway())
    connection = ScriptedConnection(
        [("SELECT id FROM public.subscription", None)]
    )
    invoice = {
        "id": "in_12345678",
        "parent": {
            "type": "subscription_details",
            "subscription_details": {"subscription": "sub_12345678"},
        },
    }

    with pytest.raises(BillingEventDeferred):
        await service._apply_invoice(
            connection, "evt_12345678", 1_800_000_000, invoice
        )


@pytest.mark.asyncio
async def test_subscription_price_is_reverse_mapped_unambiguously_on_update(
    settings: Settings,
) -> None:
    user_id = uuid.uuid4()
    device_id = uuid.uuid4()
    checkout_id = uuid.uuid4()
    connection = ScriptedConnection(
        [
            (
                "SELECT id, user_id, device_id, plan_code",
                {
                    "id": checkout_id,
                    "user_id": user_id,
                    "device_id": device_id,
                    "plan_code": "monthly_basic",
                    "provider_session_id": "cs_test_12345678",
                    "provider_customer_id": "cus_12345678",
                    "provider_subscription_id": "sub_12345678",
                    "status": "completed",
                },
            ),
            ("SELECT 1 FROM public.ownership", {"?column?": 1}),
            (
                "SELECT code, duration_months",
                {
                    "code": "yearly_pro",
                    "duration_months": 12,
                    "price_cents": 2999,
                    "currency": "EUR",
                    "active": True,
                    "provider_product_id": "prod_YEAR12345678",
                },
            ),
            ("INSERT INTO public.subscription", {"id": uuid.uuid4()}),
            ("UPDATE public.billing_checkout_session", None),
        ]
    )
    now = 1_800_000_000
    subscription = {
        "id": "sub_12345678",
        "customer": "cus_12345678",
        "status": "active",
        "cancel_at_period_end": False,
        "metadata": {
            "user_id": str(user_id),
            "device_id": str(device_id),
            "plan_code": "monthly_basic",
            "checkout_id": str(checkout_id),
        },
        "items": {
            "data": [
                {
                    "quantity": 1,
                    "price": {
                        "id": "price_YEAR12345678",
                        "active": True,
                        "type": "recurring",
                        "billing_scheme": "per_unit",
                        "unit_amount": 2999,
                        "currency": "eur",
                        "recurring": {
                            "interval": "year",
                            "interval_count": 1,
                            "usage_type": "licensed",
                        },
                        "product": {
                            "id": "prod_YEAR12345678",
                            "active": True,
                        },
                    },
                    "current_period_start": now,
                    "current_period_end": now + 31_536_000,
                }
            ]
        },
    }

    await BillingService(settings, FakeGateway())._apply_subscription(
        connection,
        "evt_12345678",
        "customer.subscription.updated",
        now,
        subscription,
    )

    insert_parameters = connection.executions[3][1]
    assert insert_parameters[2] == "yearly_pro"
    assert "provider_event_created_at" in connection.executions[3][0]
    assert "provider_event_id" in connection.executions[3][0]
    assert (
        "COALESCE(public.subscription.provider_event_id"
        in connection.executions[3][0]
    )


@pytest.mark.asyncio
async def test_subscription_webhook_queues_billing_cancellation_for_former_owner(
    settings: Settings,
) -> None:
    user_id = uuid.uuid4()
    device_id = uuid.uuid4()
    checkout_id = uuid.uuid4()
    authoritative = subscription_object(
        user_id=user_id,
        device_id=device_id,
        checkout_id=checkout_id,
    )
    gateway = FakeGateway()
    gateway.authoritative_subscription = authoritative
    connection = ScriptedConnection(
        [
            (
                "SELECT id, user_id, device_id, plan_code",
                {
                    "id": checkout_id,
                    "user_id": user_id,
                    "device_id": device_id,
                    "plan_code": "monthly_basic",
                    "provider_session_id": "cs_test_12345678",
                    "provider_customer_id": "cus_12345678",
                    "provider_subscription_id": "sub_12345678",
                    "status": "completed",
                },
            ),
            ("SELECT 1 FROM public.ownership", None),
            (
                "SELECT code, duration_months",
                {
                    "code": "monthly_basic",
                    "duration_months": 1,
                    "price_cents": 299,
                    "currency": "EUR",
                    "active": True,
                    "provider_product_id": "prod_MONTH1234567",
                },
            ),
            ("INSERT INTO public.subscription", {"id": uuid.uuid4()}),
            ("INSERT INTO public.subscription_cancellation_outbox", None),
            ("UPDATE public.billing_checkout_session", None),
        ]
    )

    await BillingService(settings, gateway)._apply_subscription(
        connection,
        "evt_cancel123456",
        "customer.subscription.updated",
        1_800_000_000,
        authoritative,
    )

    assert gateway.cancel_calls == []
    insert_parameters = connection.executions[3][1]
    assert insert_parameters[3] == "ended"
    assert insert_parameters[-2] is None
    assert insert_parameters[-1] == "ownership_lost_checkout"
    queue_parameters = connection.executions[4][1]
    assert queue_parameters[1] == "sub_12345678"


@pytest.mark.asyncio
async def test_checkout_webhook_never_calls_stripe_while_holding_database_locks(
    settings: Settings,
) -> None:
    user_id = uuid.uuid4()
    device_id = uuid.uuid4()
    checkout_id = uuid.uuid4()
    gateway = FakeGateway()
    checkout_row = {
        "id": checkout_id,
        "user_id": user_id,
        "device_id": device_id,
        "plan_code": "monthly_basic",
        "provider_session_id": "cs_test_12345678",
        "provider_customer_id": "cus_12345678",
        "provider_subscription_id": None,
        "status": "pending",
    }
    connection = ScriptedConnection(
        [
            (
                "SELECT id, user_id, device_id, plan_code",
                checkout_row,
            ),
            ("SELECT 1 FROM public.ownership", None),
            ("SELECT id, user_id, device_id, plan_code", checkout_row),
            ("SELECT 1 FROM public.ownership", None),
            (
                "SELECT code, duration_months",
                {
                    "code": "monthly_basic",
                    "duration_months": 1,
                    "price_cents": 299,
                    "currency": "EUR",
                    "active": True,
                    "provider_product_id": "prod_MONTH1234567",
                },
            ),
            ("INSERT INTO public.subscription", {"id": uuid.uuid4()}),
            ("INSERT INTO public.subscription_cancellation_outbox", None),
            ("UPDATE public.billing_checkout_session", None),
            ("UPDATE public.billing_checkout_session", None),
        ]
    )
    checkout = {
        "id": "cs_test_12345678",
        "customer": "cus_12345678",
        "subscription": "sub_12345678",
        "status": "complete",
        "mode": "subscription",
        "metadata": {
            "user_id": str(user_id),
            "device_id": str(device_id),
            "plan_code": "monthly_basic",
            "checkout_id": str(checkout_id),
        },
        "_pinqeva_authoritative_subscription": subscription_object(
            user_id=user_id,
            device_id=device_id,
            checkout_id=checkout_id,
        ),
    }

    await BillingService(settings, gateway)._apply_checkout_completed(
        connection,
        "evt_checkout123456",
        1_800_000_000,
        checkout,
    )

    assert gateway.cancel_calls == []
    assert len(connection.executions) == 9
