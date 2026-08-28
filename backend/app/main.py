from __future__ import annotations

import asyncio
import logging
import sys
from collections.abc import Callable
from contextlib import asynccontextmanager
from typing import Annotated, AsyncIterator
from uuid import UUID, uuid4

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response

from .admin import AdminError, AdminService, router as admin_router
from .anisette_provider import NativeAnisetteError, NativeAnisetteService
from .apple_auth import AppleAuthManager, AppleAuthenticationError
from .auth import AccountAccessError, AuthenticatedPrincipal
from .billing import BillingError, BillingService, MAX_WEBHOOK_BYTES
from .config import get_settings
from .database import Database
from .entitlement import EntitlementService
from .firmware import FirmwareError, FirmwareService
from .location import LocationError, LocationService
from .notifications import (
    ExpoPushGateway,
    NotificationError,
    NotificationService,
    NotificationWorker,
)
from .models import (
    DeviceClaimComplete,
    DeviceClaimResponse,
    DeviceClaimStart,
    DeviceClaimStartResponse,
    DeviceEntitlementRequest,
    DeviceEntitlementResponse,
    DeviceEntitlementAcknowledge,
    DeviceEntitlementAcknowledgeResponse,
    FirmwareAvailabilityResponse,
    FirmwareUpdateAcknowledge,
    FirmwareUpdateAcknowledgeResponse,
    FirmwareUpdateSessionRequest,
    FirmwareUpdateSessionResponse,
    DeviceProvisioningRequestResponse,
    DeviceProvisioningRequestStart,
    DeviceReleaseComplete,
    DeviceReleaseResponse,
    DeviceReleaseStart,
    DeviceReleaseStartResponse,
    DeviceLocationHistoryResponse,
    DeviceLocationReportResponse,
    BillingUrlResponse,
    DeviceSubscriptionResponse,
    StripeWebhookResponse,
    SubscriptionCheckoutRequest,
    SubscriptionPortalRequest,
    MobilePushTokenRegistration,
    MobilePushTokenResponse,
    UserNotificationListResponse,
    UserNotificationReadResponse,
    ProvisioningRequestCheckout,
    ProvisioningRequestCheckoutResponse,
    validate_idempotency_key,
)
from .service import ProvisioningError, ProvisioningService


logger = logging.getLogger("pinqeva.api")


def _selector_loop_factory(*, use_subprocess: bool = False) -> Callable[[], asyncio.AbstractEventLoop]:
    """Return the event-loop class required by Psycopg on Windows."""

    del use_subprocess
    return asyncio.SelectorEventLoop


def _configure_direct_uvicorn_loop() -> None:
    """Make ``python -m uvicorn app.main:app`` Psycopg-compatible on Windows.

    Recent Uvicorn releases explicitly choose ``ProactorEventLoop`` for their
    default Windows loop. Psycopg's async pool requires a selector loop. The
    normal local launcher passes this loop explicitly; this hook covers the
    direct Uvicorn command developers commonly use as well.
    """

    if sys.platform != "win32":
        return

    try:
        from uvicorn import config as uvicorn_config
    except ImportError:  # pragma: no cover - Uvicorn is a runtime dependency
        return

    for loop_name in ("auto", "asyncio"):
        if loop_name in uvicorn_config.LOOP_FACTORIES:
            uvicorn_config.LOOP_FACTORIES[loop_name] = "app.main:_selector_loop_factory"


_configure_direct_uvicorn_loop()

SAFE_PROVISIONING_MESSAGES = {
    "DEVICE_AUTHORIZATION_REJECTED": "The tag could not be verified.",
    "DEVICE_UNAVAILABLE": "This tag is unavailable.",
    "PROVISIONING_IN_PROGRESS": "This tag is already being set up.",
    "SESSION_NOT_FOUND": "This setup session is no longer available.",
    "RECOVERY_REQUIRED": "This tag needs support before setup can continue.",
    "SUBSCRIPTION_REQUIRED": "An active subscription is required before setup can continue.",
}

