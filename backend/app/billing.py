from __future__ import annotations

import asyncio
import hashlib
import logging
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Literal, Mapping
from urllib.parse import urlparse
from uuid import UUID, uuid4

import stripe
from psycopg import AsyncConnection
from psycopg.errors import UniqueViolation
from psycopg.types.json import Jsonb

from .config import Settings
from .database import Database
from .models import (
    BillingUrlResponse,
    DeviceSubscriptionResponse,
    DeviceProvisioningRequestResponse,
    PlanSummary,
    ProvisioningRequestCheckoutResponse,
    StripeWebhookResponse,
)


logger = logging.getLogger("pinqeva.billing")

CHECKOUT_TTL = timedelta(minutes=45)
PROVISIONING_REQUEST_MAX_TTL = timedelta(minutes=90)
MAX_WEBHOOK_BYTES = 1_048_576
SUPPORTED_SUBSCRIPTION_EVENTS = {
    "customer.subscription.created",
    "customer.subscription.updated",
    "customer.subscription.deleted",
    "customer.subscription.paused",
    "customer.subscription.resumed",
}
SUPPORTED_INVOICE_EVENTS = {
    "invoice.created",
    "invoice.updated",
    "invoice.finalized",
    "invoice.finalization_failed",
    "invoice.paid",
    "invoice.payment_failed",
    "invoice.payment_action_required",
    "invoice.voided",
    "invoice.marked_uncollectible",
}


class BillingError(RuntimeError):
    def __init__(self, code: str, status_code: int) -> None:
        super().__init__(code)
        self.code = code
        self.status_code = status_code


class BillingEventIgnored(RuntimeError):
    pass


class BillingEventDeferred(RuntimeError):
    pass


@dataclass(frozen=True)
class CheckoutPreparation:
    reservation_id: UUID
    user_id: UUID
    device_id: UUID
    plan_code: str
    price_id: str
    product_id: str
    amount_minor: int
    currency: str
    duration_months: int
    customer_id: str | None
    expires_at: datetime
    provider_session_id: str | None
    existing: bool


@dataclass(frozen=True)
class ProvisioningCheckoutPreparation:
    request_id: UUID
    user_id: UUID
    device_id: UUID
    serial_number: str
    plan_code: str
    price_id: str
    product_id: str
    amount_minor: int
    currency: str
    duration_months: int
    customer_id: str | None
    expires_at: datetime
    provider_session_id: str | None
    existing: bool


@dataclass(frozen=True)
class PortalPreparation:
    customer_id: str
    subscription_id: str
    action: str


def _as_mapping(value: Any) -> Mapping[str, Any]:
    if isinstance(value, Mapping):
        return value
    for method_name in ("to_dict_recursive", "to_dict"):
        method = getattr(value, method_name, None)
        if callable(method):
            converted = method()
            if isinstance(converted, Mapping):
                return converted
    raise BillingError("BILLING_UNAVAILABLE", 503)


def _object_id(value: Any) -> str | None:
    if isinstance(value, str):
        return value
    if isinstance(value, Mapping) and isinstance(value.get("id"), str):
        return value["id"]
    return None


def _epoch(value: Any, *, required: bool = True) -> datetime | None:
    if value is None and not required:
        return None
    if not isinstance(value, int) or isinstance(value, bool):
        raise BillingEventIgnored("invalid timestamp")
    try:
        return datetime.fromtimestamp(value, UTC)
    except (OverflowError, OSError, ValueError):
        raise BillingEventIgnored("invalid timestamp") from None


def _integer(value: Any, default: int = 0) -> int:
    if value is None:
        return default
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise BillingEventIgnored("invalid amount")
    return value


def _currency(value: Any) -> str:
    if not isinstance(value, str) or len(value) != 3 or not value.isalpha():
        raise BillingEventIgnored("invalid currency")
    return value.upper()


def _identifier(value: Any, prefix: str) -> str:
    object_id = _object_id(value)
    if (
        object_id is None
        or not object_id.startswith(prefix)
        or len(object_id) > 255
    ):
        raise BillingEventIgnored("invalid provider identifier")
    return object_id


def _invoice_subscription_id(invoice: Mapping[str, Any]) -> str | None:
    """Read both Stripe's legacy and current invoice subscription shapes."""

    subscription_id = _object_id(invoice.get("subscription"))
    if subscription_id is None:
        parent = invoice.get("parent")
        details = (
            parent.get("subscription_details")
            if isinstance(parent, Mapping)
            and parent.get("type") == "subscription_details"
            else None
        )
        if isinstance(details, Mapping):
            subscription_id = _object_id(details.get("subscription"))
    if subscription_id is None or not subscription_id.startswith("sub_"):
        return None
    return subscription_id


def _binding(metadata_value: Any) -> tuple[UUID, UUID, str, UUID]:
    if not isinstance(metadata_value, Mapping):
        raise BillingEventIgnored("missing binding")
    try:
        user_id = UUID(str(metadata_value["user_id"]))
        device_id = UUID(str(metadata_value["device_id"]))
        checkout_id = UUID(str(metadata_value["checkout_id"]))
        plan_code = str(metadata_value["plan_code"])
    except (KeyError, TypeError, ValueError):
        raise BillingEventIgnored("invalid binding") from None
    if not plan_code or len(plan_code) > 64:
        raise BillingEventIgnored("invalid binding")
    return user_id, device_id, plan_code, checkout_id


def _provisioning_binding(
    metadata_value: Any,
) -> tuple[UUID, UUID, UUID, str, str]:
    """Parse the immutable Stripe metadata for a pre-claim request.

    Returning ``None`` is intentionally handled by the caller when the
    metadata belongs to the legacy owned-device checkout path. If the new
    marker is present, every field is mandatory and must match the database
    row before a webhook can change local billing state.
    """

    if not isinstance(metadata_value, Mapping):
        raise BillingEventIgnored("missing binding")
    if "provisioning_request_id" not in metadata_value:
        raise BillingEventIgnored("not a provisioning binding")
    try:
        request_id = UUID(str(metadata_value["provisioning_request_id"]))
        user_id = UUID(str(metadata_value["user_id"]))
        device_id = UUID(str(metadata_value["device_id"]))
        serial_number = str(metadata_value["serial_number"])
        plan_code = str(metadata_value["plan_code"])
    except (KeyError, TypeError, ValueError):
        raise BillingEventIgnored("invalid provisioning binding") from None
    if (
        len(serial_number) != 16
        or not serial_number.startswith("PKV-")
        or len(plan_code) == 0
        or len(plan_code) > 64
    ):
        raise BillingEventIgnored("invalid provisioning binding")
    return request_id, user_id, device_id, serial_number, plan_code


def _billing_terms(duration_months: int) -> tuple[Literal["month", "year"], int]:
    if duration_months in {1, 3, 6}:
        return "month", duration_months
    if duration_months == 12:
        return "year", 1
    raise BillingError("BILLING_UNAVAILABLE", 503)


def _billing_interval(duration_months: int) -> Literal["month", "year"]:
    return _billing_terms(duration_months)[0]


def _safe_stripe_url(value: Any, expected_host: str) -> str:
    if not isinstance(value, str):
        raise BillingError("BILLING_UNAVAILABLE", 503)
    parsed = urlparse(value)
    try:
        port = parsed.port
    except ValueError:
        raise BillingError("BILLING_UNAVAILABLE", 503) from None
    if (
        parsed.scheme != "https"
        or parsed.hostname != expected_host
        or port not in {None, 443}
        or parsed.username is not None
        or parsed.password is not None
    ):
        raise BillingError("BILLING_UNAVAILABLE", 503)
    return value


