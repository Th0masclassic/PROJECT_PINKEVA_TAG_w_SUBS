from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Annotated, AsyncIterator
from uuid import UUID

from fastapi import Depends, FastAPI, Header, HTTPException

from .auth import AuthenticatedPrincipal
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
    validate_idempotency_key,
)
from .service import ProvisioningError, ProvisioningService


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    database = Database(settings)
    await database.open()
    app.state.database = database
    app.state.service = ProvisioningService(settings)
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


def idempotency_header(
    idempotency_key: Annotated[str, Header(alias="Idempotency-Key")],
) -> str:
    try:
        return validate_idempotency_key(idempotency_key)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from None


@app.exception_handler(ProvisioningError)
async def provisioning_error_handler(_, exc: ProvisioningError):
    from fastapi.responses import JSONResponse

    return JSONResponse(
        status_code=exc.status_code,
        content={"error": {"code": exc.code, "message": exc.message}},
    )


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