SAFE_BILLING_MESSAGES = {
    "DEVICE_AUTHORIZATION_REJECTED": "The tag could not be verified.",
    "TAG_UNAVAILABLE": "This tag is unavailable.",
    "TAG_NOT_READY": "This tag is not ready for activation yet.",
    "SUBSCRIPTION_REQUIRED": "An active subscription is required for this tag.",
    "PROVISIONING_REQUEST_NOT_FOUND": "This setup request is no longer available.",
    "PROVISIONING_REQUEST_EXPIRED": "This setup request expired. Start again to continue.",
    "ENTITLEMENT_UNAVAILABLE": "Tag activation is temporarily unavailable. Please try again.",
    "ENTITLEMENT_ACK_REJECTED": "The tag update could not be confirmed. Please try the update again.",
    "PLAN_UNAVAILABLE": "This subscription plan is unavailable.",
    "SUBSCRIPTION_EXISTS": "This tag already has a current subscription.",
    "CHECKOUT_IN_PROGRESS": "A checkout is already in progress for this tag.",
    "SUBSCRIPTION_NOT_MANAGEABLE": "This subscription cannot be managed yet.",
    "BILLING_UNAVAILABLE": "Billing is temporarily unavailable. Please try again.",
    "INVALID_WEBHOOK": "The webhook could not be accepted.",
    "BILLING_EVENT_DEFERRED": "The billing event will be retried.",
}

SAFE_ADMIN_MESSAGES = {
    "ADMIN_ACCESS_DENIED": "Administrator access is required.",
    "ADMIN_OWNER_REQUIRED": "Owner access is required for this action.",
    "ADMIN_MFA_REQUIRED": "Multi-factor authentication is required.",
    "ADMIN_RESOURCE_NOT_FOUND": "The requested resource was not found.",
    "ADMIN_CONFLICT": "The resource changed or already exists. Refresh and try again.",
    "ADMIN_OWNER_IMMUTABLE": "Environment owners cannot be removed here.",
    "ADMIN_PROVIDER_UNAVAILABLE": "The payment provider is temporarily unavailable.",
    "ADMIN_INVALID_REQUEST": "Please check the information and try again.",
    "ADMIN_PROTECTED_ACCOUNT": "This protected account cannot be suspended.",
    "ADMIN_TARGET_BANNED": "This account is suspended. Restore access before sending a message.",
}

SAFE_LOCATION_MESSAGES = {
    "LOCATION_UNAVAILABLE": "Location reports are temporarily unavailable. Please try again.",
}

SAFE_FIRMWARE_MESSAGES = {
    "DEVICE_AUTHORIZATION_REJECTED": "The tag could not be verified.",
    "TAG_UNAVAILABLE": "This tag is unavailable.",
    "TAG_NOT_READY": "This tag is not ready for a firmware update.",
    "FIRMWARE_UNAVAILABLE": "Firmware updates are temporarily unavailable. Please try again.",
    "FIRMWARE_UP_TO_DATE": "This tag already has the latest firmware.",
    "FIRMWARE_NOT_FOUND": "This firmware release is no longer available.",
    "FIRMWARE_ACK_REJECTED": "The firmware installation could not be confirmed.",
}


