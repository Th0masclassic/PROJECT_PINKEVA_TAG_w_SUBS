from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
import logging
import ssl
from typing import Annotated
from uuid import UUID

import certifi
import jwt
from fastapi import Depends, HTTPException, Request, status
from fastapi.concurrency import run_in_threadpool
from jwt import PyJWKClient

from .config import Settings, get_settings


logger = logging.getLogger("pinqeva.auth")


def _safe_auth_failure_code(error: BaseException) -> str:
    """Return a non-sensitive reason for local/operational diagnostics."""
    return {
        "ExpiredSignatureError": "expired",
        "InvalidAudienceError": "audience",
        "InvalidIssuerError": "issuer",
        "InvalidSignatureError": "signature",
        "MissingRequiredClaimError": "missing_claim",
        "PyJWKClientError": "jwks",
        "PyJWKClientConnectionError": "jwks",
        "DecodeError": "malformed",
    }.get(type(error).__name__, "invalid")


@dataclass(frozen=True)
class Principal:
    user_id: UUID


@lru_cache
def _jwks_client(url: str) -> PyJWKClient:
    # The macOS Python distribution used for local development does not always
    # expose the system CA bundle to OpenSSL. Use certifi explicitly so the
    # public Supabase JWKS can be fetched and tokens can be verified reliably
    # in both local and hosted environments.
    ssl_context = ssl.create_default_context(cafile=certifi.where())
    return PyJWKClient(url, cache_jwk_set=True, lifespan=300, ssl_context=ssl_context)


def _bearer_token(request: Request) -> str:
    authorization = request.headers.get("Authorization", "")
    scheme, separator, token = authorization.partition(" ")
    if separator != " " or scheme.lower() != "bearer" or not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="A valid bearer token is required",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return token


async def authenticated_principal(
    request: Request, settings: Annotated[Settings, Depends(get_settings)]
) -> Principal:
    token = _bearer_token(request)
    try:
        signing_key = await run_in_threadpool(
            _jwks_client(settings.supabase_jwks_url).get_signing_key_from_jwt,
            token,
        )
        claims = jwt.decode(
            token,
            signing_key.key,
            algorithms=list(settings.supabase_jwt_algorithms),
            audience=settings.supabase_jwt_audience,
            issuer=settings.supabase_jwt_issuer,
            options={"require": ["exp", "iat", "sub", "aud"]},
        )
        user_id = UUID(claims["sub"])
    except (jwt.PyJWTError, ValueError, KeyError) as error:
        logger.warning(
            "supabase_auth_rejected reason=%s error_type=%s request_id=%s",
            _safe_auth_failure_code(error),
            type(error).__name__,
            getattr(request.state, "request_id", "unknown"),
        )
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="The access token is invalid or expired",
            headers={"WWW-Authenticate": "Bearer"},
        ) from None
    return Principal(user_id=user_id)


AuthenticatedPrincipal = Annotated[Principal, Depends(authenticated_principal)]
