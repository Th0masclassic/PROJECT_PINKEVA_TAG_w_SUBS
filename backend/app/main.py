from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import Annotated, AsyncIterator
from uuid import UUID, uuid4

from fastapi import Depends, FastAPI, Header, HTTPException, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from .auth import AuthenticatedPrincipal
from .billing import BillingError, BillingService, MAX_WEBHOOK_BYTES
from .config import get_settings
from .database import Database
from .models import (
    DeviceClaimComplete,
    DeviceClaimResponse,
    DeviceClaimStart,
    DeviceClaimStartResponse,
    DeviceReleaseComplete,
    DeviceReleaseResponse,
    DeviceReleaseStart,
    DeviceReleaseStartResponse,
    BillingUrlResponse,
    DeviceSubscriptionResponse,
    StripeWebhookResponse,
    SubscriptionCheckoutRequest,
    SubscriptionPortalRequest,
    validate_idempotency_key,
)
from .service import ProvisioningError, ProvisioningService


logger = logging.getLogger("pinqeva.api")

SAFE_PROVISIONING_MESSAGES = {
    "DEVICE_AUTHORIZATION_REJECTED": "The tag could not be verified.",
    "DEVICE_UNAVAILABLE": "This tag is unavailable.",
    "PROVISIONING_IN_PROGRESS": "This tag is already being set up.",
    "SESSION_NOT_FOUND": "This setup session is no longer available.",
    "RECOVERY_REQUIRED": "This tag needs support before setup can continue.",
}

SAFE_BILLING_MESSAGES = {
    "TAG_UNAVAILABLE": "This tag is unavailable.",
    "PLAN_UNAVAILABLE": "This subscription plan is unavailable.",
    "SUBSCRIPTION_EXISTS": "This tag already has a current subscription.",
    "CHECKOUT_IN_PROGRESS": "A checkout is already in progress for this tag.",
    "SUBSCRIPTION_NOT_MANAGEABLE": "This subscription cannot be managed yet.",
    "BILLING_UNAVAILABLE": "Billing is temporarily unavailable. Please try again.",
    "INVALID_WEBHOOK": "The webhook could not be accepted.",
    "BILLING_EVENT_DEFERRED": "The billing event will be retried.",
}


def _request_id(request: Request) -> str:
    return getattr(request.state, "request_id", str(uuid4()))


def _error_response(
    request: Request,
    *,
    status_code: int,
    code: str,
    message: str,
    headers: dict[str, str] | None = None,
) -> JSONResponse:
    request_id = _request_id(request)
    response_headers = {"X-Request-ID": request_id, **(headers or {})}
    return JSONResponse(
        status_code=status_code,
        headers=response_headers,
        content={
            "error": {
                "code": code,
                "message": message,
                "request_id": request_id,
            }
        },
    )


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    database = Database(settings)
    await database.open()
    app.state.database = database
    app.state.service = ProvisioningService(settings)
    app.state.billing = BillingService(settings)
    try:
        yield
    finally:
        await database.close()


app = FastAPI(
    title="Pinqeva Provisioning API",
    version="0.1.0",
    docs_url=None,
    redoc_url=None,
    lifespan=lifespan,
)


@app.middleware("http")
async def request_context(request: Request, call_next):
    request.state.request_id = str(uuid4())
    response = await call_next(request)
    response.headers["X-Request-ID"] = request.state.request_id
    return response


def idempotency_header(
    idempotency_key: Annotated[str, Header(alias="Idempotency-Key")],
) -> str:
    try:
        return validate_idempotency_key(idempotency_key)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from None


@app.exception_handler(RequestValidationError)
async def validation_error_handler(request: Request, _: RequestValidationError):
    return _error_response(
        request,
        status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
        code="INVALID_REQUEST",
        message="Please check the information and try again.",
    )


@app.exception_handler(HTTPException)
async def http_error_handler(request: Request, exc: HTTPException):
    if exc.status_code == status.HTTP_401_UNAUTHORIZED:
        code = "AUTHENTICATION_REQUIRED"
        message = "Authentication is required. Please sign in again."
    elif exc.status_code == status.HTTP_403_FORBIDDEN:
        code = "REQUEST_FORBIDDEN"
        message = "This request is not allowed."
    elif exc.status_code == status.HTTP_404_NOT_FOUND:
        code = "NOT_FOUND"
        message = "The requested resource was not found."
    else:
        code = "REQUEST_REJECTED"
        message = "The request could not be completed."
    return _error_response(
        request,
        status_code=exc.status_code,
        code=code,
        message=message,
        headers=exc.headers,
    )


@app.exception_handler(ProvisioningError)
async def provisioning_error_handler(request: Request, exc: ProvisioningError):
    return _error_response(
        request,
        status_code=exc.status_code,
        code=exc.code,
        message=SAFE_PROVISIONING_MESSAGES.get(
            exc.code, "The request could not be completed."
        ),
    )


@app.exception_handler(BillingError)
async def billing_error_handler(request: Request, exc: BillingError):
    return _error_response(
        request,
        status_code=exc.status_code,
        code=exc.code,
        message=SAFE_BILLING_MESSAGES.get(
            exc.code, "The request could not be completed."
        ),
    )