def _configure_application_logging() -> None:
    """Send structured application events to Uvicorn's visible error stream."""

    application_logger = logging.getLogger("pinqeva")
    uvicorn_logger = logging.getLogger("uvicorn")
    if uvicorn_logger.handlers:
        application_logger.handlers = list(uvicorn_logger.handlers)
        application_logger.propagate = False
    application_logger.setLevel(logging.INFO)


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
    _configure_application_logging()
    settings = get_settings()
    native_anisette: NativeAnisetteService | None = None
    opened_database: Database | None = None
    notification_stop = asyncio.Event()
    notification_task: asyncio.Task[None] | None = None
    try:
        if settings.findmy_anisette_provider == "native":
            native_anisette = NativeAnisetteService(
                settings.findmy_anisette_url,
                settings.findmy_anisette_state_path,
            )
            logger.info("native_anisette_starting")
            try:
                await asyncio.to_thread(native_anisette.start)
            except NativeAnisetteError as exc:
                logger.error(
                    "native_anisette_start_failed error_type=%s",
                    type(exc).__name__,
                )
                raise RuntimeError("Native Anisette startup failed") from None

        findmy_auth: AppleAuthManager | None = None
        if settings.findmy_apple_id or settings.findmy_auth_file:
            findmy_auth = AppleAuthManager(
                apple_id=settings.findmy_apple_id,
                apple_password=settings.findmy_apple_password,
                second_factor=settings.findmy_second_factor,
                anisette_url=settings.findmy_anisette_url,
                timeout_seconds=settings.findmy_request_timeout_seconds,
                auth_file=settings.findmy_auth_file,
                login_on_startup=settings.findmy_login_on_startup,
            )
        if findmy_auth is not None and findmy_auth.should_login_on_startup:
            logger.info("findmy_authentication_starting")
            try:
                await asyncio.to_thread(findmy_auth.initialize)
                logger.info("findmy_authenticated")
            except AppleAuthenticationError as exc:
                logger.error(
                    "findmy_authentication_failed error_type=%s error=%s",
                    type(exc).__name__,
                    str(exc),
                )
                raise RuntimeError("Find My authentication failed") from None

        database = Database(settings)
        await database.open()
        opened_database = database
        app.state.database = database
        app.state.service = ProvisioningService(settings)
        app.state.entitlement = EntitlementService(settings)
        app.state.firmware = FirmwareService(settings)
        app.state.findmy_auth = findmy_auth
        app.state.location = LocationService(settings, auth_manager=findmy_auth)
        app.state.billing = BillingService(settings)
        app.state.admin = AdminService(settings)
        app.state.notifications = NotificationService()
        app.state.settings = settings
        app.state.native_anisette = native_anisette
        await app.state.billing.bootstrap_catalog(database)
        if settings.notification_worker_enabled:
            notification_worker = NotificationWorker(
                database,
                ExpoPushGateway(settings.expo_push_access_token),
                poll_interval_seconds=settings.notification_poll_interval_seconds,
            )
            app.state.notification_worker = notification_worker
            notification_task = asyncio.create_task(
                notification_worker.run(notification_stop),
                name="renewal-notification-worker",
            )
        yield
    finally:
        notification_stop.set()
        if notification_task is not None:
            await notification_task
        if opened_database is not None:
            await opened_database.close()
        if native_anisette is not None:
            await asyncio.to_thread(native_anisette.stop)


app = FastAPI(
    title="Pinqeva Provisioning API",
    version="0.1.0",
    docs_url=None,
    redoc_url=None,
    lifespan=lifespan,
)
app.include_router(admin_router)


@app.middleware("http")
async def request_context(request: Request, call_next):
    request.state.request_id = str(uuid4())
    is_admin_request = request.url.path.startswith("/v1/admin")
    origin = request.headers.get("Origin")
    settings = getattr(request.app.state, "settings", None)
    allowed_origins = settings.admin_allowed_origins if settings else ()
    if is_admin_request and origin and origin not in allowed_origins:
        return _error_response(
            request,
            status_code=status.HTTP_403_FORBIDDEN,
            code="REQUEST_FORBIDDEN",
            message="This request is not allowed.",
        )
    if (
        is_admin_request
        and origin
        and request.method == "OPTIONS"
        and request.headers.get("Access-Control-Request-Method")
    ):
        return Response(
            status_code=status.HTTP_204_NO_CONTENT,
            headers={
                "Access-Control-Allow-Origin": origin,
                "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
                "Access-Control-Allow-Headers": "Authorization, Content-Type",
                "Access-Control-Max-Age": "600",
                "Vary": "Origin",
                "X-Request-ID": request.state.request_id,
                "Cache-Control": "no-store",
            },
        )
    response = await call_next(request)
    response.headers["X-Request-ID"] = request.state.request_id
    if is_admin_request:
        response.headers["Cache-Control"] = "no-store"
        response.headers["Pragma"] = "no-cache"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        if origin:
            response.headers["Access-Control-Allow-Origin"] = origin
            response.headers["Vary"] = "Origin"
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


