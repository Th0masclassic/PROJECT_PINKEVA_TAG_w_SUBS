from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from datetime import UTC
import hmac
import logging
from typing import Protocol

from fastapi import Depends, FastAPI, Header, HTTPException, status

from .codec import (
    IdentityValidationError,
    decode_base64url_exact,
    validate_identity_fingerprint,
)
from .config import BridgeSettings
from .models import (
    IdentityRequest,
    RegistrationResponse,
    ReportPoint,
    ReportsRequest,
    ReportsResponse,
)
from .upstream import (
    GoogleFindMyToolsAdapter,
    RegistrationUnavailable,
    ReportUnavailable,
    UpstreamReport,
    UpstreamUnavailable,
)


logger = logging.getLogger("pinqeva.google_bridge")


class Adapter(Protocol):
    def derive_advertisement_key(self, identity_key: bytes, timestamp: int = 0) -> bytes: ...
    def ensure_registration(self, *, identity_key: bytes, serial_number: str) -> str: ...
    def fetch_reports(
        self,
        *,
        identity_key: bytes,
        lookback_hours: int,
        requested_at,
    ) -> list[UpstreamReport]: ...
    def refresh_all(self, *, force: bool = False) -> bool: ...


def create_app(
    settings: BridgeSettings,
    adapter: Adapter,
    *,
    start_background_refresh: bool = True,
) -> FastAPI:
    stop = asyncio.Event()

    async def refresh_loop() -> None:
        while not stop.is_set():
            try:
                await asyncio.to_thread(adapter.refresh_all)
            except Exception as exc:
                logger.warning(
                    "google_registration_refresh_failed error_type=%s",
                    type(exc).__name__,
                )
            try:
                await asyncio.wait_for(
                    stop.wait(), timeout=settings.refresh_interval_seconds
                )
            except TimeoutError:
                continue

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        task = (
            asyncio.create_task(refresh_loop())
            if start_background_refresh
            else None
        )
        try:
            yield
        finally:
            stop.set()
            if task is not None:
                await task

    app = FastAPI(
        title="Pinqeva Google Find Hub Bridge",
        version="1.0",
        lifespan=lifespan,
    )

    def authorize(authorization: str | None = Header(default=None)) -> None:
        expected = f"Bearer {settings.service_token}"
        if authorization is None or not hmac.compare_digest(
            authorization.encode("utf-8"), expected.encode("utf-8")
        ):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="UNAUTHORIZED",
            )

    def identity(request: IdentityRequest) -> bytes:
        try:
            identity_key = decode_base64url_exact(
                request.identity_key_base64url, 32
            )
            expected = decode_base64url_exact(
                request.advertisement_key_sha256_base64url, 32
            )
            validate_identity_fingerprint(
                identity_key,
                expected,
                adapter.derive_advertisement_key,
            )
            return identity_key
        except IdentityValidationError as exc:
            raise HTTPException(
                status_code=422,
                detail="INVALID_IDENTITY",
            ) from exc

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.post(
        "/v1/registrations",
        response_model=RegistrationResponse,
        dependencies=[Depends(authorize)],
    )
    async def registrations(request: IdentityRequest) -> RegistrationResponse:
        key = identity(request)
        try:
            result = await asyncio.to_thread(
                adapter.ensure_registration,
                identity_key=key,
                serial_number=request.serial_number,
            )
        except (RegistrationUnavailable, UpstreamUnavailable) as exc:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="GOOGLE_REGISTRATION_UNAVAILABLE",
            ) from exc
        return RegistrationResponse(status=result)

    @app.post(
        "/v1/reports",
        response_model=ReportsResponse,
        dependencies=[Depends(authorize)],
    )
    async def reports(request: ReportsRequest) -> ReportsResponse:
        key = identity(request)
        try:
            points = await asyncio.to_thread(
                adapter.fetch_reports,
                identity_key=key,
                lookback_hours=request.lookback_hours,
                requested_at=request.requested_at.astimezone(UTC),
            )
        except (ReportUnavailable, UpstreamUnavailable) as exc:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="GOOGLE_REPORTS_UNAVAILABLE",
            ) from exc
        return ReportsResponse(
            reports=[
                ReportPoint(
                    latitude=point.latitude,
                    longitude=point.longitude,
                    confidence=point.confidence,
                    status=point.status,
                    timestamp=point.timestamp,
                    source_fingerprint_base64url=(
                        point.source_fingerprint_base64url
                    ),
                )
                for point in points
            ]
        )

    return app


def build_app() -> FastAPI:
    settings = BridgeSettings.from_environment()
    adapter = GoogleFindMyToolsAdapter(
        settings.upstream_directory,
        report_timeout_seconds=settings.report_timeout_seconds,
        refresh_interval_seconds=settings.refresh_interval_seconds,
    )
    return create_app(settings, adapter)