@app.exception_handler(Exception)
async def unexpected_error_handler(request: Request, exc: Exception):
    request_id = _request_id(request)
    logger.error(
        "Unhandled API error request_id=%s type=%s",
        request_id,
        type(exc).__name__,
    )
    return _error_response(
        request,
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        code="INTERNAL_ERROR",
        message="The service is temporarily unavailable. Please try again.",
    )


@app.get("/health", include_in_schema=False)
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/ready", include_in_schema=False, response_model=None)
async def readiness(request: Request) -> dict[str, str] | JSONResponse:
    try:
        async with app.state.database.transaction() as connection:
            await connection.execute("SELECT 1")
    except Exception as exc:
        request_id = _request_id(request)
        logger.warning(
            "Database readiness check failed request_id=%s type=%s",
            request_id,
            type(exc).__name__,
        )
        return _error_response(
            request,
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            code="SERVICE_UNAVAILABLE",
            message="The service is temporarily unavailable. Please try again.",
        )
    return {"status": "ready"}


@app.get(
    "/v1/devices/{device_id}/subscription",
    response_model=DeviceSubscriptionResponse,
)
async def device_subscription(
    device_id: UUID,
    principal: AuthenticatedPrincipal,
) -> DeviceSubscriptionResponse:
    return await app.state.billing.get_device_subscription(
        app.state.database,
        user_id=principal.user_id,
        device_id=device_id,
    )


@app.post(
    "/v1/devices/{device_id}/subscription/checkout",
    response_model=BillingUrlResponse,
    status_code=201,
)
async def subscription_checkout(
    device_id: UUID,
    request: SubscriptionCheckoutRequest,
    principal: AuthenticatedPrincipal,
) -> BillingUrlResponse:
    return await app.state.billing.create_checkout(
        app.state.database,
        user_id=principal.user_id,
        device_id=device_id,
        plan_code=request.plan_code,
    )


@app.post(
    "/v1/devices/{device_id}/subscription/portal",
    response_model=BillingUrlResponse,
    status_code=201,
)
async def subscription_portal(
    device_id: UUID,
    principal: AuthenticatedPrincipal,
    request: SubscriptionPortalRequest | None = None,
) -> BillingUrlResponse:
    return await app.state.billing.create_portal(
        app.state.database,
        user_id=principal.user_id,
        device_id=device_id,
        action=request.action if request else "update",
    )


@app.post(
    "/v1/billing/stripe/webhook",
    response_model=StripeWebhookResponse,
    include_in_schema=False,
)
async def stripe_webhook(
    request: Request,
    stripe_signature: Annotated[
        str | None, Header(alias="Stripe-Signature")
    ] = None,
) -> StripeWebhookResponse:
    content_length = request.headers.get("Content-Length")
    if content_length:
        try:
            parsed_length = int(content_length)
            if parsed_length < 0 or parsed_length > MAX_WEBHOOK_BYTES:
                raise BillingError("INVALID_WEBHOOK", 400)
        except ValueError:
            raise BillingError("INVALID_WEBHOOK", 400) from None
    payload = await _read_limited_body(request, MAX_WEBHOOK_BYTES)
    return await app.state.billing.receive_webhook(
        app.state.database,
        payload=payload,
        signature=stripe_signature or "",
    )


async def _read_limited_body(request: Request, limit: int) -> bytes:
    chunks: list[bytes] = []
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > limit:
            raise BillingError("INVALID_WEBHOOK", 400)
        chunks.append(chunk)
    return b"".join(chunks)


@app.post(
    "/v1/devices/claim",
    response_model=DeviceClaimStartResponse,
    status_code=201,
)
async def start_device_claim(
    request: DeviceClaimStart,
    principal: AuthenticatedPrincipal,
    idempotency_key: Annotated[str, Depends(idempotency_header)],
) -> DeviceClaimStartResponse:
    async with app.state.database.transaction() as connection:
        return await app.state.service.start_claim(
            connection,
            user_id=principal.user_id,
            idempotency_key=idempotency_key,
            request=request,
        )


@app.post(
    "/v1/devices/claim/complete",
    response_model=DeviceClaimResponse,
)
async def complete_device_claim(
    request: DeviceClaimComplete,
    principal: AuthenticatedPrincipal,
) -> DeviceClaimResponse:
    async with app.state.database.transaction() as connection:
        return await app.state.service.complete_claim(
            connection, user_id=principal.user_id, request=request
        )


@app.post(
    "/v1/devices/{device_id}/release",
    response_model=DeviceReleaseStartResponse,
    status_code=201,
)
async def start_device_release(
    device_id: UUID,
    request: DeviceReleaseStart,
    principal: AuthenticatedPrincipal,
    idempotency_key: Annotated[str, Depends(idempotency_header)],
) -> DeviceReleaseStartResponse:
    async with app.state.database.transaction() as connection:
        return await app.state.service.start_release(
            connection,
            user_id=principal.user_id,
            device_id=device_id,
            idempotency_key=idempotency_key,
            request=request,
        )


@app.post(
    "/v1/devices/{device_id}/release/complete",
    response_model=DeviceReleaseResponse,
)
async def complete_device_release(
    device_id: UUID,
    request: DeviceReleaseComplete,
    principal: AuthenticatedPrincipal,
) -> DeviceReleaseResponse:
    async with app.state.database.transaction() as connection:
        return await app.state.service.complete_release(
            connection,
            user_id=principal.user_id,
            device_id=device_id,
            request=request,
        )