@app.exception_handler(AdminError)
async def admin_error_handler(request: Request, exc: AdminError):
    return _error_response(
        request,
        status_code=exc.status_code,
        code=exc.code,
        message=SAFE_ADMIN_MESSAGES.get(
            exc.code, "The request could not be completed."
        ),
    )


@app.exception_handler(AccountAccessError)
async def account_access_error_handler(request: Request, exc: AccountAccessError):
    messages = {
        "ACCOUNT_BANNED": "This account is unavailable. Please contact Pinkeva support.",
        "ACCOUNT_ACCESS_UNAVAILABLE": "Account access is temporarily unavailable. Please try again.",
    }
    return _error_response(
        request,
        status_code=exc.status_code,
        code=exc.code,
        message=messages.get(exc.code, "The request could not be completed."),
    )


@app.exception_handler(LocationError)
async def location_error_handler(request: Request, exc: LocationError):
    return _error_response(
        request,
        status_code=exc.status_code,
        code=exc.code,
        message=SAFE_LOCATION_MESSAGES.get(
            exc.code, "Location reports are temporarily unavailable. Please try again."
        ),
    )


@app.exception_handler(FirmwareError)
async def firmware_error_handler(request: Request, exc: FirmwareError):
    return _error_response(
        request,
        status_code=exc.status_code,
        code=exc.code,
        message=SAFE_FIRMWARE_MESSAGES.get(
            exc.code, "The firmware request could not be completed."
        ),
    )