class StripeGateway:
    """Small async boundary around Stripe's synchronous Python SDK."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    async def create_customer(self, user_id: UUID) -> Mapping[str, Any]:
        result = await asyncio.to_thread(
            stripe.Customer.create,
            api_key=self.settings.stripe_secret_key,
            stripe_version=self.settings.stripe_api_version,
            idempotency_key=f"pinqeva-customer-{user_id}",
            metadata={"user_id": str(user_id)},
        )
        return _as_mapping(result)

    async def create_checkout_session(
        self, preparation: CheckoutPreparation, customer_id: str
    ) -> Mapping[str, Any]:
        metadata = {
            "user_id": str(preparation.user_id),
            "device_id": str(preparation.device_id),
            "plan_code": preparation.plan_code,
            "checkout_id": str(preparation.reservation_id),
        }
        result = await asyncio.to_thread(
            stripe.checkout.Session.create,
            api_key=self.settings.stripe_secret_key,
            stripe_version=self.settings.stripe_api_version,
            idempotency_key=f"pinqeva-checkout-{preparation.reservation_id}",
            mode="subscription",
            customer=customer_id,
            client_reference_id=str(preparation.reservation_id),
            line_items=[{"price": preparation.price_id, "quantity": 1}],
            metadata=metadata,
            subscription_data={"metadata": metadata},
            expand=["line_items.data.price.product"],
            success_url=self.settings.stripe_checkout_success_url,
            cancel_url=self.settings.stripe_checkout_cancel_url,
            expires_at=int(preparation.expires_at.timestamp()),
        )
        return _as_mapping(result)

    async def create_provisioning_checkout_session(
        self, preparation: ProvisioningCheckoutPreparation, customer_id: str
    ) -> Mapping[str, Any]:
        metadata = {
            "provisioning_request_id": str(preparation.request_id),
            "user_id": str(preparation.user_id),
            "device_id": str(preparation.device_id),
            "serial_number": preparation.serial_number,
            "plan_code": preparation.plan_code,
        }
        result = await asyncio.to_thread(
            stripe.checkout.Session.create,
            api_key=self.settings.stripe_secret_key,
            stripe_version=self.settings.stripe_api_version,
            idempotency_key=f"pinqeva-provisioning-{preparation.request_id}",
            mode="subscription",
            customer=customer_id,
            client_reference_id=str(preparation.request_id),
            line_items=[{"price": preparation.price_id, "quantity": 1}],
            metadata=metadata,
            subscription_data={"metadata": metadata},
            expand=["line_items.data.price.product"],
            success_url=self.settings.stripe_checkout_success_url,
            cancel_url=self.settings.stripe_checkout_cancel_url,
            expires_at=int(preparation.expires_at.timestamp()),
        )
        return _as_mapping(result)

    async def retrieve_checkout_session(
        self, session_id: str
    ) -> Mapping[str, Any]:
        result = await asyncio.to_thread(
            stripe.checkout.Session.retrieve,
            session_id,
            api_key=self.settings.stripe_secret_key,
            stripe_version=self.settings.stripe_api_version,
            expand=["line_items.data.price.product"],
        )
        return _as_mapping(result)

    async def expire_checkout_session(
        self, session_id: str
    ) -> Mapping[str, Any]:
        result = await asyncio.to_thread(
            stripe.checkout.Session.expire,
            session_id,
            api_key=self.settings.stripe_secret_key,
            stripe_version=self.settings.stripe_api_version,
            expand=["line_items.data.price.product"],
        )
        return _as_mapping(result)

    async def retrieve_price(self, price_id: str) -> Mapping[str, Any]:
        result = await asyncio.to_thread(
            stripe.Price.retrieve,
            price_id,
            api_key=self.settings.stripe_secret_key,
            stripe_version=self.settings.stripe_api_version,
            expand=["product"],
        )
        return _as_mapping(result)

    async def retrieve_subscription(
        self, subscription_id: str
    ) -> Mapping[str, Any]:
        result = await asyncio.to_thread(
            stripe.Subscription.retrieve,
            subscription_id,
            api_key=self.settings.stripe_secret_key,
            stripe_version=self.settings.stripe_api_version,
            expand=["items.data.price.product"],
        )
        return _as_mapping(result)

    async def cancel_subscription(
        self, subscription_id: str
    ) -> Mapping[str, Any]:
        result = await asyncio.to_thread(
            stripe.Subscription.cancel,
            subscription_id,
            api_key=self.settings.stripe_secret_key,
            stripe_version=self.settings.stripe_api_version,
            idempotency_key=f"pinqeva-former-owner-{subscription_id}",
            invoice_now=False,
            prorate=False,
            expand=["items.data.price.product"],
        )
        return _as_mapping(result)

    async def retrieve_invoice(self, invoice_id: str) -> Mapping[str, Any]:
        result = await asyncio.to_thread(
            stripe.Invoice.retrieve,
            invoice_id,
            api_key=self.settings.stripe_secret_key,
            stripe_version=self.settings.stripe_api_version,
        )
        return _as_mapping(result)

    async def create_portal_session(
        self, preparation: PortalPreparation
    ) -> Mapping[str, Any]:
        flow_type = (
            "subscription_cancel"
            if preparation.action == "cancel"
            else "subscription_update"
        )
        arguments: dict[str, Any] = {
            "api_key": self.settings.stripe_secret_key,
            "stripe_version": self.settings.stripe_api_version,
            "customer": preparation.customer_id,
            "return_url": self.settings.stripe_portal_return_url,
            "flow_data": {
                "type": flow_type,
                flow_type: {
                    "subscription": preparation.subscription_id,
                },
                "after_completion": {
                    "type": "redirect",
                    "redirect": {
                        "return_url": self.settings.stripe_portal_return_url,
                    },
                },
            },
        }
        if self.settings.stripe_portal_configuration_id:
            arguments["configuration"] = (
                self.settings.stripe_portal_configuration_id
            )
        result = await asyncio.to_thread(
            stripe.billing_portal.Session.create,
            **arguments,
        )
        return _as_mapping(result)

    def construct_event(self, payload: bytes, signature: str) -> Mapping[str, Any]:
        try:
            event = stripe.Webhook.construct_event(
                payload,
                signature,
                self.settings.stripe_webhook_secret,
            )
        except (ValueError, stripe.SignatureVerificationError):
            raise BillingError("INVALID_WEBHOOK", 400) from None
        return _as_mapping(event)


class BillingService:
    def __init__(
        self, settings: Settings, gateway: StripeGateway | None = None
    ) -> None:
        self.settings = settings
        self.gateway = gateway or StripeGateway(settings)

    def _plan_price_id(self, plan: Mapping[str, Any]) -> str | None:
        value = plan.get("provider_price_id")
        if isinstance(value, str) and value:
            return value
        code = plan.get("code")
        return self.settings.stripe_price_for(str(code)) if code is not None else None

    def _plan_product_id(self, plan: Mapping[str, Any]) -> str | None:
        value = plan.get("provider_product_id")
        if isinstance(value, str) and value:
            return value
        code = plan.get("code")
        return self.settings.stripe_product_for(str(code)) if code is not None else None

    async def bootstrap_catalog(self, database: Database) -> None:
        """Fill initially configured Stripe bindings without overwriting admin prices."""
        async with database.transaction() as connection:
            for plan_code, price_id, product_id in self.settings.stripe_price_map:
                updated = await connection.execute(
                    """
                    UPDATE public.plan
                       SET provider_price_id = COALESCE(provider_price_id, %s),
                           provider_product_id = COALESCE(provider_product_id, %s),
                           updated_at = now()
                     WHERE code = %s
                       AND (provider_product_id IS NULL OR provider_product_id = %s)
                    RETURNING code, duration_months, price_cents, currency,
                              price_version, provider_price_id,
                              provider_product_id
                    """,
                    (price_id, product_id, plan_code, product_id),
                )
                plan = await updated.fetchone()
                if plan is None:
                    continue
                await connection.execute(
                    """
                    UPDATE public.plan_price_history
                       SET active_for_new = false
                     WHERE plan_code = %s
                       AND provider_price_id <> %s
                       AND active_for_new = true
                    """,
                    (plan_code, plan["provider_price_id"]),
                )
                await connection.execute(
                    """
                    INSERT INTO public.plan_price_history (
                        plan_code, provider_price_id, provider_product_id,
                        amount_cents, currency, duration_months, price_version,
                        active_for_new
                    ) VALUES (%s, %s, %s, %s, %s, %s, %s, true)
                    ON CONFLICT (provider_price_id) DO NOTHING
                    """,
                    (
                        plan_code,
                        plan["provider_price_id"],
                        plan["provider_product_id"],
                        plan["price_cents"],
                        plan["currency"],
                        plan["duration_months"],
                        plan["price_version"],
                    ),
                )

    async def _validate_plan_catalog(self, plan: Mapping[str, Any]) -> None:
        expected_price_id = self._plan_price_id(plan)
        expected_product_id = self._plan_product_id(plan)
        if expected_price_id is None or expected_product_id is None:
            raise BillingError("BILLING_UNAVAILABLE", 503)
        try:
            price = await self.gateway.retrieve_price(expected_price_id)
        except BillingError:
            raise
        except Exception as exc:
            logger.warning("Stripe Price retrieval failed type=%s", type(exc).__name__)
            raise BillingError("BILLING_UNAVAILABLE", 503) from None

        self._assert_price_matches_plan(plan, price, require_active=True)

    def _assert_price_matches_plan(
        self,
        plan: Mapping[str, Any],
        price: Mapping[str, Any],
        *,
        require_active: bool,
    ) -> None:
        expected_price_id = self._plan_price_id(plan)
        expected_product_id = self._plan_product_id(plan)
        if expected_price_id is None or expected_product_id is None:
            raise BillingError("BILLING_UNAVAILABLE", 503)

        product = price.get("product")
        recurring = price.get("recurring")
        expected_interval, expected_interval_count = _billing_terms(
            int(plan["duration_months"])
        )
        try:
            provider_amount = _integer(price.get("unit_amount"))
            provider_currency = _currency(price.get("currency"))
        except BillingEventIgnored:
            raise BillingError("BILLING_UNAVAILABLE", 503) from None
        if (
            _object_id(price.get("id")) != expected_price_id
            or (require_active and price.get("active") is not True)
            or price.get("type") != "recurring"
            or price.get("billing_scheme") != "per_unit"
            or not isinstance(recurring, Mapping)
            or recurring.get("interval") != expected_interval
            or recurring.get("interval_count") != expected_interval_count
            or recurring.get("usage_type") != "licensed"
            or not isinstance(product, Mapping)
            or _object_id(product.get("id")) != expected_product_id
            or (require_active and product.get("active") is not True)
            or provider_amount != int(plan["price_cents"])
            or provider_currency != str(plan["currency"]).upper()
        ):
            raise BillingError("BILLING_UNAVAILABLE", 503)

    async def get_device_subscription(
        self, database: Database, *, user_id: UUID, device_id: UUID
    ) -> DeviceSubscriptionResponse:
        async with database.transaction() as connection:
            await self._require_owner(connection, user_id, device_id)
            plan_query = await connection.execute(
                """
                SELECT code, name, duration_months, price_cents, currency,
                       provider_price_id, provider_product_id
                  FROM public.plan
                 WHERE active = true
                 ORDER BY price_cents, code
                """
            )
            plans = await plan_query.fetchall()
            subscription_query = await connection.execute(
                """
                SELECT s.status, s.plan_code, s.starts_at,
                       s.current_period_end, s.cancel_at_period_end,
                       sync.status AS entitlement_sync_status,
                       sync.entitlement_expires_at
                         AS tag_entitlement_expires_at,
                       COALESCE(
                         sync.installed_at, sync.issued_at, sync.created_at
                       ) AS tag_entitlement_updated_at,
                       p.name AS plan_name,
                       COALESCE(history.duration_months, p.duration_months)
                         AS duration_months,
                       COALESCE(history.amount_cents, p.price_cents)
                         AS price_cents,
                       COALESCE(history.currency, p.currency) AS currency,
                       COALESCE(
                         history.provider_price_id,
                         s.provider_price_id,
                         p.provider_price_id
                       ) AS provider_price_id,
                       COALESCE(
                         history.provider_product_id,
                         p.provider_product_id
                       ) AS provider_product_id,
                       p.active AS plan_active
                  FROM public.subscription s
                  JOIN public.plan p ON p.code = s.plan_code
                  LEFT JOIN public.plan_price_history history
                    ON history.plan_code = s.plan_code
                   AND history.provider_price_id = s.provider_price_id
                  LEFT JOIN LATERAL (
                    SELECT entitlement.status,
                           entitlement.entitlement_expires_at,
                           entitlement.installed_at,
                           entitlement.issued_at,
                           entitlement.created_at
                      FROM public.device_entitlement_sync entitlement
                     WHERE entitlement.subscription_id = s.id
                       AND entitlement.device_id = s.device_id
                       AND entitlement.entitlement_expires_at =
                           s.current_period_end
                     ORDER BY entitlement.created_at DESC
                     LIMIT 1
                  ) sync ON true
                 WHERE s.device_id = %s
                   AND s.user_id = %s
                   AND s.status NOT IN ('cancelled', 'ended')
                 ORDER BY s.created_at DESC
                 LIMIT 1
                """,
                (device_id, user_id),
            )
            subscription = await subscription_query.fetchone()

        configured_plans = [
            row for row in plans if self._plan_price_id(row) is not None
        ]
        for plan in configured_plans:
            await self._validate_plan_catalog(plan)
        if subscription is not None:
            await self._validate_plan_catalog(
                {
                    "code": subscription["plan_code"],
                    "duration_months": subscription["duration_months"],
                    "price_cents": subscription["price_cents"],
                    "currency": subscription["currency"],
                    "provider_price_id": subscription["provider_price_id"],
                    "provider_product_id": subscription[
                        "provider_product_id"
                    ],
                }
            )
        if not await self._ownership_is_active(
            database, user_id=user_id, device_id=device_id
        ):
            raise BillingError("TAG_UNAVAILABLE", 404)

        available_plans = [
            PlanSummary(
                code=row["code"],
                name=row["name"],
                amount_minor=int(row["price_cents"]),
                currency=str(row["currency"]).upper(),
                billing_interval=_billing_interval(int(row["duration_months"])),
                billing_interval_count=_billing_terms(
                    int(row["duration_months"])
                )[1],
                duration_months=int(row["duration_months"]),
            )
            for row in configured_plans
        ]
        if subscription is None:
            return DeviceSubscriptionResponse(
                device_id=device_id,
                status="none",
                available_plans=available_plans,
            )
        return DeviceSubscriptionResponse(
            device_id=device_id,
            status=subscription["status"],
            plan_code=subscription["plan_code"],
            plan_name=subscription["plan_name"],
            amount_minor=int(subscription["price_cents"]),
            currency=str(subscription["currency"]).upper(),
            billing_interval=_billing_interval(
                int(subscription["duration_months"])
            ),
            billing_interval_count=_billing_terms(
                int(subscription["duration_months"])
            )[1],
            duration_months=int(subscription["duration_months"]),
            current_period_start=subscription["starts_at"],
            current_period_end=subscription["current_period_end"],
            cancel_at_period_end=bool(
                subscription["cancel_at_period_end"]
            ),
            entitlement_sync_status=subscription.get(
                "entitlement_sync_status"
            ),
            tag_entitlement_expires_at=subscription.get(
                "tag_entitlement_expires_at"
            ),
            tag_entitlement_updated_at=subscription.get(
                "tag_entitlement_updated_at"
            ),
            available_plans=available_plans,
        )

    async def get_provisioning_request(
        self,
        database: Database,
        *,
        user_id: UUID,
        request_id: UUID,
        include_plans: bool = True,
    ) -> DeviceProvisioningRequestResponse:
        async with database.transaction() as connection:
            query = await connection.execute(
                """
                SELECT id AS request_id, device_id, serial_number, status,
                       plan_code, expires_at, claim_deadline,
                       provider_session_id, subscription_id
                  FROM public.provisioning_request
                 WHERE id = %s AND user_id = %s
                 FOR UPDATE
                """,
                (request_id, user_id),
            )
            row = await query.fetchone()
            if row is None:
                raise BillingError("PROVISIONING_REQUEST_NOT_FOUND", 404)
            if self._provisioning_request_is_expired(row):
                await self._expire_provisioning_request(connection, request_id)
                row = dict(row)
                row["status"] = "expired"
                row["claim_deadline"] = row.get("claim_deadline")

        available_plans = (
            await self._available_plan_summaries(database) if include_plans else []
        )
        return DeviceProvisioningRequestResponse(
            request_id=row["request_id"],
            device_id=row["device_id"],
            serial_number=row["serial_number"],
            status=row["status"],
            plan_code=row.get("plan_code"),
            expires_at=row["expires_at"],
            claim_deadline=row.get("claim_deadline"),
            available_plans=available_plans,
        )

    async def create_provisioning_checkout(
        self,
        database: Database,
        *,
        user_id: UUID,
        request_id: UUID,
        plan_code: str,
    ) -> ProvisioningRequestCheckoutResponse:
        for _ in range(2):
            async with database.transaction() as connection:
                preparation = await self._prepare_provisioning_checkout(
                    connection,
                    user_id=user_id,
                    request_id=request_id,
                    plan_code=plan_code,
                )

            checkout_attempt_started = False
            try:
                await self._validate_plan_catalog(
                    {
                        "code": preparation.plan_code,
                        "duration_months": preparation.duration_months,
                        "price_cents": preparation.amount_minor,
                        "currency": preparation.currency,
                        "provider_price_id": preparation.price_id,
                        "provider_product_id": preparation.product_id,
                    }
                )
                customer_id = preparation.customer_id
                if customer_id is None:
                    customer = await self.gateway.create_customer(preparation.user_id)
                    customer_id = _identifier(customer.get("id"), "cus_")
                    async with database.transaction() as connection:
                        customer_id = await self._save_customer(
                            connection, preparation.user_id, customer_id
                        )

                if preparation.provider_session_id:
                    checkout_attempt_started = True
                    session = await self.gateway.retrieve_checkout_session(
                        preparation.provider_session_id
                    )
                else:
                    checkout_attempt_started = True
                    session = await self.gateway.create_provisioning_checkout_session(
                        preparation, customer_id
                    )

                details = self._provisioning_checkout_details(
                    session,
                    preparation=preparation,
                    customer_id=customer_id,
                )
                if details["status"] == "expired":
                    async with database.transaction() as connection:
                        await self._expire_provisioning_request(
                            connection, preparation.request_id
                        )
                    raise BillingError("PROVISIONING_REQUEST_EXPIRED", 409)
                if details["status"] == "complete":
                    # Stripe is authoritative, but access is granted only by
                    # the verified webhook transaction. The app can poll the
                    # request while Stripe retries the webhook.
                    await self._persist_open_provisioning_checkout(
                        database,
                        preparation=preparation,
                        customer_id=customer_id,
                        session_id=details["session_id"],
                        provider_expires_at=details["expires_at"],
                    )
                    raise BillingError("BILLING_EVENT_DEFERRED", 503)

                await self._persist_open_provisioning_checkout(
                    database,
                    preparation=preparation,
                    customer_id=customer_id,
                    session_id=details["session_id"],
                    provider_expires_at=details["expires_at"],
                )
                return ProvisioningRequestCheckoutResponse(
                    request_id=preparation.request_id,
                    url=details["url"],
                    expires_at=details["expires_at"],
                )
            except BillingError:
                if not checkout_attempt_started and not preparation.existing:
                    await self._mark_provisioning_checkout_failed(
                        database, preparation.request_id
                    )
                raise
            except Exception as exc:
                logger.warning(
                    "Provisioning checkout failed type=%s request_id=%s",
                    type(exc).__name__,
                    preparation.request_id,
                )
                if not checkout_attempt_started and not preparation.existing:
                    await self._mark_provisioning_checkout_failed(
                        database, preparation.request_id
                    )
                raise BillingError("BILLING_UNAVAILABLE", 503) from None
        raise BillingError("BILLING_UNAVAILABLE", 503)

    async def _available_plan_summaries(
        self, database: Database
    ) -> list[PlanSummary]:
        async with database.transaction() as connection:
            query = await connection.execute(
                """
                SELECT code, name, duration_months, price_cents, currency,
                       provider_price_id, provider_product_id
                  FROM public.plan
                 WHERE active = true
                 ORDER BY price_cents, code
                """
            )
            plans = await query.fetchall()
        configured_plans = [
            row for row in plans if self._plan_price_id(row) is not None
        ]
        for plan in configured_plans:
            await self._validate_plan_catalog(plan)
        return [
            PlanSummary(
                code=row["code"],
                name=row["name"],
                amount_minor=int(row["price_cents"]),
                currency=str(row["currency"]).upper(),
                billing_interval=_billing_interval(int(row["duration_months"])),
                billing_interval_count=_billing_terms(
                    int(row["duration_months"])
                )[1],
                duration_months=int(row["duration_months"]),
            )
            for row in configured_plans
        ]

    @staticmethod
    def _provisioning_request_is_expired(row: Mapping[str, Any]) -> bool:
        now = datetime.now(UTC)
        status = row.get("status")
        if status in {"pending", "creating", "open"}:
            return row["expires_at"] <= now
        if status in {"paid", "claiming"}:
            deadline = row.get("claim_deadline")
            return deadline is not None and deadline <= now
        return False

    async def _prepare_provisioning_checkout(
        self,
        connection: AsyncConnection,
        *,
        user_id: UUID,
        request_id: UUID,
        plan_code: str,
    ) -> ProvisioningCheckoutPreparation:
        request_query = await connection.execute(
            """
            SELECT r.id, r.user_id, r.device_id, r.serial_number, r.plan_code,
                   r.status, r.expires_at, r.claim_deadline,
                   r.created_at,
                   r.provider_session_id, r.provider_customer_id,
                   p.stripe_customer_id
              FROM public.provisioning_request r
              JOIN public.profiles p ON p.id = r.user_id
             WHERE r.id = %s AND r.user_id = %s
             FOR UPDATE OF r, p
            """,
            (request_id, user_id),
        )
        request = await request_query.fetchone()
        if request is None:
            raise BillingError("PROVISIONING_REQUEST_NOT_FOUND", 404)
        if self._provisioning_request_is_expired(request):
            await self._expire_provisioning_request(connection, request_id)
            raise BillingError("PROVISIONING_REQUEST_EXPIRED", 409)
        if request["status"] in {"paid", "claiming", "completed"}:
            raise BillingError("SUBSCRIPTION_EXISTS", 409)
        if request["status"] in {"expired", "failed"}:
            raise BillingError("PROVISIONING_REQUEST_EXPIRED", 409)
        if (
            request["provider_session_id"] is not None
            and request["plan_code"] != plan_code
        ):
            raise BillingError("CHECKOUT_IN_PROGRESS", 409)
        if (
            request["provider_session_id"] is None
            and request["status"] in {"creating", "open"}
            and request["plan_code"] is not None
            and request["plan_code"] != plan_code
        ):
            raise BillingError("CHECKOUT_IN_PROGRESS", 409)

        owner_query = await connection.execute(
            """
            SELECT 1 FROM public.ownership
             WHERE device_id = %s AND ended_at IS NULL
             FOR UPDATE
            """,
            (request["device_id"],),
        )
        if await owner_query.fetchone() is not None:
            raise BillingError("TAG_UNAVAILABLE", 404)
        subscription_query = await connection.execute(
            """
            SELECT 1 FROM public.subscription
             WHERE device_id = %s
               AND status NOT IN ('cancelled', 'ended')
             FOR UPDATE
            """,
            (request["device_id"],),
        )
        if await subscription_query.fetchone() is not None:
            raise BillingError("SUBSCRIPTION_EXISTS", 409)

        plan_query = await connection.execute(
            """
            SELECT code, duration_months, price_cents, currency, active,
                   provider_price_id, provider_product_id
              FROM public.plan
             WHERE code = %s
            """,
            (plan_code,),
        )
        plan = await plan_query.fetchone()
        if plan is None or plan["active"] is not True:
            raise BillingError("PLAN_UNAVAILABLE", 400)
        price_id = self._plan_price_id(plan)
        product_id = self._plan_product_id(plan)
        if price_id is None or product_id is None:
            raise BillingError("PLAN_UNAVAILABLE", 400)

        provider_session_id = request["provider_session_id"]
        request_expires_at = request["expires_at"]
        if provider_session_id is None:
            # Stripe requires Checkout Session `expires_at` to be at least
            # 30 minutes in the future. A user can resume a still-live
            # provisioning request after most of its original TTL has passed,
            # so renew the unpaid request before creating the session.
            minimum_checkout_expiry = datetime.now(UTC) + CHECKOUT_TTL
            if request_expires_at < minimum_checkout_expiry:
                maximum_request_expiry = (
                    request["created_at"] + PROVISIONING_REQUEST_MAX_TTL
                )
                if maximum_request_expiry < minimum_checkout_expiry:
                    await self._expire_provisioning_request(connection, request_id)
                    raise BillingError("PROVISIONING_REQUEST_EXPIRED", 409)
                request_expires_at = min(
                    minimum_checkout_expiry, maximum_request_expiry
                )
            await connection.execute(
                """
                UPDATE public.provisioning_request
                   SET plan_code = %s, status = 'creating', expires_at = %s,
                       updated_at = now()
                 WHERE id = %s AND status IN ('pending', 'creating', 'open')
                """,
                (plan_code, request_expires_at, request_id),
            )
        return ProvisioningCheckoutPreparation(
            request_id=request["id"],
            user_id=request["user_id"],
            device_id=request["device_id"],
            serial_number=request["serial_number"],
            plan_code=plan_code,
            price_id=price_id,
            product_id=product_id,
            amount_minor=int(plan["price_cents"]),
            currency=str(plan["currency"]).upper(),
            duration_months=int(plan["duration_months"]),
            customer_id=request["provider_customer_id"]
            or request["stripe_customer_id"],
            expires_at=request_expires_at,
            provider_session_id=provider_session_id,
            existing=provider_session_id is not None,
        )

    def _provisioning_checkout_details(
        self,
        session: Mapping[str, Any],
        *,
        preparation: ProvisioningCheckoutPreparation,
        customer_id: str,
    ) -> dict[str, Any]:
        try:
            session_id = _identifier(session.get("id"), "cs_")
            session_customer_id = _identifier(session.get("customer"), "cus_")
            binding = _provisioning_binding(session.get("metadata"))
            expires_at = _epoch(session.get("expires_at"))
            items = session.get("line_items")
            item_data = items.get("data") if isinstance(items, Mapping) else None
            if not isinstance(item_data, list) or len(item_data) != 1:
                raise BillingEventIgnored("checkout item mismatch")
            item = item_data[0]
            if not isinstance(item, Mapping) or _integer(item.get("quantity")) != 1:
                raise BillingEventIgnored("checkout quantity mismatch")
            price = item.get("price")
            if not isinstance(price, Mapping):
                raise BillingEventIgnored("checkout price missing")
            price_id = _identifier(price.get("id"), "price_")
            product_id = _identifier(price.get("product"), "prod_")
        except BillingEventIgnored:
            raise BillingError("BILLING_UNAVAILABLE", 503) from None
        expected_binding = (
            preparation.request_id,
            preparation.user_id,
            preparation.device_id,
            preparation.serial_number,
            preparation.plan_code,
        )
        status_value = session.get("status")
        if (
            session_customer_id != customer_id
            or binding != expected_binding
            or session.get("mode") != "subscription"
            or session.get("client_reference_id") != str(preparation.request_id)
            or price_id != preparation.price_id
            or product_id != preparation.product_id
            or session.get("success_url") != self.settings.stripe_checkout_success_url
            or session.get("cancel_url") != self.settings.stripe_checkout_cancel_url
            or status_value not in {"open", "complete", "expired"}
            or expires_at is None
            or expires_at > preparation.expires_at
        ):
            raise BillingError("BILLING_UNAVAILABLE", 503)
        return {
            "session_id": session_id,
            "status": status_value,
            "url": (
                _safe_stripe_url(session.get("url"), "checkout.stripe.com")
                if status_value == "open"
                else None
            ),
            "expires_at": expires_at,
        }

    async def _persist_open_provisioning_checkout(
        self,
        database: Database,
        *,
        preparation: ProvisioningCheckoutPreparation,
        customer_id: str,
        session_id: str,
        provider_expires_at: datetime,
    ) -> None:
        async with database.transaction() as connection:
            owner_query = await connection.execute(
                """
                SELECT 1 FROM public.ownership
                 WHERE device_id = %s AND ended_at IS NULL
                 FOR UPDATE
                """,
                (preparation.device_id,),
            )
            if await owner_query.fetchone() is not None:
                raise BillingError("TAG_UNAVAILABLE", 404)
            query = await connection.execute(
                """
                UPDATE public.provisioning_request
                   SET provider_session_id = %s,
                       provider_customer_id = %s,
                       status = 'open',
                       expires_at = LEAST(expires_at, %s),
                       updated_at = now()
                 WHERE id = %s AND status IN ('creating', 'open')
                 RETURNING id
                """,
                (
                    session_id,
                    customer_id,
                    provider_expires_at,
                    preparation.request_id,
                ),
            )
            if await query.fetchone() is None:
                raise BillingError("CHECKOUT_IN_PROGRESS", 409)

    async def _expire_provisioning_request(
        self, connection: AsyncConnection, request_id: UUID
    ) -> None:
        request_query = await connection.execute(
            """
            SELECT status, subscription_id, provider_subscription_id
              FROM public.provisioning_request
             WHERE id = %s
             FOR UPDATE
            """,
            (request_id,),
        )
        request = await request_query.fetchone()
        if request is None or request["status"] in {"completed", "expired"}:
            return
        await connection.execute(
            """
            UPDATE public.provisioning_request
               SET status = 'expired', updated_at = now()
             WHERE id = %s AND status <> 'completed'
            """,
            (request_id,),
        )
        if request["subscription_id"] is None:
            return
        subscription_query = await connection.execute(
            """
            UPDATE public.subscription
               SET status = 'ended', cancel_at_period_end = false,
                   ended_reason = 'provisioning_request_expired', updated_at = now()
             WHERE id = %s AND status NOT IN ('cancelled', 'ended')
             RETURNING id, provider_subscription_id
            """,
            (request["subscription_id"],),
        )
        subscription = await subscription_query.fetchone()
        provider_subscription_id = (
            subscription["provider_subscription_id"]
            if subscription is not None
            else request["provider_subscription_id"]
        )
        if provider_subscription_id:
            await self._enqueue_former_owner_cancellation(
                connection,
                subscription_id=request["subscription_id"],
                provider_subscription_id=provider_subscription_id,
            )

    async def _mark_provisioning_checkout_failed(
        self, database: Database, request_id: UUID
    ) -> None:
        try:
            async with database.transaction() as connection:
                await connection.execute(
                    """
                    UPDATE public.provisioning_request
                       SET status = 'failed', updated_at = now()
                     WHERE id = %s AND status = 'creating'
                    """,
                    (request_id,),
                )
        except Exception as exc:
            logger.warning(
                "Provisioning checkout failure state could not be saved type=%s request_id=%s",
                type(exc).__name__,
                request_id,
            )

    async def create_checkout(
        self,
        database: Database,
        *,
        user_id: UUID,
        device_id: UUID,
        plan_code: str,
    ) -> BillingUrlResponse:
        # One authoritative reconciliation can retire an expired/former-owner
        # reservation; the next pass creates the replacement. Never retire a
        # payable reservation from the local clock alone.
        for _ in range(3):
            async with database.transaction() as connection:
                preparation = await self._prepare_checkout(
                    connection,
                    user_id=user_id,
                    device_id=device_id,
                    plan_code=plan_code,
                )

            checkout_attempt_started = False
            try:
                await self._validate_plan_catalog(
                    {
                        "code": preparation.plan_code,
                        "duration_months": preparation.duration_months,
                        "price_cents": preparation.amount_minor,
                        "currency": preparation.currency,
                        "provider_price_id": preparation.price_id,
                        "provider_product_id": preparation.product_id,
                    }
                )
                customer_id = preparation.customer_id
                owner_active = await self._ownership_is_active(
                    database,
                    user_id=preparation.user_id,
                    device_id=preparation.device_id,
                )
                if customer_id is None and not owner_active:
                    # Checkout cannot be attempted before the profile Customer
                    # is durably stored, so this reservation is provably local.
                    await self._mark_checkout_failed(
                        database, preparation.reservation_id
                    )
                    continue
                if customer_id is None:
                    customer = await self.gateway.create_customer(
                        preparation.user_id
                    )
                    customer_id = _identifier(customer.get("id"), "cus_")
                    async with database.transaction() as connection:
                        customer_id = await self._save_customer(
                            connection, preparation.user_id, customer_id
                        )

                if preparation.provider_session_id:
                    checkout_attempt_started = True
                    session = await self.gateway.retrieve_checkout_session(
                        preparation.provider_session_id
                    )
                else:
                    # Retrying the same reservation repeats the same Stripe
                    # idempotency key and recovers an ambiguously timed-out call.
                    checkout_attempt_started = True
                    session = await self.gateway.create_checkout_session(
                        preparation, customer_id
                    )
                details = self._checkout_details(
                    session,
                    preparation=preparation,
                    customer_id=customer_id,
                )

                if details["status"] == "expired":
                    await self._mark_checkout_provider_terminal(
                        database,
                        preparation=preparation,
                        session_id=details["session_id"],
                        customer_id=customer_id,
                        status="expired",
                    )
                    continue
                if details["status"] == "complete":
                    still_owner = await self._ownership_is_active(
                        database,
                        user_id=preparation.user_id,
                        device_id=preparation.device_id,
                    )
                    if not still_owner:
                        subscription_id = details["subscription_id"]
                        if subscription_id is None:
                            raise BillingError("BILLING_UNAVAILABLE", 503)
                        await self._cancel_former_owner_subscription(
                            subscription_id
                        )
                    await self._mark_checkout_provider_terminal(
                        database,
                        preparation=preparation,
                        session_id=details["session_id"],
                        customer_id=customer_id,
                        status="completed",
                        subscription_id=details["subscription_id"],
                    )
                    if not still_owner:
                        continue
                    raise BillingError("SUBSCRIPTION_EXISTS", 409)

                owner_after_creation = await self._persist_open_checkout(
                    database,
                    preparation=preparation,
                    customer_id=customer_id,
                    session_id=details["session_id"],
                    provider_expires_at=details["expires_at"],
                )
                if not owner_after_creation:
                    expired = await self.gateway.expire_checkout_session(
                        details["session_id"]
                    )
                    expired_details = self._checkout_details(
                        expired,
                        preparation=preparation,
                        customer_id=customer_id,
                    )
                    if expired_details["status"] != "expired":
                        raise BillingError("BILLING_UNAVAILABLE", 503)
                    await self._mark_checkout_provider_terminal(
                        database,
                        preparation=preparation,
                        session_id=details["session_id"],
                        customer_id=customer_id,
                        status="expired",
                    )
                    continue
                if preparation.user_id != user_id:
                    raise BillingError("CHECKOUT_IN_PROGRESS", 409)
                if preparation.plan_code != plan_code:
                    raise BillingError("CHECKOUT_IN_PROGRESS", 409)
                return BillingUrlResponse(url=details["url"])
            except BillingError:
                if not checkout_attempt_started and not preparation.existing:
                    await self._mark_checkout_failed(
                        database, preparation.reservation_id
                    )
                raise
            except Exception as exc:
                logger.warning(
                    "Stripe checkout reconciliation failed type=%s reservation_id=%s",
                    type(exc).__name__,
                    preparation.reservation_id,
                )
                if not checkout_attempt_started and not preparation.existing:
                    await self._mark_checkout_failed(
                        database, preparation.reservation_id
                    )
                raise BillingError("BILLING_UNAVAILABLE", 503) from None
        raise BillingError("BILLING_UNAVAILABLE", 503)

    async def create_portal(
        self,
        database: Database,
        *,
        user_id: UUID,
        device_id: UUID,
        action: str = "update",
    ) -> BillingUrlResponse:
        async with database.transaction() as connection:
            preparation = await self._prepare_portal(
                connection,
                user_id=user_id,
                device_id=device_id,
                action=action,
            )
        try:
            session = await self.gateway.create_portal_session(preparation)
            if not await self._ownership_is_active(
                database, user_id=user_id, device_id=device_id
            ):
                raise BillingError("TAG_UNAVAILABLE", 404)
            return BillingUrlResponse(
                url=_safe_stripe_url(session.get("url"), "billing.stripe.com")
            )
        except BillingError:
            raise
        except Exception as exc:
            logger.warning(
                "Stripe portal creation failed type=%s",
                type(exc).__name__,
            )
            raise BillingError("BILLING_UNAVAILABLE", 503) from None

    async def receive_webhook(
        self, database: Database, *, payload: bytes, signature: str
    ) -> StripeWebhookResponse:
        if not signature or len(payload) > MAX_WEBHOOK_BYTES:
            raise BillingError("INVALID_WEBHOOK", 400)
        event = self.gateway.construct_event(payload, signature)
        expected_live_mode = self.settings.stripe_secret_key.startswith("sk_live_")
        if (
            not isinstance(event.get("livemode"), bool)
            or event["livemode"] != expected_live_mode
        ):
            raise BillingError("INVALID_WEBHOOK", 400)

        try:
            event_id = _identifier(event.get("id"), "evt_")
        except BillingEventIgnored:
            raise BillingError("INVALID_WEBHOOK", 400) from None
        event_type = event.get("type")
        event_created = event.get("created")
        if not isinstance(event_type, str) or len(event_type) > 128:
            raise BillingError("INVALID_WEBHOOK", 400)
        if not isinstance(event_created, int) or isinstance(event_created, bool):
            raise BillingError("INVALID_WEBHOOK", 400)
        data = event.get("data")
        if not isinstance(data, Mapping) or not isinstance(
            data.get("object"), Mapping
        ):
            raise BillingError("INVALID_WEBHOOK", 400)
        event_object = data["object"]
        object_id = _object_id(event_object.get("id"))
        summary = {
            "type": event_type,
            "object_id": object_id,
            "created": event_created,
            "livemode": expected_live_mode,
        }
        digest = hashlib.sha256(payload).hexdigest()

        try:
            event_object = await self._authoritative_event_object(
                event_type, event_object
            )
            async with database.transaction() as connection:
                inserted = await self._record_event(
                    connection,
                    event_id=event_id,
                    payload_sha256=digest,
                    summary=summary,
                )
                if not inserted:
                    return StripeWebhookResponse(duplicate=True)
                try:
                    processed = await self._apply_event(
                        connection,
                        event_id=event_id,
                        event_type=event_type,
                        event_created=event_created,
                        event_object=event_object,
                    )
                except BillingEventIgnored:
                    processed = False
                await connection.execute(
                    """
                    UPDATE public.payment_event
                       SET status = %s, processed_at = now(),
                           event_data = event_data || %s::jsonb
                     WHERE provider = 'stripe' AND event_id = %s
                    """,
                    (
                        "processed" if processed else "ignored",
                        Jsonb(
                            {
                                "result": (
                                    "processed" if processed else "ignored"
                                )
                            }
                        ),
                        event_id,
                    ),
                )
        except BillingEventDeferred:
            logger.info("Stripe event deferred event_id=%s", event_id)
            raise BillingError("BILLING_EVENT_DEFERRED", 503) from None
        return StripeWebhookResponse()

    async def _authoritative_event_object(
        self, event_type: str, event_object: Mapping[str, Any]
    ) -> Mapping[str, Any]:
        try:
            if event_type in {
                "checkout.session.completed",
                "checkout.session.expired",
            }:
                session_id = _identifier(event_object.get("id"), "cs_")
                session = await self.gateway.retrieve_checkout_session(session_id)
                if (
                    event_type == "checkout.session.completed"
                    and session.get("status") == "complete"
                ):
                    subscription_id = _identifier(
                        session.get("subscription"), "sub_"
                    )
                    subscription = await self.gateway.retrieve_subscription(
                        subscription_id
                    )
                    if _object_id(subscription.get("id")) != subscription_id:
                        raise BillingEventDeferred(
                            "provider subscription reconciliation mismatch"
                        )
                    return {
                        **session,
                        "_pinqeva_authoritative_subscription": subscription,
                    }
                return session
            if event_type in SUPPORTED_SUBSCRIPTION_EVENTS:
                subscription_id = _identifier(event_object.get("id"), "sub_")
                return await self.gateway.retrieve_subscription(subscription_id)
            if event_type in SUPPORTED_INVOICE_EVENTS:
                invoice_id = _identifier(event_object.get("id"), "in_")
                invoice = await self.gateway.retrieve_invoice(invoice_id)
                if event_type != "invoice.paid":
                    return invoice
                subscription_id = _invoice_subscription_id(invoice)
                if subscription_id is None:
                    # Stripe can deliver paid one-off invoices to the same
                    # endpoint. They are unrelated to a tag subscription and
                    # should be recorded as ignored rather than retried.
                    return invoice
                subscription = await self.gateway.retrieve_subscription(
                    subscription_id
                )
                if _object_id(subscription.get("id")) != subscription_id:
                    raise BillingEventDeferred(
                        "provider subscription reconciliation mismatch"
                    )
                return {
                    **invoice,
                    "_pinqeva_authoritative_subscription": subscription,
                }
            return event_object
        except BillingEventIgnored:
            raise BillingEventDeferred("provider object identifier invalid") from None
        except BillingError:
            raise
        except Exception as exc:
            logger.warning(
                "Stripe authoritative reconciliation failed type=%s",
                type(exc).__name__,
            )
            raise BillingEventDeferred("provider reconciliation unavailable") from None

    async def _require_owner(
        self, connection: AsyncConnection, user_id: UUID, device_id: UUID
    ) -> None:
        query = await connection.execute(
            """
            SELECT 1
              FROM public.ownership
             WHERE device_id = %s AND ended_at IS NULL
            """,
            (device_id,),
        )
        if await query.fetchone() is None:
            raise BillingError("TAG_UNAVAILABLE", 404)

    async def _prepare_checkout(
        self,
        connection: AsyncConnection,
        *,
        user_id: UUID,
        device_id: UUID,
        plan_code: str,
    ) -> CheckoutPreparation:
        owner_query = await connection.execute(
            """
            SELECT p.stripe_customer_id
              FROM public.ownership o
              JOIN public.profiles p ON p.id = o.user_id
             WHERE o.user_id = %s AND o.device_id = %s
               AND o.ended_at IS NULL
             FOR UPDATE OF o, p
            """,
            (user_id, device_id),
        )
        owner = await owner_query.fetchone()
        if owner is None:
            raise BillingError("TAG_UNAVAILABLE", 404)

        subscription_query = await connection.execute(
            """
            SELECT 1 FROM public.subscription
             WHERE device_id = %s
               AND status NOT IN ('cancelled', 'ended')
             FOR UPDATE
            """,
            (device_id,),
        )
        if await subscription_query.fetchone() is not None:
            raise BillingError("SUBSCRIPTION_EXISTS", 409)

        existing_query = await connection.execute(
            """
            SELECT b.id, b.user_id, b.device_id, b.plan_code,
                   b.provider_session_id, b.provider_customer_id,
                   b.expires_at, p.stripe_customer_id AS profile_customer_id
              FROM public.billing_checkout_session b
              JOIN public.profiles p ON p.id = b.user_id
             WHERE b.device_id = %s
               AND b.status IN ('creating', 'pending')
             ORDER BY b.created_at DESC
             LIMIT 1
             FOR UPDATE OF b
            """,
            (device_id,),
        )
        existing = await existing_query.fetchone()
        effective_plan_code = existing["plan_code"] if existing else plan_code
        plan_query = await connection.execute(
            """
            SELECT code, duration_months, price_cents, currency, active,
                   provider_price_id, provider_product_id
              FROM public.plan
             WHERE code = %s
            """,
            (effective_plan_code,),
        )
        plan = await plan_query.fetchone()
        if plan is None or (existing is None and plan["active"] is not True):
            raise BillingError("PLAN_UNAVAILABLE", 400)
        price_id = self._plan_price_id(plan)
        product_id = self._plan_product_id(plan)
        if price_id is None or product_id is None:
            raise BillingError("PLAN_UNAVAILABLE", 400)

        if existing is not None:
            return CheckoutPreparation(
                reservation_id=existing["id"],
                user_id=existing["user_id"],
                device_id=existing["device_id"],
                plan_code=effective_plan_code,
                price_id=price_id,
                product_id=product_id,
                amount_minor=int(plan["price_cents"]),
                currency=str(plan["currency"]).upper(),
                duration_months=int(plan["duration_months"]),
                customer_id=(
                    existing["provider_customer_id"]
                    or existing["profile_customer_id"]
                ),
                expires_at=existing["expires_at"],
                provider_session_id=existing["provider_session_id"],
                existing=True,
            )

        now = datetime.now(UTC)
        reservation_id = uuid4()
        expires_at = now + CHECKOUT_TTL
        try:
            await connection.execute(
                """
                INSERT INTO public.billing_checkout_session (
                    id, user_id, device_id, plan_code, status, expires_at
                ) VALUES (%s, %s, %s, %s, 'creating', %s)
                """,
                (reservation_id, user_id, device_id, plan_code, expires_at),
            )
        except UniqueViolation:
            raise BillingError("CHECKOUT_IN_PROGRESS", 409) from None
        return CheckoutPreparation(
            reservation_id=reservation_id,
            user_id=user_id,
            device_id=device_id,
            plan_code=effective_plan_code,
            price_id=price_id,
            product_id=product_id,
            amount_minor=int(plan["price_cents"]),
            currency=str(plan["currency"]).upper(),
            duration_months=int(plan["duration_months"]),
            customer_id=owner["stripe_customer_id"],
            expires_at=expires_at,
            provider_session_id=None,
            existing=False,
        )

    async def _save_customer(
        self, connection: AsyncConnection, user_id: UUID, customer_id: str
    ) -> str:
        query = await connection.execute(
            """
            UPDATE public.profiles
               SET stripe_customer_id = COALESCE(stripe_customer_id, %s)
             WHERE id = %s
             RETURNING stripe_customer_id
            """,
            (customer_id, user_id),
        )
        profile = await query.fetchone()
        if profile is None:
            raise BillingError("BILLING_UNAVAILABLE", 503)
        return _identifier(profile["stripe_customer_id"], "cus_")

    async def _ownership_is_active(
        self, database: Database, *, user_id: UUID, device_id: UUID
    ) -> bool:
        async with database.transaction() as connection:
            query = await connection.execute(
                """
                SELECT 1 FROM public.ownership
                 WHERE user_id = %s AND device_id = %s AND ended_at IS NULL
                """,
                (user_id, device_id),
            )
            return await query.fetchone() is not None

    def _checkout_details(
        self,
        session: Mapping[str, Any],
        *,
        preparation: CheckoutPreparation,
        customer_id: str,
    ) -> dict[str, Any]:
        try:
            session_id = _identifier(session.get("id"), "cs_")
            session_customer_id = _identifier(session.get("customer"), "cus_")
            binding = _binding(session.get("metadata"))
            expires_at = _epoch(session.get("expires_at"))
            items = session.get("line_items")
            item_data = items.get("data") if isinstance(items, Mapping) else None
            if not isinstance(item_data, list) or len(item_data) != 1:
                raise BillingEventIgnored("checkout item mismatch")
            item = item_data[0]
            if not isinstance(item, Mapping) or _integer(item.get("quantity")) != 1:
                raise BillingEventIgnored("checkout quantity mismatch")
            price = item.get("price")
            if not isinstance(price, Mapping):
                raise BillingEventIgnored("checkout price missing")
            price_id = _identifier(price.get("id"), "price_")
            product_id = _identifier(price.get("product"), "prod_")
        except BillingEventIgnored:
            raise BillingError("BILLING_UNAVAILABLE", 503) from None
        expected_binding = (
            preparation.user_id,
            preparation.device_id,
            preparation.plan_code,
            preparation.reservation_id,
        )
        status_value = session.get("status")
        if (
            session_customer_id != customer_id
            or binding != expected_binding
            or session.get("mode") != "subscription"
            or session.get("client_reference_id")
            != str(preparation.reservation_id)
            or price_id != preparation.price_id
            or product_id != preparation.product_id
            or session.get("success_url")
            != self.settings.stripe_checkout_success_url
            or session.get("cancel_url")
            != self.settings.stripe_checkout_cancel_url
            or status_value not in {"open", "complete", "expired"}
            or expires_at is None
        ):
            raise BillingError("BILLING_UNAVAILABLE", 503)
        checkout_url = None
        if status_value == "open":
            checkout_url = _safe_stripe_url(
                session.get("url"), "checkout.stripe.com"
            )
        subscription_id = None
        if session.get("subscription") is not None:
            try:
                subscription_id = _identifier(
                    session.get("subscription"), "sub_"
                )
            except BillingEventIgnored:
                raise BillingError("BILLING_UNAVAILABLE", 503) from None
        return {
            "session_id": session_id,
            "status": status_value,
            "url": checkout_url,
            "expires_at": expires_at,
            "subscription_id": subscription_id,
        }

    async def _persist_open_checkout(
        self,
        database: Database,
        *,
        preparation: CheckoutPreparation,
        customer_id: str,
        session_id: str,
        provider_expires_at: datetime,
    ) -> bool:
        async with database.transaction() as connection:
            owner_query = await connection.execute(
                """
                SELECT 1 FROM public.ownership
                 WHERE user_id = %s AND device_id = %s AND ended_at IS NULL
                 FOR UPDATE
                """,
                (preparation.user_id, preparation.device_id),
            )
            owner_active = await owner_query.fetchone() is not None
            query = await connection.execute(
                """
                UPDATE public.billing_checkout_session
                   SET provider_session_id = %s,
                       provider_customer_id = %s,
                       status = 'pending',
                       expires_at = %s,
                       updated_at = now()
                 WHERE id = %s AND status IN ('creating', 'pending')
                 RETURNING id
                """,
                (
                    session_id,
                    customer_id,
                    provider_expires_at,
                    preparation.reservation_id,
                ),
            )
            if await query.fetchone() is None:
                raise BillingError("CHECKOUT_IN_PROGRESS", 409)
            return owner_active

    async def _mark_checkout_provider_terminal(
        self,
        database: Database,
        *,
        preparation: CheckoutPreparation,
        session_id: str,
        customer_id: str,
        status: str,
        subscription_id: str | None = None,
    ) -> None:
        if status not in {"expired", "completed"}:
            raise BillingError("BILLING_UNAVAILABLE", 503)
        async with database.transaction() as connection:
            query = await connection.execute(
                """
                UPDATE public.billing_checkout_session
                   SET provider_session_id = COALESCE(provider_session_id, %s),
                       provider_customer_id = COALESCE(
                           provider_customer_id, %s
                       ),
                       provider_subscription_id = COALESCE(
                           provider_subscription_id, %s
                       ),
                       status = %s,
                       completed_at = CASE
                           WHEN %s = 'completed' THEN COALESCE(completed_at, now())
                           ELSE NULL
                       END,
                       updated_at = now()
                 WHERE id = %s
                   AND status IN ('creating', 'pending', %s)
                   AND (
                       provider_session_id IS NULL
                       OR provider_session_id = %s
                   )
                 RETURNING id
                """,
                (
                    session_id,
                    customer_id,
                    subscription_id,
                    status,
                    status,
                    preparation.reservation_id,
                    status,
                    session_id,
                ),
            )
            if await query.fetchone() is None:
                raise BillingError("BILLING_UNAVAILABLE", 503)

    async def _cancel_former_owner_subscription(
        self, subscription_id: str
    ) -> Mapping[str, Any]:
        try:
            cancelled = await self.gateway.cancel_subscription(subscription_id)
        except Exception as exc:
            logger.warning(
                "Former-owner subscription compensation failed type=%s",
                type(exc).__name__,
            )
            raise BillingEventDeferred("provider cancellation unavailable") from None
        if (
            _object_id(cancelled.get("id")) != subscription_id
            or cancelled.get("status") != "canceled"
        ):
            raise BillingEventDeferred("provider cancellation not confirmed")
        return cancelled

    async def _enqueue_former_owner_cancellation(
        self,
        connection: AsyncConnection,
        *,
        subscription_id: UUID,
        provider_subscription_id: str,
    ) -> None:
        # This queue is committed atomically with the fail-safe local terminal
        # entitlement. A separately deployed worker performs the immediate,
        # no-proration Stripe cancellation after this transaction releases its
        # row locks; only a provider-terminal webhook confirms completion.
        await connection.execute(
            """
            INSERT INTO public.subscription_cancellation_outbox (
                id, subscription_id, device_release_id,
                provider_subscription_id, cancellation_reason, status
            ) VALUES (
                gen_random_uuid(), %s, NULL, %s,
                'ownership_lost_checkout', 'pending'
            )
            ON CONFLICT DO NOTHING
            """,
            (subscription_id, provider_subscription_id),
        )

    async def _mark_checkout_failed(
        self, database: Database, reservation_id: UUID
    ) -> None:
        try:
            async with database.transaction() as connection:
                await connection.execute(
                    """
                    UPDATE public.billing_checkout_session
                       SET status = 'failed', updated_at = now()
                     WHERE id = %s AND status = 'creating'
                    """,
                    (reservation_id,),
                )
        except Exception as exc:
            logger.warning(
                "Checkout failure state could not be saved type=%s reservation_id=%s",
                type(exc).__name__,
                reservation_id,
            )

    async def _prepare_portal(
        self,
        connection: AsyncConnection,
        *,
        user_id: UUID,
        device_id: UUID,
        action: str,
    ) -> PortalPreparation:
        query = await connection.execute(
            """
            SELECT p.stripe_customer_id, s.provider_subscription_id
              FROM public.ownership o
              JOIN public.profiles p ON p.id = o.user_id
              LEFT JOIN public.subscription s
                ON s.device_id = o.device_id
               AND s.user_id = o.user_id
               AND s.status NOT IN ('cancelled', 'ended')
             WHERE o.user_id = %s AND o.device_id = %s
               AND o.ended_at IS NULL
             ORDER BY s.created_at DESC NULLS LAST
             LIMIT 1
            """,
            (user_id, device_id),
        )
        row = await query.fetchone()
        if row is None:
            raise BillingError("TAG_UNAVAILABLE", 404)
        if not row["stripe_customer_id"] or not row["provider_subscription_id"]:
            raise BillingError("SUBSCRIPTION_NOT_MANAGEABLE", 409)
        return PortalPreparation(
            customer_id=_identifier(row["stripe_customer_id"], "cus_"),
            subscription_id=_identifier(
                row["provider_subscription_id"], "sub_"
            ),
            action=action,
        )

    async def _record_event(
        self,
        connection: AsyncConnection,
        *,
        event_id: str,
        payload_sha256: str,
        summary: Mapping[str, Any],
    ) -> bool:
        query = await connection.execute(
            """
            INSERT INTO public.payment_event (
                provider, event_id, payload_sha256, status, event_data
            ) VALUES ('stripe', %s, %s, 'processing', %s)
            ON CONFLICT (provider, event_id) DO NOTHING
            RETURNING event_id
            """,
            (event_id, payload_sha256, Jsonb(dict(summary))),
        )
        if await query.fetchone() is not None:
            return True
        existing_query = await connection.execute(
            """
            SELECT payload_sha256, status
              FROM public.payment_event
             WHERE provider = 'stripe' AND event_id = %s
             FOR UPDATE
            """,
            (event_id,),
        )
        existing = await existing_query.fetchone()
        if existing is None or existing["payload_sha256"] != payload_sha256:
            raise BillingError("INVALID_WEBHOOK", 400)
        return False

    async def _apply_event(
        self,
        connection: AsyncConnection,
        *,
        event_id: str,
        event_type: str,
        event_created: int,
        event_object: Mapping[str, Any],
    ) -> bool:
        if event_type == "checkout.session.completed":
            if self._is_provisioning_metadata(event_object.get("metadata")):
                await self._apply_provisioning_checkout_completed(
                    connection,
                    event_id,
                    event_created,
                    event_object,
                )
                return True
            await self._apply_checkout_completed(
                connection,
                event_id,
                event_created,
                event_object,
            )
            return True
        if event_type == "checkout.session.expired":
            if self._is_provisioning_metadata(event_object.get("metadata")):
                await self._apply_provisioning_checkout_expired(
                    connection, event_object
                )
                return True
            await self._apply_checkout_expired(connection, event_object)
            return True
        if event_type in SUPPORTED_SUBSCRIPTION_EVENTS:
            await self._apply_subscription(
                connection,
                event_id,
                event_type,
                event_created,
                event_object,
            )
            return True
        if event_type in SUPPORTED_INVOICE_EVENTS:
            authoritative_subscription = event_object.get(
                "_pinqeva_authoritative_subscription"
            )
            if isinstance(authoritative_subscription, Mapping):
                # Stripe does not guarantee event ordering. A paid renewal
                # invoice can arrive before customer.subscription.updated, so
                # reconcile the authoritative subscription in the same atomic
                # transaction before persisting the invoice.
                await self._apply_subscription(
                    connection,
                    event_id,
                    "customer.subscription.updated",
                    event_created,
                    authoritative_subscription,
                )
            await self._apply_invoice(
                connection, event_id, event_created, event_object
            )
            return True
        return False

    @staticmethod
    def _is_provisioning_metadata(metadata: Any) -> bool:
        return isinstance(metadata, Mapping) and "provisioning_request_id" in metadata

    async def _bound_provisioning_request(
        self,
        connection: AsyncConnection,
        *,
        metadata: Any,
    ) -> tuple[dict[str, Any], UUID, UUID, str, UUID]:
        request_id, user_id, device_id, serial_number, plan_code = (
            _provisioning_binding(metadata)
        )
        query = await connection.execute(
            """
            SELECT id, user_id, device_id, serial_number, plan_code,
                   provider_session_id, provider_customer_id,
                   provider_subscription_id, subscription_id, status,
                   expires_at, claim_deadline
              FROM public.provisioning_request
             WHERE id = %s
             FOR UPDATE
            """,
            (request_id,),
        )
        row = await query.fetchone()
        if row is None:
            raise BillingEventDeferred("provisioning request binding not visible")
        if (
            row["user_id"] != user_id
            or row["device_id"] != device_id
            or row["serial_number"] != serial_number
            or row["plan_code"] != plan_code
        ):
            raise BillingEventIgnored("unrecognized provisioning binding")
        return row, user_id, device_id, plan_code, request_id

    async def _apply_provisioning_checkout_completed(
        self,
        connection: AsyncConnection,
        event_id: str,
        event_created: int,
        checkout: Mapping[str, Any],
    ) -> None:
        row, _, _, _, request_id = await self._bound_provisioning_request(
            connection, metadata=checkout.get("metadata")
        )
        session_id = _identifier(checkout.get("id"), "cs_")
        customer_id = _identifier(checkout.get("customer"), "cus_")
        subscription_id = _identifier(checkout.get("subscription"), "sub_")
        if (
            checkout.get("status") != "complete"
            or checkout.get("mode") != "subscription"
            or row["provider_session_id"] is None
            or row["provider_customer_id"] is None
        ):
            raise BillingEventDeferred("provisioning checkout binding incomplete")
        if (
            row["provider_session_id"] != session_id
            or row["provider_customer_id"] != customer_id
            or (
                row["provider_subscription_id"] is not None
                and row["provider_subscription_id"] != subscription_id
            )
        ):
            raise BillingEventIgnored("provisioning checkout mismatch")
        authoritative_subscription = checkout.get(
            "_pinqeva_authoritative_subscription"
        )
        if (
            not isinstance(authoritative_subscription, Mapping)
            or _object_id(authoritative_subscription.get("id")) != subscription_id
        ):
            raise BillingEventDeferred("authoritative subscription is unavailable")
        await self._apply_subscription(
            connection,
            event_id,
            "checkout.session.completed",
            event_created,
            authoritative_subscription,
        )
        await connection.execute(
            """
            UPDATE public.provisioning_request
               SET provider_session_id = %s,
                   provider_customer_id = %s,
                   provider_subscription_id = %s,
                   updated_at = now()
             WHERE id = %s
            """,
            (session_id, customer_id, subscription_id, request_id),
        )

    async def _apply_provisioning_checkout_expired(
        self, connection: AsyncConnection, checkout: Mapping[str, Any]
    ) -> None:
        row, _, _, _, request_id = await self._bound_provisioning_request(
            connection, metadata=checkout.get("metadata")
        )
        session_id = _identifier(checkout.get("id"), "cs_")
        customer_id = _identifier(checkout.get("customer"), "cus_")
        if checkout.get("status") != "expired":
            raise BillingEventDeferred("checkout expiration not authoritative")
        if row["provider_session_id"] is None or row["provider_customer_id"] is None:
            raise BillingEventDeferred("provisioning checkout binding incomplete")
        if (
            row["provider_session_id"] != session_id
            or row["provider_customer_id"] != customer_id
        ):
            raise BillingEventIgnored("provisioning checkout mismatch")
        await connection.execute(
            """
            UPDATE public.provisioning_request
               SET status = 'expired', updated_at = now()
             WHERE id = %s AND status IN ('pending', 'creating', 'open')
            """,
            (request_id,),
        )

    async def _bound_checkout(
        self,
        connection: AsyncConnection,
        *,
        metadata: Any,
    ) -> tuple[dict[str, Any], UUID, UUID, str, UUID]:
        user_id, device_id, plan_code, checkout_id = _binding(metadata)
        query = await connection.execute(
            """
            SELECT id, user_id, device_id, plan_code, provider_session_id,
                   provider_customer_id, provider_subscription_id, status
              FROM public.billing_checkout_session
             WHERE id = %s
             FOR UPDATE
            """,
            (checkout_id,),
        )
        row = await query.fetchone()
        if row is None:
            # Structurally valid server metadata identifies one of our
            # reservations. A webhook can race the transaction that saves its
            # provider binding, so ask Stripe to retry rather than discard it.
            raise BillingEventDeferred("checkout binding not visible yet")
        if (
            row["user_id"] != user_id
            or row["device_id"] != device_id
            or row["plan_code"] != plan_code
        ):
            raise BillingEventIgnored("unrecognized binding")
        return row, user_id, device_id, plan_code, checkout_id

    async def _apply_checkout_completed(
        self,
        connection: AsyncConnection,
        event_id: str,
        event_created: int,
        checkout: Mapping[str, Any],
    ) -> None:
        row, user_id, device_id, _, checkout_id = await self._bound_checkout(
            connection, metadata=checkout.get("metadata")
        )
        session_id = _identifier(checkout.get("id"), "cs_")
        customer_id = _identifier(checkout.get("customer"), "cus_")
        subscription_id = _identifier(checkout.get("subscription"), "sub_")
        if (
            checkout.get("status") != "complete"
            or checkout.get("mode") != "subscription"
            or row["provider_session_id"] is None
            or row["provider_customer_id"] is None
        ):
            raise BillingEventDeferred("checkout binding incomplete")
        if (
            row["provider_session_id"] != session_id
            or row["provider_customer_id"] != customer_id
            or (
                row["provider_subscription_id"] is not None
                and row["provider_subscription_id"] != subscription_id
            )
        ):
            raise BillingEventIgnored("checkout mismatch")
        owner_query = await connection.execute(
            """
            SELECT 1 FROM public.ownership
             WHERE user_id = %s AND device_id = %s AND ended_at IS NULL
             FOR UPDATE
            """,
            (user_id, device_id),
        )
        # A completed Checkout can race a device release. Stripe reconciliation
        # happens before this transaction. If ownership is already gone, use
        # the reconciled Subscription to stop local access and atomically queue
        # compensation without making any provider call under database locks.
        owner_active = await owner_query.fetchone() is not None
        if not owner_active:
            authoritative_subscription = checkout.get(
                "_pinqeva_authoritative_subscription"
            )
            if (
                not isinstance(authoritative_subscription, Mapping)
                or _object_id(authoritative_subscription.get("id"))
                != subscription_id
            ):
                raise BillingEventDeferred(
                    "authoritative subscription is unavailable"
                )
            await self._apply_subscription(
                connection,
                event_id,
                "checkout.session.completed",
                event_created,
                authoritative_subscription,
            )
        await connection.execute(
            """
            UPDATE public.billing_checkout_session
               SET status = 'completed', provider_subscription_id = %s,
                   completed_at = now(), updated_at = now()
             WHERE id = %s AND status IN ('pending', 'completed')
            """,
            (subscription_id, checkout_id),
        )

    async def _apply_checkout_expired(
        self, connection: AsyncConnection, checkout: Mapping[str, Any]
    ) -> None:
        row, _, _, _, checkout_id = await self._bound_checkout(
            connection, metadata=checkout.get("metadata")
        )
        session_id = _identifier(checkout.get("id"), "cs_")
        customer_id = _identifier(checkout.get("customer"), "cus_")
        if checkout.get("status") != "expired":
            raise BillingEventDeferred("checkout expiration not authoritative")
        if row["provider_session_id"] is None or row["provider_customer_id"] is None:
            raise BillingEventDeferred("checkout binding incomplete")
        if (
            row["provider_session_id"] != session_id
            or row["provider_customer_id"] != customer_id
        ):
            raise BillingEventIgnored("checkout mismatch")
        await connection.execute(
            """
            UPDATE public.billing_checkout_session
               SET status = 'expired', updated_at = now()
             WHERE id = %s AND provider_session_id = %s
               AND status IN ('pending', 'expired')
            """,
            (checkout_id, session_id),
        )

    async def _apply_subscription(
        self,
        connection: AsyncConnection,
        event_id: str,
        event_type: str,
        event_created: int,
        subscription: Mapping[str, Any],
    ) -> None:
        is_provisioning = self._is_provisioning_metadata(
            subscription.get("metadata")
        )
        if is_provisioning:
            row, user_id, device_id, plan_code, checkout_id = (
                await self._bound_provisioning_request(
                    connection, metadata=subscription.get("metadata")
                )
            )
        else:
            row, user_id, device_id, plan_code, checkout_id = (
                await self._bound_checkout(
                    connection, metadata=subscription.get("metadata")
                )
            )
        provider_subscription_id = _identifier(subscription.get("id"), "sub_")
        customer_id = _identifier(subscription.get("customer"), "cus_")
        if row["provider_session_id"] is None or row["provider_customer_id"] is None:
            raise BillingEventDeferred("checkout binding incomplete")
        if row["provider_customer_id"] != customer_id:
            raise BillingEventIgnored("customer mismatch")
        if (
            row["provider_subscription_id"] is not None
            and row["provider_subscription_id"] != provider_subscription_id
        ):
            raise BillingEventIgnored("subscription mismatch")

        if is_provisioning:
            owner_query = await connection.execute(
                """
                SELECT user_id FROM public.ownership
                 WHERE device_id = %s AND ended_at IS NULL
                 FOR UPDATE
                """,
                (device_id,),
            )
        else:
            owner_query = await connection.execute(
                """
                SELECT 1 FROM public.ownership
                 WHERE user_id = %s AND device_id = %s AND ended_at IS NULL
                 FOR UPDATE
                """,
                (user_id, device_id),
            )
        owner = await owner_query.fetchone()
        owner_active = owner is not None
        owner_matches = (
            owner_active
            if not is_provisioning
            else owner is not None and owner["user_id"] == user_id
        )
        raw_status = subscription.get("status")
        provider_terminal = raw_status in {"canceled", "incomplete_expired"}

        items = subscription.get("items")
        item_data = items.get("data") if isinstance(items, Mapping) else None
        if not isinstance(item_data, list) or len(item_data) != 1:
            raise BillingEventIgnored("subscription must have one item")
        item = item_data[0]
        if not isinstance(item, Mapping) or _integer(item.get("quantity"), 1) != 1:
            raise BillingEventIgnored("subscription quantity mismatch")
        price = item.get("price")
        if not isinstance(price, Mapping):
            raise BillingEventDeferred("authoritative Price is not expanded")
        price_id = _identifier(price.get("id"), "price_")
        configured_plan_code = next(
            (
                configured_code
                for configured_code, configured_price, _ in self.settings.stripe_price_map
                if configured_price == price_id
            ),
            None,
        )

        starts_at = _epoch(
            item.get("current_period_start", subscription.get("start_date"))
        )
        period_end = _epoch(item.get("current_period_end"))
        provider_event_at = _epoch(event_created)
        if starts_at is None or period_end is None or provider_event_at is None:
            raise BillingEventIgnored("missing subscription period")
        if provider_terminal:
            provider_status = "ended"
        elif raw_status in {
            "incomplete",
            "trialing",
            "active",
            "past_due",
            "unpaid",
            "paused",
        }:
            provider_status = str(raw_status)
        else:
            raise BillingEventIgnored("unknown subscription status")
        if is_provisioning:
            request_active = (
                row["status"] not in {"expired", "failed"}
                and (
                    row["status"] not in {"paid", "claiming"}
                    or (
                        row["claim_deadline"] is not None
                        and row["claim_deadline"] > datetime.now(UTC)
                    )
                )
            )
            access_allowed = request_active and (
                owner is None or owner_matches
            )
        else:
            access_allowed = owner_matches
        status = provider_status if access_allowed else "ended"

        plan_query = await connection.execute(
            """
            SELECT code, duration_months, price_cents, currency, active,
                   provider_price_id, provider_product_id
              FROM (
                SELECT p.code, history.duration_months,
                       history.amount_cents AS price_cents, history.currency,
                       p.active, history.provider_price_id,
                       history.provider_product_id, 1 AS priority
                  FROM public.plan_price_history history
                  JOIN public.plan p ON p.code = history.plan_code
                 WHERE history.provider_price_id = %s
                UNION ALL
                SELECT p.code, p.duration_months, p.price_cents, p.currency,
                       p.active, p.provider_price_id, p.provider_product_id,
                       2 AS priority
                  FROM public.plan p
                 WHERE p.provider_price_id = %s
                UNION ALL
                SELECT p.code, p.duration_months, p.price_cents, p.currency,
                       p.active, %s AS provider_price_id,
                       p.provider_product_id, 3 AS priority
                  FROM public.plan p
                 WHERE p.code = %s
              ) catalog
             ORDER BY priority
             LIMIT 1
            """,
            (
                price_id,
                price_id,
                price_id,
                configured_plan_code,
            ),
        )
        plan = await plan_query.fetchone()
        if plan is None or (status != "ended" and plan["active"] is not True):
            raise BillingEventDeferred("local billing plan unavailable")
        plan_code = str(plan["code"])
        try:
            self._assert_price_matches_plan(
                plan,
                price,
                require_active=status != "ended",
            )
        except BillingError:
            raise BillingEventDeferred("provider catalog mismatch") from None
        cancellation_details = subscription.get("cancellation_details")
        ended_reason = None
        if status == "ended" and isinstance(cancellation_details, Mapping):
            reason = cancellation_details.get("reason")
            if isinstance(reason, str):
                ended_reason = reason[:64]
        cancellation_pending = not access_allowed and not provider_terminal
        if not access_allowed:
            ended_reason = (
                "provisioning_request_expired"
                if is_provisioning
                else "ownership_lost_checkout"
            )
        provider_terminal_event_at = (
            provider_event_at if provider_terminal else None
        )

        subscription_upsert = await connection.execute(
            """
            INSERT INTO public.subscription (
                id, user_id, device_id, plan_code, status, starts_at,
                current_period_end, cancel_at_period_end,
                provider_customer_id, provider_subscription_id,
                provider_price_id, provider_event_created_at,
                provider_event_id, provider_terminal_event_at, ended_reason
            ) VALUES (
                gen_random_uuid(), %s, %s, %s, %s, %s, %s, %s,
                %s, %s, %s, %s, %s, %s, %s
            )
            ON CONFLICT (provider_subscription_id) DO UPDATE SET
                plan_code = EXCLUDED.plan_code,
                status = EXCLUDED.status,
                starts_at = EXCLUDED.starts_at,
                current_period_end = EXCLUDED.current_period_end,
                cancel_at_period_end = EXCLUDED.cancel_at_period_end,
                provider_customer_id = EXCLUDED.provider_customer_id,
                provider_price_id = EXCLUDED.provider_price_id,
                provider_event_created_at = EXCLUDED.provider_event_created_at,
                provider_event_id = EXCLUDED.provider_event_id,
                provider_terminal_event_at = COALESCE(
                    EXCLUDED.provider_terminal_event_at,
                    public.subscription.provider_terminal_event_at
                ),
                ended_reason = EXCLUDED.ended_reason,
                updated_at = now()
            WHERE public.subscription.user_id = EXCLUDED.user_id
              AND public.subscription.device_id = EXCLUDED.device_id
              AND (
                public.subscription.provider_event_created_at IS NULL
                OR (
                    public.subscription.provider_event_created_at,
                    COALESCE(public.subscription.provider_event_id, '')
                ) < (
                    EXCLUDED.provider_event_created_at,
                    EXCLUDED.provider_event_id
                )
                OR (
                    EXCLUDED.provider_terminal_event_at IS NOT NULL
                    AND public.subscription.provider_terminal_event_at IS NULL
                )
              )
            RETURNING id
            """,
            (
                user_id,
                device_id,
                plan_code,
                status,
                starts_at,
                period_end,
                (
                    bool(subscription.get("cancel_at_period_end", False))
                    if access_allowed
                    else False
                ),
                customer_id,
                provider_subscription_id,
                price_id,
                provider_event_at,
                event_id,
                provider_terminal_event_at,
                ended_reason,
            ),
        )
        local_subscription = await subscription_upsert.fetchone()
        if local_subscription is None:
            subscription_query = await connection.execute(
                """
                SELECT id FROM public.subscription
                 WHERE provider_subscription_id = %s
                   AND user_id = %s AND device_id = %s
                 FOR UPDATE
                """,
                (provider_subscription_id, user_id, device_id),
            )
            local_subscription = await subscription_query.fetchone()
        if local_subscription is None:
            raise BillingEventDeferred("local subscription unavailable")
        if cancellation_pending:
            await self._enqueue_former_owner_cancellation(
                connection,
                subscription_id=local_subscription["id"],
                provider_subscription_id=provider_subscription_id,
            )
        if is_provisioning:
            request_status = row["status"]
            claim_deadline = row["claim_deadline"]
            paid_at = None
            if status in {"active", "trialing"} and access_allowed:
                if request_status != "completed":
                    request_status = "paid"
                claim_deadline = claim_deadline or (
                    datetime.now(UTC)
                    + timedelta(seconds=self.settings.claim_ttl_seconds)
                )
                paid_at = datetime.now(UTC)
            elif status == "ended" and request_status != "completed":
                request_status = "expired"
            await connection.execute(
                """
                UPDATE public.provisioning_request
                   SET provider_subscription_id = %s,
                       subscription_id = %s,
                       status = %s,
                       claim_deadline = COALESCE(claim_deadline, %s),
                       paid_at = COALESCE(paid_at, %s),
                       updated_at = now()
                 WHERE id = %s
                """,
                (
                    provider_subscription_id,
                    local_subscription["id"],
                    request_status,
                    claim_deadline,
                    paid_at,
                    checkout_id,
                ),
            )
        else:
            await connection.execute(
                """
                UPDATE public.billing_checkout_session
                   SET provider_subscription_id = %s, updated_at = now()
                 WHERE id = %s
                """,
                (provider_subscription_id, checkout_id),
            )

    async def _apply_invoice(
        self,
        connection: AsyncConnection,
        event_id: str,
        event_created: int,
        invoice: Mapping[str, Any],
    ) -> None:
        provider_invoice_id = _identifier(invoice.get("id"), "in_")
        provider_subscription_id = _invoice_subscription_id(invoice)
        if provider_subscription_id is None:
            raise BillingEventIgnored("invoice has no subscription")

        subscription_query = await connection.execute(
            """
            SELECT id FROM public.subscription
             WHERE provider_subscription_id = %s
            """,
            (provider_subscription_id,),
        )
        local_subscription = await subscription_query.fetchone()
        if local_subscription is None:
            raise BillingEventDeferred("subscription event has not arrived")

        transitions = invoice.get("status_transitions")
        transitions = transitions if isinstance(transitions, Mapping) else {}
        total_tax_amounts = invoice.get("total_tax_amounts")
        if isinstance(total_tax_amounts, list):
            tax_cents = sum(
                _integer(item.get("amount"))
                for item in total_tax_amounts
                if isinstance(item, Mapping)
            )
        else:
            total_taxes = invoice.get("total_taxes")
            if isinstance(total_taxes, list):
                tax_cents = sum(
                    _integer(item.get("amount"))
                    for item in total_taxes
                    if isinstance(item, Mapping)
                )
            else:
                tax_cents = _integer(invoice.get("tax"))
        provider_event_at = _epoch(event_created)
        period_start = _epoch(invoice.get("period_start"))
        period_end = _epoch(invoice.get("period_end"))
        issued_at = _epoch(
            transitions.get("finalized_at", invoice.get("created"))
        )
        paid_at = _epoch(transitions.get("paid_at"), required=False)
        if None in (provider_event_at, period_start, period_end, issued_at):
            raise BillingEventIgnored("invoice timestamps missing")
        raw_status = invoice.get("status")
        invoice_status = raw_status if isinstance(raw_status, str) else "draft"

        await connection.execute(
            """
            INSERT INTO public.invoice (
                id, subscription_id, provider_invoice_id, billing_reason,
                status, subtotal_cents, tax_cents, total_cents,
                amount_paid_cents, currency, period_start, period_end,
                issued_at, paid_at, attempt_count, provider_event_created_at,
                provider_event_id
            ) VALUES (
                gen_random_uuid(), %s, %s, %s, %s, %s, %s, %s,
                %s, %s, %s, %s, %s, %s, %s, %s, %s
            )
            ON CONFLICT (provider_invoice_id) DO UPDATE SET
                billing_reason = EXCLUDED.billing_reason,
                status = EXCLUDED.status,
                subtotal_cents = EXCLUDED.subtotal_cents,
                tax_cents = EXCLUDED.tax_cents,
                total_cents = EXCLUDED.total_cents,
                amount_paid_cents = EXCLUDED.amount_paid_cents,
                currency = EXCLUDED.currency,
                period_start = EXCLUDED.period_start,
                period_end = EXCLUDED.period_end,
                issued_at = EXCLUDED.issued_at,
                paid_at = EXCLUDED.paid_at,
                attempt_count = EXCLUDED.attempt_count,
                provider_event_created_at = EXCLUDED.provider_event_created_at,
                provider_event_id = EXCLUDED.provider_event_id,
                updated_at = now()
            WHERE public.invoice.subscription_id = EXCLUDED.subscription_id
              AND (
                public.invoice.provider_event_created_at IS NULL
                OR (
                    public.invoice.provider_event_created_at,
                    COALESCE(public.invoice.provider_event_id, '')
                ) < (
                    EXCLUDED.provider_event_created_at,
                    EXCLUDED.provider_event_id
                )
              )
            """,
            (
                local_subscription["id"],
                provider_invoice_id,
                invoice.get("billing_reason")
                if isinstance(invoice.get("billing_reason"), str)
                else None,
                invoice_status[:32],
                _integer(invoice.get("subtotal")),
                tax_cents,
                _integer(invoice.get("total")),
                _integer(invoice.get("amount_paid")),
                _currency(invoice.get("currency")),
                period_start,
                period_end,
                issued_at,
                paid_at,
                _integer(invoice.get("attempt_count")),
                provider_event_at,
                event_id,
            ),
        )