@app.exception_handler(NotificationError)
async def notification_error_handler(request: Request, exc: NotificationError):
    return _error_response(
        request,
        status_code=exc.status_code,
        code=exc.code,
        message=(
            "The notification could not be found."
            if exc.code == "NOTIFICATION_NOT_FOUND"
            else "The notification request could not be completed."
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


@app.post(
    "/v1/devices/{device_id}/location/report",
    response_model=DeviceLocationReportResponse,
)
async def request_device_location_report(
    device_id: UUID,
    request: Request,
    principal: AuthenticatedPrincipal,
) -> DeviceLocationReportResponse:
    """Request one fresh report and return only the safe location projection."""

    request_id = getattr(request.state, "request_id", "unknown")
    logger.info(
        "location_report_request_received request_id=%s user_id=%s device_id=%s",
        request_id,
        principal.user_id,
        device_id,
    )
    try:
        result = await app.state.location.request_report(
            app.state.database,
            user_id=principal.user_id,
            device_id=device_id,
        )
    except LocationError as exc:
        logger.warning(
            "location_report_request_rejected request_id=%s user_id=%s device_id=%s code=%s status=%s",
            request_id,
            principal.user_id,
            device_id,
            exc.code,
            exc.status_code,
        )
        raise
    logger.info(
        "location_report_request_completed request_id=%s user_id=%s device_id=%s report_status=%s",
        request_id,
        principal.user_id,
        device_id,
        result.report_status,
    )
    return result


@app.post(
    "/v1/devices/{device_id}/location/report_24h",
    response_model=DeviceLocationHistoryResponse,
)
async def request_device_location_history_24h(
    device_id: UUID,
    request: Request,
    principal: AuthenticatedPrincipal,
) -> DeviceLocationHistoryResponse:
    """Return only the authenticated owner's decrypted reports from the last 24 hours."""

    request_id = getattr(request.state, "request_id", "unknown")
    logger.info(
        "location_history_24h_request_received request_id=%s user_id=%s device_id=%s",
        request_id,
        principal.user_id,
        device_id,
    )
    try:
        result = await app.state.location.request_report_history_24h(
            app.state.database,
            user_id=principal.user_id,
            device_id=device_id,
        )
    except LocationError as exc:
        logger.warning(
            "location_history_24h_request_rejected request_id=%s user_id=%s device_id=%s code=%s status=%s",
            request_id,
            principal.user_id,
            device_id,
            exc.code,
            exc.status_code,
        )
        raise
    logger.info(
        "location_history_24h_request_completed request_id=%s user_id=%s device_id=%s location_count=%s",
        request_id,
        principal.user_id,
        device_id,
        len(result.locations),
    )
    return result


@app.post(
    "/v1/provisioning/requests",
    response_model=DeviceProvisioningRequestResponse,
    status_code=201,
)
async def start_provisioning_request(
    request: DeviceProvisioningRequestStart,
    principal: AuthenticatedPrincipal,
    idempotency_key: Annotated[str, Depends(idempotency_header)],
) -> DeviceProvisioningRequestResponse:
    async with app.state.database.transaction() as connection:
        created = await app.state.service.start_provisioning_request(
            connection,
            user_id=principal.user_id,
            idempotency_key=idempotency_key,
            request=request,
        )
    # The request creation transaction deliberately does not contact Stripe.
    # Fetch the current, server-validated plan catalog only after the request
    # has been committed so the request ID can be safely shown to the user.
    return await app.state.billing.get_provisioning_request(
        app.state.database,
        user_id=principal.user_id,
        request_id=created.request_id,
    )


@app.get(
    "/v1/provisioning/requests/{request_id}",
    response_model=DeviceProvisioningRequestResponse,
)
async def provisioning_request_status(
    request_id: UUID,
    principal: AuthenticatedPrincipal,
) -> DeviceProvisioningRequestResponse:
    return await app.state.billing.get_provisioning_request(
        app.state.database,
        user_id=principal.user_id,
        request_id=request_id,
        include_plans=False,
    )


@app.post(
    "/v1/provisioning/requests/{request_id}/checkout",
    response_model=ProvisioningRequestCheckoutResponse,
    status_code=201,
)
async def provisioning_request_checkout(
    request_id: UUID,
    request: ProvisioningRequestCheckout,
    principal: AuthenticatedPrincipal,
) -> ProvisioningRequestCheckoutResponse:
    return await app.state.billing.create_provisioning_checkout(
        app.state.database,
        user_id=principal.user_id,
        request_id=request_id,
        plan_code=request.plan_code,
    )


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
    "/v1/devices/{device_id}/entitlements",
    response_model=DeviceEntitlementResponse,
    status_code=201,
)
async def issue_device_entitlement(
    device_id: UUID,
    request: DeviceEntitlementRequest,
    principal: AuthenticatedPrincipal,
) -> DeviceEntitlementResponse:
    async with app.state.database.transaction() as connection:
        return await app.state.entitlement.issue(
            connection,
            user_id=principal.user_id,
            device_id=device_id,
            request=request,
        )


@app.post(
    "/v1/devices/{device_id}/entitlements/acknowledge",
    response_model=DeviceEntitlementAcknowledgeResponse,
)
async def acknowledge_device_entitlement(
    device_id: UUID,
    request: DeviceEntitlementAcknowledge,
    principal: AuthenticatedPrincipal,
) -> DeviceEntitlementAcknowledgeResponse:
    async with app.state.database.transaction() as connection:
        return await app.state.entitlement.acknowledge(
            connection,
            user_id=principal.user_id,
            device_id=device_id,
            request=request,
        )


@app.get(
    "/v1/devices/{device_id}/firmware",
    response_model=FirmwareAvailabilityResponse,
)
async def firmware_availability(
    device_id: UUID,
    principal: AuthenticatedPrincipal,
) -> FirmwareAvailabilityResponse:
    async with app.state.database.transaction() as connection:
        return await app.state.firmware.availability(
            connection,
            user_id=principal.user_id,
            device_id=device_id,
        )


@app.post(
    "/v1/devices/{device_id}/firmware/session",
    response_model=FirmwareUpdateSessionResponse,
    status_code=201,
)
async def start_firmware_update(
    device_id: UUID,
    request: FirmwareUpdateSessionRequest,
    principal: AuthenticatedPrincipal,
) -> FirmwareUpdateSessionResponse:
    async with app.state.database.transaction() as connection:
        return await app.state.firmware.issue_session(
            connection,
            user_id=principal.user_id,
            device_id=device_id,
            request=request,
        )


@app.get(
    "/v1/devices/{device_id}/firmware/image",
    response_model=None,
)
async def download_firmware_image(
    device_id: UUID,
    principal: AuthenticatedPrincipal,
    version: Annotated[str, Query(min_length=5, max_length=11)],
) -> Response:
    async with app.state.database.transaction() as connection:
        release = await app.state.firmware.image_for_download(
            connection,
            user_id=principal.user_id,
            device_id=device_id,
            version=version,
        )
    return Response(
        content=release.image,
        media_type="application/octet-stream",
        headers={
            "Cache-Control": "private, no-store",
            "Content-Disposition": f'attachment; filename="Pinkeva-{release.version}.bin"',
            "ETag": f'"{release.image_sha256.hex()}"',
            "X-Content-Type-Options": "nosniff",
        },
    )


@app.post(
    "/v1/devices/{device_id}/firmware/acknowledge",
    response_model=FirmwareUpdateAcknowledgeResponse,
)
async def acknowledge_firmware_update(
    device_id: UUID,
    request: FirmwareUpdateAcknowledge,
    principal: AuthenticatedPrincipal,
) -> FirmwareUpdateAcknowledgeResponse:
    async with app.state.database.transaction() as connection:
        return await app.state.firmware.acknowledge(
            connection,
            user_id=principal.user_id,
            device_id=device_id,
            request=request,
        )


@app.post(
    "/v1/notifications/push-token",
    response_model=MobilePushTokenResponse,
)
async def register_mobile_push_token(
    registration: MobilePushTokenRegistration,
    principal: AuthenticatedPrincipal,
) -> MobilePushTokenResponse:
    async with app.state.database.transaction() as connection:
        return await app.state.notifications.register_push_token(
            connection,
            user_id=principal.user_id,
            registration=registration,
        )


@app.delete(
    "/v1/notifications/push-token/{installation_id}",
    response_model=MobilePushTokenResponse,
)
async def remove_mobile_push_token(
    installation_id: UUID,
    principal: AuthenticatedPrincipal,
) -> MobilePushTokenResponse:
    async with app.state.database.transaction() as connection:
        return await app.state.notifications.remove_push_token(
            connection,
            user_id=principal.user_id,
            installation_id=installation_id,
        )


@app.get(
    "/v1/notifications",
    response_model=UserNotificationListResponse,
)
async def list_user_notifications(
    principal: AuthenticatedPrincipal,
    limit: Annotated[int, Query(ge=1, le=100)] = 25,
) -> UserNotificationListResponse:
    async with app.state.database.transaction() as connection:
        return await app.state.notifications.list_notifications(
            connection,
            user_id=principal.user_id,
            limit=limit,
        )


@app.post(
    "/v1/notifications/{notification_id}/read",
    response_model=UserNotificationReadResponse,
)
async def mark_user_notification_read(
    notification_id: UUID,
    principal: AuthenticatedPrincipal,
) -> UserNotificationReadResponse:
    async with app.state.database.transaction() as connection:
        return await app.state.notifications.mark_read(
            connection,
            user_id=principal.user_id,
            notification_id=notification_id,
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
